import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

import { SheetPreviewResponse } from '../../models/sheet-preview.model';
import { ThreadAttachment, ThreadAttachmentsResponse } from '../../models/thread-attachment.model';
import { EmailAutomationService } from '../../services/email-automation.service';

/**
 * Attachments popup — the files the ingestion pipeline saved for one thread,
 * from {AttachmentsFolderPath}\{Thread ID}\ on the server.
 *
 * Opened from the Thread Details header, next to "Open Email". Loads on open
 * rather than with the thread: most threads are read without anyone needing the
 * attachments, so listing a folder for every selection would be work done for
 * nothing.
 */
@Component({
  selector: 'app-thread-attachments',
  standalone: false,
  templateUrl: './thread-attachments.html',
  styleUrl: './thread-attachments.scss',
})
export class ThreadAttachments implements OnChanges {
  /** Thread whose folder to list. The popup shows while this is set. */
  @Input() threadId: string | null = null;

  @Output() closed = new EventEmitter<void>();

  files: ThreadAttachment[] = [];
  isLoading = false;
  errorMessage = '';

  /** False when the thread has no folder — a normal outcome, not an error. */
  folderExists = false;

  /**
   * Listings already fetched this session, by thread id.
   *
   * The folder read can take a second or two on this drive, and reviewers open
   * the same thread's attachments repeatedly while working it. Re-opening is
   * served from here; the refresh button re-reads when the pipeline has since
   * saved something new.
   */
  private readonly cache = new Map<string, ThreadAttachmentsResponse>();

  constructor(
    private readonly api: EmailAutomationService,
    private readonly sanitizer: DomSanitizer,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['threadId'] && this.threadId) {
      this.load(this.threadId, false);
    }
  }

  /** Re-reads the folder, ignoring what was cached from an earlier open. */
  onRefresh(): void {
    if (this.threadId && !this.isLoading) {
      this.load(this.threadId, true);
    }
  }

  onClose(): void {
    this.closed.emit();
  }

  /**
   * The file being previewed, or null before a listing has arrived.
   *
   * The popup reads as one thing — a strip of files and the one you are looking
   * at — rather than as a launcher that throws documents into browser tabs the
   * reviewer then has to find their way back from.
   */
  selected: ThreadAttachment | null = null;

  /** Shows the file in the pane below the strip. */
  select(file: ThreadAttachment): void {
    this.selected = file;
    // A zoom belongs to the image it was set on, not to the pane.
    this.imageZoom = 1;

    if (this.isSheet(file)) {
      this.loadSheet(file, '');
    } else {
      this.sheet = null;
      this.sheetError = '';
    }
  }

  // ── Image zoom ────────────────────────────────────────────────

  /**
   * How far the image is scaled, 1 being the size it is fitted to the pane at.
   *
   * Images only. A PDF renders in the browser's own viewer inside an iframe on
   * another origin, so the wheel never reaches this page and there is nothing to
   * hook — that one keeps the browser's own Ctrl+wheel. An <img> is ours, so a
   * plain wheel over it can zoom, which is what these photos of receipts need:
   * they are read at arm's length from a phone camera.
   */
  imageZoom = 1;

  private static readonly ZoomMin = 0.5;
  private static readonly ZoomMax = 5;
  private static readonly ZoomStep = 0.2;

  /**
   * Wheel over the image: zoom, without asking for Ctrl.
   *
   * preventDefault stops the pane scrolling at the same time — the gesture is
   * one thing or the other. Scrolling a zoomed-in image is still possible by
   * dragging its scrollbars.
   */
  onImageWheel(event: WheelEvent): void {
    event.preventDefault();

    const next =
      this.imageZoom + (event.deltaY < 0 ? ThreadAttachments.ZoomStep : -ThreadAttachments.ZoomStep);

    const clamped = Math.min(ThreadAttachments.ZoomMax, Math.max(ThreadAttachments.ZoomMin, next));

    // Rounded, so repeated steps land on whole tenths rather than 1.0000000002.
    this.imageZoom = Math.round(clamped * 100) / 100;
    this.cdr.markForCheck();
  }

  // ── Spreadsheets ──────────────────────────────────────────────

  /**
   * The selected workbook read as rows, or null when the file is not one — or
   * has not arrived yet.
   */
  sheet: SheetPreviewResponse | null = null;
  isSheetLoading = false;
  sheetError = '';

  /**
   * A file the server can read as a sheet.
   *
   * .xls is deliberately not on the list: it is the old binary format, which the
   * Open XML SDK cannot open. The pane says so rather than spinning.
   */
  isSheet(file: ThreadAttachment | null): boolean {
    const extension = (file?.extension || '').toLowerCase();

    return extension === 'csv' || extension === 'xlsx' || extension === 'xlsm';
  }

  /** Switches sheets within the open workbook. */
  selectSheet(name: string): void {
    if (this.selected && name !== this.sheet?.sheetName) {
      this.loadSheet(this.selected, name);
    }
  }

  /** The header row, drawn as one — a sheet's first row nearly always is. */
  get sheetHeader(): string[] {
    return this.sheet?.rows[0] || [];
  }

  get sheetBody(): string[][] {
    return this.sheet ? this.sheet.rows.slice(1) : [];
  }

  private loadSheet(file: ThreadAttachment, sheetName: string): void {
    if (!this.threadId) {
      return;
    }

    this.isSheetLoading = true;
    this.sheetError = '';
    this.sheet = null;
    this.cdr.markForCheck();

    this.api.getSheetPreview(this.threadId, file.fileName, sheetName).subscribe({
      next: (response) => {
        // The reviewer may have clicked another file while this was in flight.
        if (this.selected?.fileName === file.fileName) {
          this.sheet = response;
        }

        this.isSheetLoading = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        this.isSheetLoading = false;
        this.sheetError =
          error?.error?.message || error?.message || 'This file could not be read as a sheet.';
        this.cdr.markForCheck();
      },
    });
  }

  isSelected(file: ThreadAttachment): boolean {
    return this.selected?.fileName === file.fileName;
  }

  /** The file itself — what the preview pane loads. */
  urlFor(file: ThreadAttachment): string {
    return this.threadId ? this.api.attachmentUrl(this.threadId, file.fileName) : '';
  }

  /**
   * The selected file's URL, as an <iframe> will accept it.
   *
   * Angular blocks a bound frame src outright unless it is marked trusted; this
   * one is built by attachmentUrl() from the configured API base and the file
   * name the server itself listed, so there is nothing user-supplied in it.
   * Cached per file — re-sanitising on every change-detection pass would hand
   * the frame a new value each time and reload the document under the reviewer.
   */
  previewUrl(): SafeResourceUrl | null {
    const file = this.selected;

    if (!file) {
      return null;
    }

    const cached = this.trustedUrls.get(file.fileName);

    if (cached) {
      return cached;
    }

    const trusted = this.sanitizer.bypassSecurityTrustResourceUrl(this.urlFor(file));
    this.trustedUrls.set(file.fileName, trusted);

    return trusted;
  }

  /** True for the types the browser renders in place: images, PDFs, plain text. */
  canPreview(file: ThreadAttachment | null): boolean {
    if (!file) {
      return false;
    }

    const extension = (file.extension || '').toLowerCase();

    return file.isImage || extension === 'pdf' || extension === 'txt';
  }

  /** True for anything the pane can show, one way or the other. */
  isViewable(file: ThreadAttachment | null): boolean {
    return this.canPreview(file) || this.isSheet(file);
  }

  private readonly trustedUrls = new Map<string, SafeResourceUrl>();

  /**
   * The tile preview: a resized copy from the server, not the original.
   *
   * The pipeline saves phone photos of receipts that run to several megabytes,
   * and a grid of them drawn at 116px was pulling all of that down before
   * anything appeared.
   */
  thumbUrlFor(file: ThreadAttachment): string {
    return this.threadId ? this.api.attachmentUrl(this.threadId, file.fileName, true) : '';
  }

  /** '147 KB', '1.4 MB' — sizes as the folder listing shows them. */
  readableSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    const kb = bytes / 1024;

    return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  }

  /** Short type tag on the file row, e.g. 'PDF'. */
  typeLabel(file: ThreadAttachment): string {
    return (file.extension || 'file').toUpperCase();
  }

  /**
   * Colour family for the file's type chip — pdf red, sheet green, doc blue.
   * Scanning a folder of near-identical file names is much faster by colour than
   * by reading each extension.
   */
  typeClass(file: ThreadAttachment): string {
    const extension = (file.extension || '').toLowerCase();

    if (extension === 'pdf') return 'type-pdf';
    if (extension === 'xls' || extension === 'xlsx' || extension === 'csv') return 'type-sheet';
    if (extension === 'doc' || extension === 'docx') return 'type-doc';
    if (extension === 'txt' || extension === 'htm' || extension === 'html') return 'type-text';

    return 'type-other';
  }

  /**
   * Hover text for a tile.
   *
   * The tiles show the file name only, the way a folder listing does, so size and
   * date live here rather than crowding every tile with two more lines.
   */
  tooltipFor(file: ThreadAttachment): string {
    return `${file.fileName}\n${this.readableSize(file.sizeBytes)}`;
  }

  /** Footer summary, e.g. '4 files · 798 KB'. */
  totalSize(): string {
    return this.readableSize(this.files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0));
  }

  private load(threadId: string, force: boolean): void {
    this.errorMessage = '';

    const cached = force ? undefined : this.cache.get(threadId);

    if (cached) {
      this.apply(cached);
      this.isLoading = false;
      return;
    }

    this.isLoading = true;
    this.files = [];
    this.folderExists = false;

    this.api.getThreadAttachments(threadId).subscribe({
      next: (response) => {
        this.cache.set(threadId, response);
        this.apply(response);
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        this.isLoading = false;
        this.errorMessage =
          error?.error?.message || error?.message || 'The attachments could not be listed.';
        this.cdr.markForCheck();
      },
    });
  }

  private apply(response: ThreadAttachmentsResponse): void {
    this.files = response.files || [];
    this.folderExists = response.folderExists;

    // Open on the first file rather than on an empty pane: with one attachment —
    // the common case — that is the whole interaction already done.
    if (this.files.length) {
      this.select(this.files[0]);
    } else {
      this.selected = null;
      this.sheet = null;
    }
  }
}
