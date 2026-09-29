import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';

import { EmailReceiptRow } from '../../models/email-receipt.model';
import { AlertReplyDraft, EmailResponseTemplate } from '../../models/email-response.model';
import { ThreadReply, ThreadReplyAttachment } from '../../models/thread-reply.model';
import { ThreadHistoryEntry, ThreadMessage } from '../../models/thread-message.model';
import { EmailAutomationService } from '../../services/email-automation.service';
import { EmailResponseTemplateService } from '../../services/email-response-template.service';

/**
 * Opened from the bell badge beside a row's Ticket ID (main_email_receipts.
 * [Alert Received] = true), the same way <app-thread-attachments> opens from
 * the header's Attachments button — over part 1, not Thread Details, so the
 * thread it belongs to stays visible behind it.
 *
 * Shows the thread as one conversation, oldest first: every mail that came in
 * (main_email_messages) and every reply the CRM saved (PRIDE_EMAIL_REPLY),
 * interleaved by [Received Time] and Created_On. Under it, Respond opens the
 * compose the next reply is written in.
 *
 * That compose is where a pipeline step's Email Response lands too. It used to
 * open a popup of its own, which put the drafted reply somewhere the thread it
 * answers could not be read: the customer's mail, their latest reply and every
 * answer already sent are all here, and they are exactly what a reviewer needs
 * in front of them while deciding whether the draft says the right thing. So the
 * template arrives as `draftedReply` and fills this compose in, rather than
 * opening a second window over the first.
 */
@Component({
  selector: 'app-alert-popup',
  standalone: false,
  templateUrl: './alert-popup.html',
  styleUrl: './alert-popup.scss',
})
export class AlertPopup implements OnChanges {
  /** The row the alert belongs to. Nothing shows while this is null. */
  @Input() row: EmailReceiptRow | null = null;

  /**
   * A reply drafted by the pipeline's Email Response button, or null when the
   * popup was opened from the bell with nothing to write in it yet.
   *
   * Every arrival opens the compose over whatever was in it, because the click
   * that sent it was a reviewer asking for this draft. The caller sends a fresh
   * object each time, so clicking Email Response twice re-drafts — the same as
   * re-opening the old popup did.
   */
  @Input() draftedReply: EmailResponseTemplate | null = null;

  @Output() closed = new EventEmitter<void>();

  /** Fired once a reply has been saved, carrying the toast text for the parent. */
  @Output() saved = new EventEmitter<string>();

  /**
   * The reviewer answered "Close this ticket?" on a drafted reply — true for
   * yes. Fired only once the reply has actually been saved, so the ticket and
   * the mail the customer reads change together: clicking Yes rewrites the line
   * of the body that says which way it went, and nothing else, until Send.
   * Discarding the compose therefore leaves the ticket exactly as it was.
   */
  @Output() ticketCloseChoice = new EventEmitter<boolean>();

  /** The scrolling part of the popup — everything under the header. */
  @ViewChild('popupBody') private popupBody?: ElementRef<HTMLElement>;

  /** The compose, present only once Respond has been clicked. */
  @ViewChild('composeSection') private composeSection?: ElementRef<HTMLElement>;

  /**
   * Caps on what one reply may carry. Mirrors the server's own — see
   * ReplyMaxFileBytes and friends in EmailAutomationController — so the
   * reviewer is told before a 25 MB upload rather than after it.
   */
  private static readonly MaxFileBytes = 10 * 1024 * 1024;
  private static readonly MaxTotalBytes = 25 * 1024 * 1024;
  private static readonly MaxFileCount = 10;

  /**
   * The reply being written, or null while the reviewer has not asked to write
   * one. Held here rather than opened as a second popup: the customer's words
   * are the thing being answered, so they stay on screen above the answer.
   */
  compose: AlertReplyDraft | null = null;

  /**
   * The template the open compose was drafted from, or null when the reviewer
   * opened it with Respond and is writing their own.
   *
   * Kept whole rather than folded into the draft because of the two ticket-status
   * lines: answering "Close this ticket?" swaps one sentence of the body for the
   * other, and the swap is a plain string replace — the sentence the code looks
   * for has to be the sentence the reviewer is reading.
   *
   * It is also what the compose keys its extra rows off: From, Subject and the
   * ticket question belong to a drafted reply and to nothing else.
   */
  composeTemplate: EmailResponseTemplate | null = null;

  /** Which way "Close this ticket?" was answered, or null while it is open. */
  ticketChoice: 'yes' | 'no' | null = null;

  /**
   * Set when Send was pressed with the question still unanswered, so the row
   * can mark itself. Cleared the moment either answer is given — it marks the
   * one thing standing between the reviewer and sending, not a lasting state.
   */
  needsTicketChoice = false;

  /**
   * Whether the Cc / Bcc rows are on screen. Both start closed: most replies
   * copy nobody, and two empty rows between the recipient and the message is
   * two rows of nothing to read past.
   *
   * Toggled, not one-way — but closing a row never clears it, and the toggle
   * carries the count of what it is holding (see ccCount / bccCount) so a
   * collapsed row can never quietly put an address on the reply.
   */
  showCc = false;
  showBcc = false;

  /** Replies already saved on this thread, oldest first. */
  replies: ThreadReply[] = [];
  isLoadingReplies = false;
  repliesError = '';

  /** Mail that came in on this thread, from main_email_messages, oldest first. */
  messages: ThreadMessage[] = [];
  isLoadingMessages = false;
  messagesError = '';

  /**
   * The conversation as the popup shows it: messages and replies in one list,
   * ordered by when each happened. Rebuilt whenever either side changes.
   */
  history: ThreadHistoryEntry[] = [];

  /** Set while the save is in flight, and cleared either way. */
  isSaving = false;

  /** What went wrong with the last save or file pick, shown against the compose. */
  composeError = '';

  constructor(
    private readonly templates: EmailResponseTemplateService,
    private readonly api: EmailAutomationService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  /** Either half of the conversation is still on its way. */
  get isLoadingHistory(): boolean {
    return this.isLoadingMessages || this.isLoadingReplies;
  }

  /**
   * Whether Respond is on screen, under the last entry of the conversation.
   *
   * Held back while the history loads, so it does not appear at the top and
   * then jump down as the list lands, and while the compose is already open.
   */
  get canRespond(): boolean {
    return !this.compose && !this.isLoadingHistory;
  }

  get ccCount(): number {
    return this.compose?.cc.length ?? 0;
  }

  get bccCount(): number {
    return this.compose?.bcc.length ?? 0;
  }

  ngOnChanges(changes: SimpleChanges): void {
    // The row first and the draft after, in that order: opening the popup from
    // Email Response changes both in one pass, and the row's reset would
    // otherwise throw away the very draft that opened it.
    if (changes['row']) {
      this.onRowChanged();
    }

    if (changes['draftedReply'] && this.draftedReply) {
      this.openDraftedReply(this.draftedReply);
    }
  }

  private onRowChanged(): void {
    // A compose belongs to the thread it was opened on. Re-opening the popup on
    // another row must not hand the reviewer half a reply addressed to someone
    // else, so it is dropped whenever the row changes.
    this.discardCompose();
    this.replies = [];
    this.repliesError = '';
    this.messages = [];
    this.messagesError = '';
    this.history = [];
    this.preview = null;
    this.downloadError = '';

    if (!this.row) {
      return;
    }

    // Loaded here rather than when the row is selected: the popup opens for a
    // minority of threads, and the ones it never opens for should not pay for a
    // read. Same call <app-thread-attachments> makes.
    //
    // Messages by the email's thread, replies by the row's. A loan row is one
    // customer of a shared email: the mail came in on the email's thread, and
    // the reply is saved against the customer's own row, which is what the
    // compose files it under.
    this.loadMessages(this.row.parentThreadId || this.row.threadId);
    this.loadReplies(this.row.threadId);
  }

  private loadMessages(threadId: string): void {
    this.isLoadingMessages = true;
    this.messagesError = '';

    this.api.getThreadMessages(threadId).subscribe({
      next: (response) => {
        this.messages = response.messages || [];
        this.isLoadingMessages = false;
        this.onHistoryPartLoaded();
      },
      error: () => {
        this.messages = [];
        this.isLoadingMessages = false;
        this.messagesError = 'Could not load the messages received on this thread.';
        this.onHistoryPartLoaded();
      },
    });
  }

  private loadReplies(threadId: string): void {
    this.isLoadingReplies = true;
    this.repliesError = '';

    this.api.getThreadReplies(threadId).subscribe({
      next: (response) => {
        this.replies = response.replies || [];
        this.isLoadingReplies = false;
        this.onHistoryPartLoaded();
      },
      error: () => {
        this.replies = [];
        this.isLoadingReplies = false;
        this.repliesError = 'Could not load the replies saved on this thread.';
        this.onHistoryPartLoaded();
      },
    });
  }

  private onHistoryPartLoaded(): void {
    this.rebuildHistory();
    this.cdr.markForCheck();

    // Only once both halves are in: the history is what makes the popup taller
    // than its window, so scrolling before it lands would put the reviewer at
    // the bottom of a page that has not grown yet.
    if (!this.isLoadingHistory) {
      this.scrollToBottom();
    }
  }

  /**
   * Interleaves the two halves of the conversation by time.
   *
   * Both come from the server as ISO-8601 in the same local shape, so they
   * compare directly. An entry whose time will not parse goes after the ones
   * that did, and equal times keep messages ahead of replies, since a reply
   * answers a message and cannot come before it.
   *
   * A thread with no rows in main_email_messages (one ingested before the
   * table existed) still opens on the customer's mail: the row's own
   * [Email Body] stands in as the first message, so the popup never shows a
   * reply to nothing.
   */
  private rebuildHistory(): void {
    const messages =
      this.messages.length === 0 && !this.isLoadingMessages && !this.messagesError && this.row
        ? [this.fallbackMessage(this.row)]
        : this.messages;

    const entries: ThreadHistoryEntry[] = [
      ...messages.map((message) => ({ kind: 'received' as const, at: message.receivedTime, message })),
      ...this.replies.map((reply) => ({ kind: 'sent' as const, at: reply.createdOn, reply })),
    ];

    const timeOf = (entry: ThreadHistoryEntry): number => {
      const time = new Date(entry.at).getTime();

      return entry.at && !Number.isNaN(time) ? time : Number.POSITIVE_INFINITY;
    };

    this.history = entries
      .map((entry, index) => ({ entry, index, time: timeOf(entry) }))
      .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time))
      .map((item) => item.entry);
  }

  /**
   * The row's own [Email Body], shaped as a message, for a thread that has none
   * in main_email_messages. It is stamped with the earliest possible time so
   * it sorts ahead of every reply, and the template hides that stamp.
   */
  private fallbackMessage(row: EmailReceiptRow): ThreadMessage {
    return {
      messageKey: '',
      threadId: row.threadId,
      // The earliest time there is, so it sorts to the top.
      receivedTime: new Date(0).toISOString(),
      subject: row.emailSubject || '',
      messageText: row.emailBody || 'No email body content available for this receipt.',
    };
  }

  /** Whether a received entry is the stand-in built from the row, not a real message. */
  isFallbackMessage(message: ThreadMessage): boolean {
    return !message.messageKey;
  }

  /**
   * Puts the popup at the end of the thread as it opens.
   *
   * The newest response is the one worth reading first — what was last said
   * back, and whether it still needs answering — and it is the furthest down a
   * list that only grows. Opening at the top would mean scrolling past the
   * original mail and every older reply to reach it, every time.
   *
   * Jumped rather than animated: this is where the popup starts, not somewhere
   * it travels to, and smooth-scrolling a long history on open reads as the
   * page moving under the reviewer.
   */
  private scrollToBottom(): void {
    // A tick, because the replies that were just set have to be rendered before
    // the height they add can be scrolled through.
    setTimeout(() => {
      const body = this.popupBody?.nativeElement;

      if (body) {
        body.scrollTop = body.scrollHeight;
      }
    });
  }

  /**
   * Opens the compose under the reply, addressed to whoever wrote in.
   *
   * To comes from the same EmailResponseTemplateService.recipient() every
   * drafted step reply is addressed with, so a hand-written answer and a
   * templated one go to the same place and unpick "Name <a@b.com>" the same
   * way. Cc, Bcc, the body and the attachments start empty — this is the
   * reviewer's own reply, not a template with the words already chosen.
   */
  onRespond(): void {
    if (!this.row) {
      return;
    }

    const customer = this.templates.recipient(this.row);

    this.compose = {
      threadId: this.row.threadId,
      to: customer ? [customer] : [],
      cc: [],
      bcc: [],
      body: '',
      attachments: [],

      // No From box, no Subject box, and no ticket to file it against: this is
      // the reviewer's own reply, so the server derives what it needs.
      from: '',
      subject: '',
      ticketId: '',
    };

    this.composeTemplate = null;
    this.ticketChoice = null;
    this.needsTicketChoice = false;
    this.showCc = false;
    this.showBcc = false;
    this.composeError = '';

    this.scrollToCompose();
  }

  /**
   * Fills the compose from a step's template, opened by Email Response.
   *
   * The same compose the reviewer would have typed in, with the boxes already
   * written: To and From off the thread, the subject and body off the step that
   * stopped, and — where the template allows it — the "Close this ticket?"
   * question above the body.
   *
   * The attachments start empty. The template drafts words, not files, and a
   * file the reviewer did not pick is not one they meant to send.
   */
  private openDraftedReply(template: EmailResponseTemplate): void {
    this.compose = {
      threadId: template.threadId,
      to: template.to ? [template.to] : [],
      cc: [],
      bcc: [],
      body: template.body,
      attachments: [],
      from: template.from,
      subject: template.subject,
      ticketId: template.ticketId,
    };

    this.composeTemplate = template;
    this.ticketChoice = null;
    this.needsTicketChoice = false;
    this.showCc = false;
    this.showBcc = false;
    this.composeError = '';

    this.scrollToCompose();
  }

  /**
   * Answers "Close this ticket?" and rewrites the one line of the body that
   * says which way it went.
   *
   * A swap rather than a re-draft: the reviewer may already have edited the
   * mail, and re-running the template would throw that away to change one
   * sentence.
   */
  onTicketChoice(close: boolean): void {
    if (!this.compose || !this.composeTemplate) {
      return;
    }

    const from = close
      ? this.composeTemplate.ticketOpenLine
      : this.composeTemplate.ticketClosedLine;

    const to = close
      ? this.composeTemplate.ticketClosedLine
      : this.composeTemplate.ticketOpenLine;

    if (this.compose.body.indexOf(to) === -1) {
      this.compose.body = this.compose.body.indexOf(from) === -1
        ? // Both lines edited away — say it once at the end rather than sending
          // a reply that no longer states where the ticket stands.
          `${this.compose.body}\n\n${to}`
        : this.compose.body.replace(from, to);
    }

    this.ticketChoice = close ? 'yes' : 'no';

    // Answered — the block on Send, and the message explaining it, go away.
    this.needsTicketChoice = false;

    if (this.composeError.indexOf('Close this ticket?') !== -1) {
      this.composeError = '';
    }
  }

  /**
   * Brings the compose into view. A one-tick wait because *ngIf has to have
   * rendered it before it can be scrolled to.
   */
  private scrollToCompose(): void {
    setTimeout(() => {
      this.composeSection?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
      });
    });
  }

  /**
   * Throws the reply away and closes the popup with it.
   *
   * Discard is the reviewer saying they are done here, not just done with the
   * draft — leaving the panel open on the reply list behind it made them close
   * the same popup twice.
   */
  onDiscard(): void {
    this.discardCompose();
    this.onClose();
  }

  private discardCompose(): void {
    this.compose = null;
    this.composeTemplate = null;
    this.ticketChoice = null;
    this.needsTicketChoice = false;
    this.showCc = false;
    this.showBcc = false;
    this.composeError = '';
  }

  toggleCc(): void {
    this.showCc = !this.showCc;
  }

  toggleBcc(): void {
    this.showBcc = !this.showBcc;
  }

  // ── Attachments ──────────────────────────────────────────────

  /**
   * Files picked off the reviewer's machine, read into the draft.
   *
   * Read here rather than at send time so the caps are enforced against the
   * file the moment it is chosen — being told a 40 MB file is too big only
   * after writing the reply is the version of this that wastes the reviewer's
   * work.
   */
  onFilesPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files || []);

    // Cleared so picking the same file twice in a row still fires a change.
    input.value = '';

    if (!this.compose || picked.length === 0) {
      return;
    }

    this.composeError = '';

    for (const file of picked) {
      const rejection = this.rejectionFor(file);

      if (rejection) {
        this.composeError = rejection;
        this.cdr.markForCheck();
        return;
      }

      this.readFile(file);
    }
  }

  /** Why this file cannot be attached, or '' when it can. */
  private rejectionFor(file: File): string {
    if (!this.compose) {
      return '';
    }

    if (this.compose.attachments.length >= AlertPopup.MaxFileCount) {
      return `A reply may carry at most ${AlertPopup.MaxFileCount} files.`;
    }

    if (file.size === 0) {
      return `${file.name} is empty.`;
    }

    if (file.size > AlertPopup.MaxFileBytes) {
      return `${file.name} is larger than the ${AlertPopup.MaxFileBytes / (1024 * 1024)} MB limit for one file.`;
    }

    const total = this.attachedBytes() + file.size;

    if (total > AlertPopup.MaxTotalBytes) {
      return `The attachments would come to more than the ${AlertPopup.MaxTotalBytes / (1024 * 1024)} MB limit for one reply.`;
    }

    return '';
  }

  private readFile(file: File): void {
    const reader = new FileReader();

    reader.onload = () => {
      if (!this.compose) {
        return;
      }

      this.compose.attachments.push({
        fileName: file.name,
        contentBase64: String(reader.result ?? ''),
        sizeBytes: file.size,
      });

      this.cdr.markForCheck();
    };

    reader.onerror = () => {
      this.composeError = `${file.name} could not be read.`;
      this.cdr.markForCheck();
    };

    // As a data: URL rather than raw base64 — it is the encoding FileReader
    // gives without extra work, and the backend strips the prefix.
    reader.readAsDataURL(file);
  }

  removeAttachment(index: number): void {
    this.compose?.attachments.splice(index, 1);
  }

  private attachedBytes(): number {
    return (this.compose?.attachments ?? []).reduce((sum, a) => sum + a.sizeBytes, 0);
  }

  // ── Saving ───────────────────────────────────────────────────

  /**
   * Saves the reply against the thread.
   *
   * It does not send it — there is no transport — and the toast the parent
   * raises says so. On failure the compose is left exactly as it was: a typed
   * reply is the one thing here that cannot be recovered, so it is never
   * cleared on anything but success.
   */
  onSend(): void {
    if (!this.compose || this.isSaving) {
      return;
    }

    if (this.compose.to.length === 0) {
      this.composeError = 'Add at least one address to send to.';
      return;
    }

    if (!this.compose.body.trim()) {
      this.composeError = 'Write a reply before saving it.';
      return;
    }

    // The body carries one of two sentences — "your ticket is now closed" or
    // "it stays open" — and until the question is answered it carries the
    // drafted default rather than a decision. Sending then tells the customer
    // something nobody chose, so the answer is required, not optional.
    if (this.composeTemplate?.canCloseTicket && this.ticketChoice === null) {
      this.composeError = 'Answer "Close this ticket?" — Yes or No — before sending.';
      this.needsTicketChoice = true;
      this.cdr.markForCheck();
      return;
    }

    this.isSaving = true;
    this.composeError = '';

    // Read before discardCompose() clears it: the ticket is filed on the way
    // out, and the answer it is filed from has to survive the reset.
    const closeTicket = this.composeTemplate?.canCloseTicket
      ? this.ticketChoice === 'yes'
      : null;

    this.api.saveThreadReply(this.compose).subscribe({
      next: (response) => {
        this.replies = response.replies || [];
        this.rebuildHistory();
        this.discardCompose();
        this.isSaving = false;
        this.cdr.markForCheck();

        // Only now, and only because the reply went out: the mail saying the
        // ticket is closed and the ticket closing are one action, so a save
        // that failed leaves the ticket open for the reviewer to try again.
        if (closeTicket !== null) {
          this.ticketCloseChoice.emit(closeTicket);
        }

        this.saved.emit(response.message || 'Reply saved against this thread.');
        // The reply is away; the popup has nothing left to say. The message
        // above is emitted first, so the toast it raises outlives the panel.
        this.onClose();
      },
      error: (err) => {
        this.isSaving = false;
        this.composeError =
          err?.error?.message || 'The reply could not be saved. Please try again.';
        this.cdr.markForCheck();
      },
    });
  }

  onClose(): void {
    this.preview = null;
    this.closed.emit();
  }

  // ── Display helpers ──────────────────────────────────────────

  /** Download URL for one file on a saved reply. */
  attachmentUrl(reply: ThreadReply, file: ThreadReplyAttachment): string {
    return this.api.replyAttachmentUrl(reply.id, file.storedName);
  }

  // -- Image preview ---------------------------------------------

  /**
   * The image being looked at, or null when nothing is. Kept with the reply it
   * hangs off rather than the file alone, since the download URL needs both.
   *
   * Images only: a PDF or a sheet has nothing to show at this size, and the
   * browser already renders those better in a tab of their own.
   */
  preview: { reply: ThreadReply; file: ThreadReplyAttachment } | null = null;

  /** Opened by clicking an image chip. Closed by its own x, not the popup's. */
  openPreview(reply: ThreadReply, file: ThreadReplyAttachment): void {
    this.preview = { reply, file };
  }

  closePreview(): void {
    this.preview = null;
  }

  /**
   * Escape closes the image, never the popup behind it. The popup keeps its own
   * rule that only the × closes it -- an image opened over a half-written reply
   * must not be able to take the reply with it.
   */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.preview) {
      this.closePreview();
    }
  }

  /** The full-size image behind the chip that was clicked. '' when closed. */
  previewUrl(): string {
    return this.preview ? this.attachmentUrl(this.preview.reply, this.preview.file) : '';
  }

  // -- Download --------------------------------------------------

  /**
   * Files currently being fetched, keyed 'replyId:storedName' -- the same file
   * on two replies is two entries, so one spinner cannot speak for the other.
   */
  private readonly downloading = new Set<string>();

  isDownloading(reply: ThreadReply, file: ThreadReplyAttachment): boolean {
    return this.downloading.has(AlertPopup.fileKey(reply, file));
  }

  /**
   * Saves the file to the reviewer's machine rather than opening it.
   *
   * The bytes come back as a blob first: the API answers from its own origin,
   * and a cross-origin anchor has its download attribute ignored, which is what
   * put these in a new tab before. An object URL is same-origin, so the browser
   * honours both the save and the name the reviewer originally attached it as.
   */
  download(reply: ThreadReply, file: ThreadReplyAttachment): void {
    const key = AlertPopup.fileKey(reply, file);

    if (this.downloading.has(key)) {
      return;
    }

    this.downloading.add(key);
    this.downloadError = '';
    this.cdr.markForCheck();

    this.api.downloadReplyAttachment(reply.id, file.storedName).subscribe({
      next: (blob) => {
        this.saveBlob(blob, file.fileName);
        this.downloading.delete(key);
        this.cdr.markForCheck();
      },
      error: () => {
        this.downloading.delete(key);
        this.downloadError = `${file.fileName} could not be downloaded.`;
        this.cdr.markForCheck();
      },
    });
  }

  /** Shown under the history when a download fails. '' while nothing has. */
  downloadError = '';

  private static fileKey(reply: ThreadReply, file: ThreadReplyAttachment): string {
    return `${reply.id}:${file.storedName}`;
  }

  /**
   * Hands the blob to the browser under the name it was attached as.
   *
   * The object URL is revoked on the next tick rather than immediately: Firefox
   * cancels a save whose URL is released in the same frame as the click.
   */
  private saveBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    setTimeout(() => URL.revokeObjectURL(url));
  }

  /** '48 KB'. Shared by the picked files and the saved ones. */
  readableSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * 'CU' for 'CRM UI', 'RI' for 'RITA'. Two letters at most.
   *
   * A name with no spaces gives its first two characters rather than one, so
   * the avatar reads as a mark instead of a stray letter.
   */
  initialsFor(name: string): string {
    const parts = (name || 'CRM UI').trim().split(/\s+/).filter((p) => p.length > 0);

    if (parts.length === 0) {
      return '—';
    }

    if (parts.length === 1) {
      return parts[0].substring(0, 2).toUpperCase();
    }

    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** '13 May 2026, 14:32'. Falls back to the raw value on anything unparseable. */
  readableWhen(isoDate: string): string {
    const parsed = new Date(isoDate);

    if (!isoDate || Number.isNaN(parsed.getTime())) {
      return isoDate || '';
    }

    return parsed.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
