import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';

import { EmailAutomationService } from '../../services/email-automation.service';
import { EmailReceiptDetailRow } from '../../models/email-receipt-detail.model';
import { ProjectBankAccountService } from '../../../../core/services/project-bank-account.service';

/**
 * Shows main_email_receipt_details_{date}.csv rows for one Thread ID — the
 * payment/instrument breakdown for the currently selected email thread.
 * Sits below the "State of Ticket" card. Re-fetches whenever [date] or
 * [threadId] changes.
 */
@Component({
  selector: 'app-email-payment-details',
  standalone: false,
  templateUrl: './email-payment-details.html',
  styleUrl: './email-payment-details.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmailPaymentDetails implements OnChanges {
  @Input() date: string | null = null;
  @Input() threadId: string | null = null;
  /** Bumped by the parent after a pipeline step rewrote the details file. */
  @Input() refreshToken = 0;

  /**
   * The thread's Project and Sub Project, from its main_email_receipts row.
   *
   * The single source of truth for which Pride account the payments may be
   * receipted against. The payment rows carry their own copies of these two
   * columns, but they are extracted per payment and often blank or partial —
   * deliberately not read here, so every payment of a thread offers the same
   * accounts as the thread itself.
   */
  @Input() project = '';
  @Input() subProject = '';

  /**
   * True while Instrument Match / Bank Reconciliation is the step the pipeline
   * is on. The card pulses so the reviewer's eye lands on the block the current
   * step is about, the same treatment the other Thread Details cards get.
   */
  @Input() isActive = false;

  /** The step behind this card finished — draws the green check by the chevron. */
  @Input() isDone = false;

  /**
   * Which step this card belongs to.
   *
   * The same component renders both, because both read the same payment rows
   * and a second component would be a copy of this one with two pills changed.
   * What differs is what each step is about, and the card says only that:
   *
   *   • 'instrument' — every payment on the thread, its fields, whether the row
   *     is complete, and the New Entry toggle. This is where a payment is
   *     corrected and where the reviewer overrides the duplicate verdict.
   *   • 'bankreco'   — only the payments Bank Reconciliation actually processes
   *     (the new entries), with what the statement said about each. No toggle
   *     and no field pills: nothing here is corrected, it is a result.
   */
  @Input() mode: 'instrument' | 'bankreco' = 'instrument';

  get isBankRecoCard(): boolean {
    return this.mode === 'bankreco';
  }

  get cardTitle(): string {
    return this.isBankRecoCard ? 'Bank Reconciliation' : 'Payment Details';
  }

  /**
   * The payment rows as they now stand, after something on this card wrote to
   * them.
   *
   * The pipeline judges Instrument Match from these columns, and a change here
   * can undo its verdict — clearing a Pride account leaves the row short of a
   * field a receipt needs. Without telling the panel, its "Move to Bank
   * Reconciliation" button would keep offering a step the thread no longer
   * qualifies for.
   */
  @Output() rowsChanged = new EventEmitter<EmailReceiptDetailRow[]>();

  rows: EmailReceiptDetailRow[] = [];
  isLoading = false;
  errorMessage = '';
  isModalOpen = false;

  /**
   * Accordion state for the whole card.
   *
   * Pushed down by the parent, which opens it when the pipeline reaches
   * Instrument Match and shuts it again when the pipeline moves on. Clicking the
   * header still toggles it locally in between — the parent only writes when its
   * own flag changes, so a hand-collapsed card is not sprung open again.
   */
  isExpanded = false;

  @Input('expanded') set expandedInput(value: boolean) {
    this.isExpanded = value;
  }

  /**
   * The payments this card is about.
   *
   * The reconciliation card lists exactly what that step will process, and on
   * the same three conditions the backend applies:
   *
   *   [Dublicate Match] = Unmatch  — it is not already on the books,
   *   EntryStatus       = New Entry — nobody has marked it otherwise,
   *   [Instrument Match] = Match    — the row carries every field a receipt needs.
   *
   * A duplicate has no reconciliation verdict to show and never will, and an
   * incomplete row cannot be searched for; listing either would invite the
   * reviewer to wait for an answer that is not coming.
   */
  get cardRows(): EmailReceiptDetailRow[] {
    if (!this.isBankRecoCard) {
      return this.rows;
    }

    return this.rows.filter((row) => this.isNewEntry(row) && this.isRowComplete(row));
  }

  /**
   * The rows the inline card lists.
   *
   * Every one of them — the client asked for the full list in place, not a
   * top-5 preview, so the "view all" modal is no longer the only place a
   * payment past the fifth can be seen.
   */
  get displayedRows(): EmailReceiptDetailRow[] {
    return this.cardRows;
  }

  toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
    this.cdr.markForCheck();
  }

  // ── Collapsed summary ─────────────────────────────────────────

  /**
   * What the card holds, counted for the header.
   *
   * A shut card used to say only how many payments there were, which is the one
   * thing the reviewer could already guess. These are the four answers they open
   * it for: how many are already on the books, how many still have to be
   * receipted, how many a person judged themselves, and how many carry every
   * field a receipt needs.
   */
  get duplicateEntryCount(): number {
    return this.cardRows.filter(
      (row) =>
        (row.dublicateMatch || '').trim().toLowerCase() === 'match' &&
        (row.entryStatus || '').trim().toLowerCase() === 'duplicate entry'
    ).length;
  }

  get newEntryCount(): number {
    return this.cardRows.filter((row) => this.isNewEntry(row)).length;
  }

  /**
   * Everything else: a payment marked a duplicate by hand, whose EntryStatus is
   * the reason the reviewer typed rather than either of the step's own words.
   */
  get otherEntryCount(): number {
    return this.cardRows.length - this.duplicateEntryCount - this.newEntryCount;
  }

  get completeCount(): number {
    return this.cardRows.filter((row) => this.isRowComplete(row)).length;
  }

  get reconciledCount(): number {
    return this.cardRows.filter((row) => this.isBankRecoMatched(row)).length;
  }

  /**
   * How many chips the header is about to draw.
   *
   * Past two, they are shrunk: a thread with duplicates, new entries and a
   * reviewer's own verdict puts four counts beside the title, and at the size the
   * cards above use they wrap onto a second line and the card grows a row taller
   * than every other shut card in the stack.
   */
  get summaryChipCount(): number {
    if (this.isBankRecoCard) {
      return 1;
    }

    return (
      (this.duplicateEntryCount ? 1 : 0) +
      (this.newEntryCount ? 1 : 0) +
      (this.otherEntryCount ? 1 : 0) +
      1
    );
  }

  private rowKey(row: EmailReceiptDetailRow): string {
    return row.emailReceiptsDetailsId || `${this.threadKeyOf(row)}#${row.paymentNo}`;
  }

  /**
   * The thread key the backend stores THIS payment under.
   *
   * Not `row.threadId`, which is the [Thread ID] column: on a loan payment that
   * is the email the payment arrived on, shared by every customer named in it,
   * while PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS is keyed on [Customer Thread
   * ID] — the "<Thread ID>-<n>" of the one customer. Sending the parent had the
   * server's ResolveBinding find no loan row for it, fall back to the ordinary
   * main_email_receipt_details binding, and update nothing: a 404 on a payment
   * that is plainly on screen.
   *
   * Blank for every other category, whose payments are keyed on threadId alone,
   * so the fallback is the normal path rather than a special case.
   */
  private threadKeyOf(row: EmailReceiptDetailRow): string {
    return (row.customerThreadId || '').trim() || row.threadId;
  }

  /**
   * The entry toggle on a payment card: on for a new entry, off for one already
   * on the books.
   *
   * Reads [Dublicate Match] rather than any state of its own — 'Unmatch' means
   * SALES_RECEIPT does not hold the payment, which is the same thing as "this is
   * new". Only new entries go on to Bank Reconciliation, so this switch decides
   * whether the payment is reconciled at all.
   */
  isNewEntry(row: EmailReceiptDetailRow): boolean {
    // Both columns have to agree, exactly as the backend reads them: a payment
    // is only in play for Bank Reconciliation when [Dublicate Match] is
    // "Unmatch" AND EntryStatus is "New Entry". A row turned off by hand holds
    // the reviewer's reason in EntryStatus, which is not "New Entry", so it
    // drops out of the rest of the pipeline the moment they save it.
    return (
      (row.dublicateMatch || '').trim().toLowerCase() === 'unmatch' &&
      (row.entryStatus || '').trim().toLowerCase() === 'new entry'
    );
  }

  /**
   * A payment nobody may change any more — the switch and the Pride account
   * alike. Locked in two situations, and only two.
   *
   *   1. The system found the payment on a receipt — [Dublicate Match] = "Match"
   *      written by Instrument Match, i.e. EditType = "Automate". That verdict
   *      came from SALES_RECEIPT and is not the reviewer's to override; turning
   *      it back on would send the payment to be receipted a second time.
   *
   *   2. The payment has already reconciled — [Bank Reco Match] = "Match" on a
   *      new entry. The bank statement carries the money, so the question of
   *      whether it is a new entry is closed — and so is which account it
   *      settled to, because that account is what chose the workbook the money
   *      was found in.
   *
   * Everything else stays editable, including a "Match" the reviewer set
   * themselves (EditType = "Manual"): their own verdict is theirs to undo, right
   * up until reconciliation settles it.
   */
  isRowLocked(row: EmailReceiptDetailRow): boolean {
    const duplicate = (row.dublicateMatch || '').trim().toLowerCase() === 'match';
    const automated = (row.editType || '').trim().toLowerCase() === 'automate';

    if (duplicate && automated) {
      return true;
    }

    return !duplicate && this.isBankRecoMatched(row);
  }

  toggleTitle(row: EmailReceiptDetailRow): string {
    if (!this.isRowLocked(row)) {
      return this.isNewEntry(row)
        ? 'New entry — switch off if it is already receipted'
        : 'Marked as a duplicate by you — switch on to send it for reconciliation';
    }

    return this.isNewEntry(row)
      ? 'Already reconciled against the bank statement — this payment is settled'
      : 'Found on a receipt in SALES_RECEIPT — this payment cannot be sent for reconciliation';
  }

  /**
   * [Instrument Match] as a pill: whether the row carries every field a receipt
   * needs. Blank until the step has run, which is why the label falls back to
   * "Not Checked" rather than claiming either verdict.
   */
  isRowComplete(row: EmailReceiptDetailRow): boolean {
    return (row.instrumentMatch || '').trim().toLowerCase() === 'match';
  }

  /** Blank column: Instrument Match has not looked at this payment yet. */
  isInstrumentMatchPending(row: EmailReceiptDetailRow): boolean {
    return (row.instrumentMatch || '').trim() === '';
  }

  instrumentMatchLabel(row: EmailReceiptDetailRow): string {
    const stored = (row.instrumentMatch || '').trim();

    if (stored === '') {
      return 'Not Checked';
    }

    return this.isRowComplete(row) ? 'Complete' : 'Incomplete';
  }

  instrumentMatchTitle(row: EmailReceiptDetailRow): string {
    const stored = (row.instrumentMatch || '').trim();

    if (stored === '') {
      return 'Instrument Match has not run for this payment yet';
    }

    return this.isRowComplete(row)
      ? 'Instrument Match: every field a receipt needs is present'
      : 'Instrument Match: something a receipt needs is missing — see the red fields';
  }

  /**
   * [Bank Reco Match] as a pill — shown only for a new entry.
   *
   * A payment already on the books never reaches Bank Reconciliation (node 5
   * only picks up rows whose [Dublicate Match] is 'Unmatch'), so a reconciliation
   * verdict beside a Duplicate Entry would be a verdict nothing ever wrote.
   */
  showsBankReco(row: EmailReceiptDetailRow): boolean {
    return this.isNewEntry(row);
  }

  isBankRecoMatched(row: EmailReceiptDetailRow): boolean {
    return (row.bankRecoMatch || '').trim().toLowerCase() === 'match';
  }

  /** Blank column: Bank Reconciliation has not looked at this payment yet. */
  isBankRecoPending(row: EmailReceiptDetailRow): boolean {
    return (row.bankRecoMatch || '').trim() === '';
  }

  bankRecoLabel(row: EmailReceiptDetailRow): string {
    const stored = (row.bankRecoMatch || '').trim();

    if (stored === '') {
      return 'Not Checked';
    }

    return this.isBankRecoMatched(row) ? 'Matched' : 'Unmatched';
  }

  /**
   * A payment Instrument Match judged incomplete, on the card that owns that
   * verdict.
   *
   * The pill says "Incomplete" and the offending field wears a red pill, but
   * neither says what to do about it — and with the Pride account the field is a
   * dropdown on this very card, not something Edit & Save can fix. Only for a
   * stored "Unmatch": a blank column means the step has not run, which is not a
   * failure.
   */
  showsIncompleteWarning(row: EmailReceiptDetailRow): boolean {
    return !this.isBankRecoCard && !this.isInstrumentMatchPending(row) && !this.isRowComplete(row);
  }

  /**
   * What the row is short of, named as the card names it — the same rule the
   * backend's completeness check applies.
   *
   * The customer's own details — Payment Mode, Customer Bank, Customer Account
   * No — are not among them: they describe where the money came from rather
   * than what the receipt needs, and Instrument Match fills each in rather than
   * holding the receipt up for it. Kept in step with MissingReceiptFields() in
   * EmailAutomationController.cs.
   */
  missingFieldsOf(row: EmailReceiptDetailRow): string {
    const missing: string[] = [];

    if (!this.isUsable(row.instrumentNumber)) missing.push('UTR / Instrument No');
    if (!this.isUsable(row.amount)) missing.push('Amount');
    if (!this.isUsable(this.selectedAccount(row))) missing.push('Pride AC No');

    return missing.join(', ');
  }

  /** True when the Pride account is the only thing standing in the way. */
  needsAccountOnly(row: EmailReceiptDetailRow): boolean {
    return this.missingFieldsOf(row) === 'Pride AC No';
  }

  /**
   * A payment the bank statement did not carry, on the card whose step went
   * looking for it.
   *
   * Said on the row itself rather than only in the step's summary: the summary
   * names which payments failed, but the fields that would explain why are here,
   * and this is where the reviewer is looking when they wonder what to do next.
   * Only for a verdict of "Unmatch" — a blank column means the search has not
   * run yet, which is not a failure.
   */
  showsBankRecoWarning(row: EmailReceiptDetailRow): boolean {
    return this.isBankRecoCard && !this.isBankRecoPending(row) && !this.isBankRecoMatched(row);
  }

  /**
   * row.bankRecoNote holds "file|date" or "file|date|reason", not a sentence —
   * split once here so the accessors below don't each re-split it.
   */
  private bankRecoNoteParts(row: EmailReceiptDetailRow): { file: string; date: string; reason: string } {
    const [file, date, reason] = (row.bankRecoNote || '').split('|');

    return { file: (file || '').trim(), date: (date || '').trim(), reason: (reason || '').trim() };
  }

  /**
   * Why no statement could actually be checked — the month folder is missing,
   * no workbook carries the Pride account's last four digits, the file was
   * locked. Blank whenever the search ran, found or not.
   */
  bankRecoReason(row: EmailReceiptDetailRow): string {
    return this.bankRecoNoteParts(row).reason;
  }

  /** Whether the Statement / Last Value Date box has anything to say. */
  showsBankRecoNote(row: EmailReceiptDetailRow): boolean {
    return (
      this.showsBankRecoWarning(row) &&
      (this.bankRecoStatementFile(row) !== '' || this.bankRecoReason(row) !== '')
    );
  }

  /** The workbook Bank Reconciliation searched, e.g. "KOTAK_SOHO_5968.xlsm". */
  bankRecoStatementFile(row: EmailReceiptDetailRow): string {
    return this.bankRecoNoteParts(row).file;
  }

  /**
   * That workbook's last record's Value Date, e.g. "31-05-2026" — how current
   * its data is, so an Unmatch reads as "not there yet" rather than leaving
   * the reviewer to wonder whether the search even ran. Blank when the sheet
   * had no readable Value Date column.
   */
  bankRecoLastValueDate(row: EmailReceiptDetailRow): string {
    return this.bankRecoNoteParts(row).date;
  }

  bankRecoTitle(row: EmailReceiptDetailRow): string {
    const stored = (row.bankRecoMatch || '').trim();

    if (stored === '') {
      return 'Bank Reconciliation has not run for this payment yet';
    }

    return this.isBankRecoMatched(row)
      ? 'Bank Reco: found in the bank statement for this Pride account'
      : 'Bank Reco: not found in the bank statement for this Pride account';
  }

  /**
   * The pill beside the toggle, in the words the column stores — which for a
   * payment the reviewer turned off is the reason they typed.
   */
  entryStatusLabel(row: EmailReceiptDetailRow): string {
    const stored = (row.entryStatus || '').trim();

    // Falls back to the duplicate verdict when the column has not been written
    // yet, so a thread whose Instrument Match has not run still reads sensibly.
    return stored || (this.isRowLocked(row) ? 'Duplicate Entry' : 'New Entry');
  }

  /**
   * The two directions of the switch, which are not the same act.
   *
   * Turning a payment ON says the money still has to be receipted — the same
   * thing the step's own verdict says, so it is written straight through with
   * nothing to ask. Turning one OFF overrides the master: the reviewer is saying
   * this payment is already accounted for, and the popup asks why before
   * anything is written.
   *
   * A locked payment moves neither way. The button is disabled for those, and
   * this guard covers the paths a disabled button does not — keyboard activation
   * on a browser that allows it, or a row that changed under an in-flight click.
   */
  toggleRow(row: EmailReceiptDetailRow): void {
    if (this.isRowLocked(row)) {
      return;
    }

    if (this.isNewEntry(row)) {
      this.openDuplicateReason(row);
      return;
    }

    this.writeEntryStatus(row, true, '');
  }

  /**
   * Writes the reviewer's verdict to the row and to the database.
   *
   * Applied to the row first so the switch does not stick while the request is
   * in flight, and put back if the write fails.
   */
  private writeEntryStatus(row: EmailReceiptDetailRow, isNewEntry: boolean, entryStatus: string): void {
    const previousMatch = row.dublicateMatch;
    const previousStatus = row.entryStatus;

    row.dublicateMatch = isNewEntry ? 'Unmatch' : 'Match';
    row.entryStatus = isNewEntry ? 'New Entry' : entryStatus;
    // The reviewer set this, so the switch stays theirs to move — see
    // isToggleLocked(). Applied here too, not only from the response, or the
    // switch would lock itself for the moment the write is in flight.
    row.editType = 'Manual';
    this.errorMessage = '';
    this.cdr.markForCheck();

    this.emailAutomationService
      .setEntryStatus(this.threadKeyOf(row), row.emailReceiptsDetailsId, isNewEntry, entryStatus)
      .subscribe({
        next: (response) => {
          // The stored values win over the optimistic ones: the server decides
          // what the columns end up holding.
          row.dublicateMatch = response.dublicateMatch;
          row.entryStatus = response.entryStatus;
          row.editType = response.editType;

          // The verdict this switch just set is what decides whether the payment
          // reaches Bank Reconciliation at all, so the card below has to be told:
          // switching a payment off must take it out of that list at once, not at
          // the next reload.
          this.rowsChanged.emit(this.rows);
          this.cdr.markForCheck();
        },
        error: () => {
          row.dublicateMatch = previousMatch;
          row.entryStatus = previousStatus;
          this.errorMessage = 'Could not save the entry status. Please try again.';
          this.cdr.markForCheck();
        },
      });
  }

  // ── "Why is this a duplicate?" ────────────────────────────────

  /**
   * The payment whose toggle is being switched off, while the reason is asked
   * for. Null when the popup is closed — nothing has been written yet, and the
   * switch is still showing On.
   */
  reasonRow: EmailReceiptDetailRow | null = null;
  reasonText = '';
  reasonError = '';

  private openDuplicateReason(row: EmailReceiptDetailRow): void {
    this.reasonRow = row;
    this.reasonText = '';
    this.reasonError = '';
    this.cdr.markForCheck();
  }

  /**
   * Cancel: nothing is written, and the switch stays where it was.
   *
   * Nothing has to be "restored" — the row was never changed, because the write
   * is what changes it and no write has happened.
   */
  cancelDuplicateReason(): void {
    this.reasonRow = null;
    this.reasonText = '';
    this.reasonError = '';
    this.cdr.markForCheck();
  }

  /** Save: the reason becomes the row's EntryStatus, and the switch goes off. */
  saveDuplicateReason(): void {
    const row = this.reasonRow;

    if (!row) {
      return;
    }

    const reason = this.reasonText.trim();

    if (reason.length === 0) {
      this.reasonError = 'Please enter a reason.';
      this.cdr.markForCheck();
      return;
    }

    this.writeEntryStatus(row, false, reason);
    this.reasonRow = null;
    this.reasonText = '';
    this.reasonError = '';
    this.cdr.markForCheck();
  }

  /**
   * The accounts this thread's payments may be receipted against.
   *
   * One list for the whole card, resolved from the thread's own Project and Sub
   * Project — not per payment row. A payment is money against the thread's unit,
   * so every payment on it settles to the same account; resolving per row only
   * meant a row with a blank Project offered nothing while its neighbour offered
   * the right thing.
   *
   * Empty when the thread's project is unknown to the master, which is what puts
   * the dropdown into its disabled "No bank account mapped" state.
   */
  accountOptions: string[] = [];

  /** What the dropdown sits on: whatever is already stored for the payment. */
  selectedAccount(row: EmailReceiptDetailRow): string {
    return row.cashHeaderAccount || '';
  }

  /**
   * The account can be changed while the payment is still in play, and not once
   * it is settled — the same rule the switch beside it follows, plus the case of
   * a project the master maps to no accounts, where there is nothing to choose
   * from in the first place.
   */
  isAccountLocked(row: EmailReceiptDetailRow): boolean {
    return this.isRowLocked(row) || !this.optionsFor(row).length;
  }

  accountTooltip(row: EmailReceiptDetailRow): string {
    if (!this.optionsFor(row).length) {
      return 'No bank account is mapped for this project';
    }

    if (this.isRowLocked(row)) {
      return this.isNewEntry(row)
        ? 'Already reconciled against this account — it cannot be changed now'
        : 'Found on a receipt in SALES_RECEIPT — the account it settled to cannot be changed';
    }

    return this.selectedAccount(row) || 'Pride account';
  }

  /**
   * The options for one payment: the thread's accounts, plus whatever the row
   * already holds if that is not among them.
   *
   * Instrument Match fills the account from the receipt the payment was found
   * on, and that receipt can name an account the project master does not map to
   * this project. Without adding it, the select would sit on a value it has no
   * option for and show blank — the row would look unassigned when it is not.
   */
  optionsFor(row: EmailReceiptDetailRow): string[] {
    const stored = this.selectedAccount(row).trim();

    if (stored === '' || this.accountOptions.indexOf(stored) !== -1) {
      return this.accountOptions;
    }

    return [stored, ...this.accountOptions];
  }

  /**
   * Writes the picked account to the payment row.
   *
   * Applied to the row first so the dropdown does not spring back while the
   * request is in flight, and put back if the write fails — the reviewer must
   * not be left looking at an account the row does not actually hold.
   */
  onAccountSelected(row: EmailReceiptDetailRow, account: string): void {
    const previous = row.cashHeaderAccount || '';

    // A settled payment's account is fixed. The dropdown is disabled for those,
    // and this covers what a disabled control does not — a row that settled
    // while the list was open.
    if (account === previous || this.isRowLocked(row)) {
      return;
    }

    row.cashHeaderAccount = account;
    this.errorMessage = '';
    this.cdr.markForCheck();

    this.emailAutomationService
      .updateReceiptDetail(this.threadKeyOf(row), row.emailReceiptsDetailsId, {
        cashHeaderAccount: account,
      })
      .subscribe({
        next: (response) => {
          // The account is one of the fields Instrument Match judges, so the
          // server re-checks the row and sends every row back as it now stands.
          // Taking them repaints the Instrument Match pill straight away —
          // clearing an account turns it red without waiting for a re-run — and
          // the pipeline is told, so its buttons follow the same answer.
          this.rows = response.rows || this.rows;
          this.rowsChanged.emit(this.rows);
          this.cdr.markForCheck();
        },
        error: (err) => {
          row.cashHeaderAccount = previous;
          // The server says which row it could not find, which is the difference
          // between "try again" and "this payment is not where the UI thinks it
          // is". A bare 404 in the console said neither.
          this.errorMessage =
            err?.error?.message || 'Could not save the collection account. Please try again.';
          this.cdr.markForCheck();
        },
      });
  }

  /**
   * Resolves the thread's accounts from its Project and Sub Project.
   *
   * Driven by the inputs rather than by the payment rows, so the list refreshes
   * on its own when Unit Match fills a blank Project mid-session — the bound
   * values change, ngOnChanges fires, and the dropdowns fill without a reload.
   */
  private resolveAccountOptions(): void {
    this.projectBankAccount.optionsFor(this.project, this.subProject).subscribe((options) => {
      this.accountOptions = options;
      this.cdr.markForCheck();
    });
  }

  constructor(
    private readonly emailAutomationService: EmailAutomationService,
    private readonly projectBankAccount: ProjectBankAccountService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  openModal(): void {
    this.isModalOpen = true;
    this.cdr.markForCheck();
  }

  closeModal(): void {
    this.isModalOpen = false;
    this.cdr.markForCheck();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const reload = changes['date'] || changes['threadId'] || changes['refreshToken'];

    if (reload && this.date && this.threadId) {
      this.loadDetails(this.date, this.threadId);
    }

    // The accounts follow the thread, not the payments, so they are resolved
    // from these two inputs alone — including when Unit Match fills a blank
    // Project while the card is already on screen.
    if (changes['project'] || changes['subProject']) {
      this.resolveAccountOptions();
    }
  }

  /**
   * A cell that actually says something — the same rule the backend applies
   * before deciding a payment is complete.
   */
  private isUsable(value: string | undefined): boolean {
    const trimmed = (value || '').trim().toLowerCase();
    const placeholders = ['', 'n/a', 'na', 'none', 'null', '-', '--'];

    return placeholders.indexOf(trimmed) === -1;
  }

  /** The full number, not a masked one: XXXX0852 cannot be matched to anything. */
  private isUsableAccount(value: string | undefined): boolean {
    return this.isUsable(value) && !/[xX*]/.test(value || '');
  }

  /**
   * The pill every checked field wears: green when the value is one a receipt
   * can be raised on, red when it is not.
   *
   * One rule for all of them, so the reviewer reads the row rather than
   * remembering which field is judged how — the ones still red are exactly the
   * ones Edit & Save asks for.
   */
  fieldClass(row: EmailReceiptDetailRow, value: string | undefined): string {
    return this.isUsable(value) ? 'match-pill matched' : 'match-pill unmatched';
  }

  /**
   * The customer's account number is not a field a receipt is held up for any
   * more, so it never wears the red "missing" pill — not when it is absent,
   * and not when it is masked. Instrument Match stamps "N/A" onto an absent
   * one (see ApplyDefaultCustomerAccountNumber in the controller); a masked
   * one is left as the customer wrote it.
   */
  accountClass(value: string | undefined): string {
    return 'match-pill matched';
  }

  /**
   * Customer Bank, on the same rule as the account number beside it: not a
   * field a receipt is held up for any more, so never the red "missing" pill.
   * Instrument Match stamps "N/A" onto a blank one.
   */
  missingClass(value: string | undefined): string {
    return 'match-pill matched';
  }

  /**
   * Payment Mode as the receipt will actually use it: what the row says, or
   * the online-payment default where it says nothing.
   *
   * Shown rather than the stored blank so the card reads the same before and
   * after Instrument Match — that step writes this very value onto the row
   * (see ApplyDefaultPaymentMode in EmailAutomationController.cs), so the
   * default here is a preview of it, not a second opinion.
   */
  paymentModeOf(row: EmailReceiptDetailRow): string {
    return this.isUsable(row.paymentMode) ? (row.paymentMode || '').trim() : 'Online Payment';
  }

  /**
   * Never the red "missing" pill: Payment Mode is not a field a receipt is
   * held up for any more, so a row that does not state one is not short of
   * anything.
   */
  paymentModeClass(): string {
    return 'match-pill matched';
  }

  /** Says where the value came from when it is the default rather than the row's. */
  paymentModeTitle(row: EmailReceiptDetailRow): string {
    return this.isUsable(row.paymentMode)
      ? ''
      : 'Not stated on this payment — taken as an online payment';
  }

  /** Hover text for Customer Bank, which is no longer a field to be short of. */
  valueTitle(value: string | undefined): string {
    return this.isUsable(value) ? '' : 'Not supplied on this payment — a receipt can still be raised';
  }

  /** Hover text explaining the pill. */
  fieldTitle(row: EmailReceiptDetailRow, value: string | undefined): string {
    if (!this.isUsable(value)) {
      return 'Missing — a receipt cannot be raised without it';
    }

    return this.isNewEntry(row)
      ? 'Not found in SALES_RECEIPT yet'
      : 'Matched a receipt in SALES_RECEIPT';
  }

  accountTitle(value: string | undefined): string {
    if (!this.isUsable(value)) {
      return 'Not supplied on this payment — a receipt can still be raised';
    }

    return this.isUsableAccount(value)
      ? 'Full account number'
      : 'Masked, as the customer wrote it — a receipt can still be raised';
  }

  /** The Pride account field: green once one is chosen, red while it is not. */
  accountFieldClass(row: EmailReceiptDetailRow): string {
    if (!this.optionsFor(row).length) {
      return 'is-unmapped';
    }

    const state = this.isUsable(this.selectedAccount(row)) ? 'is-chosen' : 'is-blank';

    // Settled rows keep their colour but lose the chevron and the hover, so the
    // field reads as a value rather than as something still to be picked.
    return this.isRowLocked(row) ? `${state} is-fixed` : state;
  }

  private loadDetails(date: string, threadId: string): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.rows = [];

    this.emailAutomationService.getReceiptDetails(date, threadId).subscribe({
      next: (response) => {
        // The accounts are not touched here: they belong to the thread, and the
        // payments arriving says nothing new about its project.
        this.rows = response.rows;
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        // A 404 just means no main_email_receipt_details_ file exists for this
        // date (not every day has one) — treat that as "no data", not an error.
        this.rows = [];
        this.errorMessage = err.status === 404 ? '' : 'Could not load payment details. Please try again.';
        this.cdr.markForCheck();
      },
    });
  }
}
