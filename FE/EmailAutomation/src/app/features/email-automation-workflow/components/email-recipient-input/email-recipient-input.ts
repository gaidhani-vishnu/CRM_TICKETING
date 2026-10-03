import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
} from '@angular/core';

/**
 * One address row of a compose — To, Cc or Bcc — as removable pills rather than
 * a comma-separated string.
 *
 * Its own component because the alert compose needs three of them and they have
 * to behave identically: what counts as "finished typing an address", what a
 * pasted list splits on, what Backspace does on an empty box. Written once here,
 * those answers cannot drift between the three rows.
 *
 * The value is a string[] of addresses and binds two ways —
 * [(recipients)]="draft.to" — so the caller keeps holding a plain list and never
 * has to parse or join anything.
 */
@Component({
  selector: 'app-email-recipient-input',
  standalone: false,
  templateUrl: './email-recipient-input.html',
  styleUrl: './email-recipient-input.scss',
})
export class EmailRecipientInput {
  @Input() recipients: string[] = [];
  @Output() recipientsChange = new EventEmitter<string[]>();

  @Input() placeholder = '';

  /** Ties the row's label to the box for screen readers and label clicks. */
  @Input() inputId = '';

  /**
   * Shows the addresses but lets nobody change them: no typing, no pasting,
   * no × on the pills. The To row is set this way because the client wants
   * it fixed to the thread's Customer Sender, not an address the reviewer types.
   */
  @Input() readonly = false;

  @ViewChild('textBox') private textBox?: ElementRef<HTMLInputElement>;

  /** What is being typed but not yet committed to a pill. */
  text = '';

  /**
   * Anything that reads as "I have finished this address".
   *
   * Tab is in here deliberately: leaving the row by keyboard should commit what
   * was typed rather than lose it, and the blur handler alone fires too late to
   * stop the browser moving on first.
   */
  onKeyDown(event: KeyboardEvent): void {
    if (this.readonly) {
      return;
    }

    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === 'Tab') {
      // A bare Tab in an empty box is still just Tab — let it move focus on.
      if (event.key === 'Tab' && !this.text.trim()) {
        return;
      }

      event.preventDefault();
      this.commit(this.text);
      return;
    }

    // Backspace at the very start walks back into the pills, the way every mail
    // client does — one press removes the last one rather than the whole row.
    if (event.key === 'Backspace' && !this.text && this.recipients.length > 0) {
      event.preventDefault();
      this.removeAt(this.recipients.length - 1);
    }
  }

  /**
   * Commits on the way out, so an address left typed in the box is still sent.
   *
   * Without this the reviewer types one address, clicks Send, and it goes with
   * no recipient at all — the box looked full and the list was empty.
   */
  onBlur(): void {
    if (!this.readonly && this.text.trim()) {
      this.commit(this.text);
    }
  }

  /** A pasted list becomes pills in one go rather than one long pill. */
  onPaste(event: ClipboardEvent): void {
    if (this.readonly) {
      event.preventDefault();
      return;
    }

    const pasted = event.clipboardData?.getData('text') ?? '';

    if (!pasted) {
      return;
    }

    event.preventDefault();
    this.commit(pasted);
  }

  /** Clicking the empty space of the row puts the caret in the box. */
  onRowClick(event: MouseEvent): void {
    if (this.readonly) {
      return;
    }

    // Not when the click was the × of a pill — that button has already acted.
    if ((event.target as HTMLElement).closest('.recipient-pill-remove')) {
      return;
    }

    this.textBox?.nativeElement.focus();
  }

  removeAt(index: number): void {
    if (this.readonly) {
      return;
    }

    const next = this.recipients.slice();
    next.splice(index, 1);

    this.recipients = next;
    this.recipientsChange.emit(next);
  }

  /**
   * Whether an address looks sendable. Only used to mark a pill, never to
   * refuse one: a reviewer who pastes something odd should see which pill is
   * wrong and fix it, not have it silently dropped.
   */
  isValid(address: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  }

  /** Turns typed or pasted text into pills. */
  private commit(raw: string): void {
    const parsed = this.parseAddresses(raw);

    this.text = '';

    if (parsed.length === 0) {
      return;
    }

    const next = this.recipients.slice();

    for (const address of parsed) {
      // Case-insensitively, since a mailbox is — the same address twice in a
      // row's pills is a mistake the reviewer would have to spot themselves.
      const isDuplicate = next.some((a) => a.toLowerCase() === address.toLowerCase());

      if (!isDuplicate) {
        next.push(address);
      }
    }

    // Nothing survived the duplicate check, so nothing changed. Emitting an
    // identical list would tell the caller the reply's recipients had been
    // edited when they had not.
    if (next.length === this.recipients.length) {
      return;
    }

    this.recipients = next;
    this.recipientsChange.emit(next);
  }

  /**
   * Pulls the addresses out of typed or pasted text.
   *
   * Split into entries on comma, semicolon and newline only — never on a bare
   * space — because a contact copied out of a mail client arrives as
   * "Prathhmesh Palkar <p.palkar@example.com>" and the display name in front
   * is full of the spaces a whitespace split would break it apart on.
   *
   * Within an entry, a bracketed address wins and the name in front of it is
   * dropped. An entry with no brackets is plain addresses, so there whitespace
   * *is* a separator — which is what makes a column pasted out of a
   * spreadsheet come through as one pill per row.
   */
  private parseAddresses(raw: string): string[] {
    const addresses: string[] = [];

    for (const entry of raw.split(/[,;\n\r]+/)) {
      const bracketed = entry.match(/<([^>]+)>/);

      if (bracketed) {
        const address = bracketed[1].trim();

        if (address) {
          addresses.push(address);
        }

        continue;
      }

      for (const part of entry.split(/\s+/)) {
        const trimmed = part.trim();

        if (trimmed) {
          addresses.push(trimmed);
        }
      }
    }

    return addresses;
  }
}
