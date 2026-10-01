import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

import { AgreementStepResponse } from '../models/agreement-step-response.model';
import { ConfigService } from '../../../core/services/config.service';
import { CustomerEmailVerificationResponse } from '../models/customer-email-verification.model';
import { EmailDateDropdownItem } from '../models/email-date.model';
import { EmailReceiptsReportResponse } from '../models/email-receipt.model';
import { EmailReceiptDetailsResponse } from '../models/email-receipt-detail.model';
import { BankReconciliationResponse } from '../models/bank-reconciliation.model';
import { EntryStatusResponse, InstrumentMatchResponse } from '../models/instrument-match.model';
import { ProjectBankAccount } from '../models/project-bank-account.model';
import { SheetPreviewResponse } from '../models/sheet-preview.model';
import {
  ReceiptDetailUpdateFields,
  ReceiptDetailUpdateResponse,
  ReceiptUpdateFields,
  ReceiptUpdateResponse,
} from '../models/row-update.model';
import { ThreadActionStatusResponse } from '../models/thread-action-status.model';
import { ThreadAssignmentResponse } from '../models/thread-assignment.model';
import { ThreadAttachmentsResponse } from '../models/thread-attachment.model';
import { AlertReplyDraft } from '../models/email-response.model';
import { ThreadRepliesResponse } from '../models/thread-reply.model';
import { ThreadMessagesResponse } from '../models/thread-message.model';
import {
  TicketAcknowledgementResponse,
  TicketCloseResponse,
  TicketSlaResponse,
} from '../models/ticket-acknowledgement.model';
import { UnitMatchResponse } from '../models/unit-match.model';

/**
 * Talks to the EmailAutomationController on the backend
 * (BE/EmailAutomation/EmailAutomation/Controllers/EmailAutomationController.cs).
 */
@Injectable({ providedIn: 'root' })
export class EmailAutomationService {
  constructor(
    private readonly http: HttpClient,
    private readonly config: ConfigService
  ) {}

  /** GET api/emailautomation/dates — dates to bind the date dropdown. */
  getAvailableDates(): Observable<EmailDateDropdownItem[]> {
    return this.http.get<EmailDateDropdownItem[]>(`${this.config.apiBaseUrl}/emailautomation/dates`);
  }

  /**
   * GET api/emailautomation/project-bank-accounts — every active row of
   * PRIDE_PROJECT_BANK_ACCOUNT_MASTER, for the account dropdown on the payment
   * cards. The whole master comes back; matching a project and wing to a row is
   * ProjectBankAccountService's job.
   */
  getProjectBankAccounts(): Observable<ProjectBankAccount[]> {
    return this.http.get<ProjectBankAccount[]>(
      `${this.config.apiBaseUrl}/emailautomation/project-bank-accounts`
    );
  }

  /** GET api/emailautomation/receipts?date=... — rows from main_email_receipts_{date}.csv (plain file only). */
  getReceipts(date: string): Observable<EmailReceiptsReportResponse> {
    const params = new HttpParams().set('date', date);
    return this.http.get<EmailReceiptsReportResponse>(`${this.config.apiBaseUrl}/emailautomation/receipts`, { params });
  }

  /** GET api/emailautomation/receipt-details?date=...&threadId=... — rows from main_email_receipt_details_{date}.csv for one thread. */
  getReceiptDetails(date: string, threadId: string): Observable<EmailReceiptDetailsResponse> {
    const params = new HttpParams().set('date', date).set('threadId', threadId);
    return this.http.get<EmailReceiptDetailsResponse>(`${this.config.apiBaseUrl}/emailautomation/receipt-details`, { params });
  }

  /**
   * POST api/emailautomation/acknowledge-tickets — pipeline node 1.
   * Makes sure every thread in the date's report holds a ticket: an existing
   * Open ticket is reused, otherwise a new TKT-{year}-{000000} is raised.
   * A newly raised ticket's thread gets fallbackUser.emailId in its
   * [Assigned To] when that is still blank.
   */
  acknowledgeTickets(date: string): Observable<TicketAcknowledgementResponse> {
    return this.http.post<TicketAcknowledgementResponse>(
      `${this.config.apiBaseUrl}/emailautomation/acknowledge-tickets`,
      { date, defaultAssignee: this.config.fallbackUser.emailId }
    );
  }

  /**
   * POST api/emailautomation/close-ticket — closes a ticket the reviewer has
   * finished with. A thread only reuses tickets that are still Open, so closing
   * is what lets the same thread raise a fresh one if the customer writes again.
   */
  closeTicket(threadId: string, ticketId: string): Observable<TicketCloseResponse> {
    return this.http.post<TicketCloseResponse>(
      `${this.config.apiBaseUrl}/emailautomation/close-ticket`,
      { threadId, ticketId, updatedBy: this.config.updatedBy }
    );
  }

  /**
   * POST api/emailautomation/refresh-sla — re-evaluates where a ticket's SLA
   * stands and records the breach if it has run out.
   *
   * Called when a countdown on screen reaches zero, so 'Overdue' lands in the
   * database at the moment it becomes true rather than at the next date load.
   * Only that one transition is written — a ticking clock costs no calls.
   *
   * Omit ticketId to sweep every open ticket.
   */
  refreshSla(ticketId?: string): Observable<TicketSlaResponse> {
    return this.http.post<TicketSlaResponse>(
      `${this.config.apiBaseUrl}/emailautomation/refresh-sla`,
      { ticketId: ticketId || '' }
    );
  }

  /**
   * GET api/emailautomation/attachments?threadId=... — what the ingestion
   * pipeline saved for the thread. A thread with no folder comes back as an
   * empty list rather than an error.
   */
  getThreadAttachments(threadId: string): Observable<ThreadAttachmentsResponse> {
    const params = new HttpParams().set('threadId', threadId);
    return this.http.get<ThreadAttachmentsResponse>(
      `${this.config.apiBaseUrl}/emailautomation/attachments`,
      { params }
    );
  }

  /**
   * The URL one attachment is served from.
   *
   * Built here rather than returned by the backend so it always points at the
   * API base this app is actually configured against, and used directly as an
   * <img> src / link href — the browser fetches it, not HttpClient.
   */
  /**
   * GET api/emailautomation/attachment-preview — one spreadsheet attachment as
   * rows of text, so the popup can show it rather than only offering it as a
   * download. .csv, .xlsx and .xlsm only.
   */
  getSheetPreview(threadId: string, fileName: string, sheet = ''): Observable<SheetPreviewResponse> {
    let params = new HttpParams().set('threadId', threadId).set('fileName', fileName);

    if (sheet) {
      params = params.set('sheet', sheet);
    }

    return this.http.get<SheetPreviewResponse>(
      `${this.config.apiBaseUrl}/emailautomation/attachment-preview`,
      { params }
    );
  }

  attachmentUrl(threadId: string, fileName: string, thumb = false): string {
    const query =
      `threadId=${encodeURIComponent(threadId)}&fileName=${encodeURIComponent(fileName)}` +
      (thumb ? '&thumb=true' : '');

    return `${this.config.apiBaseUrl}/emailautomation/attachment?${query}`;
  }

  /**
   * GET api/emailautomation/thread-replies?threadId=... — every reply the CRM
   * has already written on a thread, newest first, with the files each carried.
   *
   * Read when the Alert Response popup opens, so a reviewer sees what has
   * already been said before saying it again.
   */
  getThreadReplies(threadId: string): Observable<ThreadRepliesResponse> {
    const params = new HttpParams().set('threadId', threadId);

    return this.http.get<ThreadRepliesResponse>(
      `${this.config.apiBaseUrl}/emailautomation/thread-replies`,
      { params }
    );
  }

  /**
   * GET api/emailautomation/thread-messages?threadId=... — every mail that came
   * in on a thread, from main_email_messages, oldest first. The Alert Response
   * popup interleaves these with getThreadReplies() into one conversation.
   */
  getThreadMessages(threadId: string): Observable<ThreadMessagesResponse> {
    const params = new HttpParams().set('threadId', threadId);

    return this.http.get<ThreadMessagesResponse>(
      `${this.config.apiBaseUrl}/emailautomation/thread-messages`,
      { params }
    );
  }

  /**
   * POST api/emailautomation/save-thread-reply — keeps a reply written in the
   * Alert Response compose against its thread.
   *
   * One call for both kinds of reply, because there is one thing being kept:
   * what the CRM wrote back to the customer on this thread. Whether the words
   * were typed after Respond or drafted by a stopped pipeline step does not
   * change the row, and splitting it in two would only mean the popup's own
   * history showed half the conversation.
   *
   * It saves; it does not send. There is no mail transport in the backend, and
   * the endpoint says so rather than pretending otherwise.
   *
   * The draft goes up as it stands — addresses as lists, attachments as base64,
   * `subject` and `ticketId` blank on a reply that has neither, which the server
   * reads as "derive them from the thread". `from` rides along unused: nothing
   * in PRIDE_EMAIL_REPLY holds a sender address.
   *
   * The whole refreshed reply list comes back, so the popup repaints from this
   * one call.
   */
  saveThreadReply(draft: AlertReplyDraft): Observable<ThreadRepliesResponse> {
    return this.http.post<ThreadRepliesResponse>(
      `${this.config.apiBaseUrl}/emailautomation/save-thread-reply`,
      { ...draft, updatedBy: this.config.updatedBy }
    );
  }

  /**
   * The download URL for one file on a saved reply, or on a mail that came in.
   * Same shape as attachmentUrl().
   *
   * A reply is asked for by its numeric id (18); a mail by its reference
   * ('13-M') — main_email_messages.ID with '-M' after it.
   */
  replyAttachmentUrl(replyId: number | string, fileName: string): string {
    const query = `replyId=${encodeURIComponent(replyId)}&fileName=${encodeURIComponent(fileName)}`;

    return `${this.config.apiBaseUrl}/emailautomation/reply-attachment?${query}`;
  }

  /**
   * The same file as bytes, for saving to the reviewers own machine.
   *
   * Fetched rather than linked to: the API is served from its own origin, and
   * a browser ignores an anchors download attribute across origins -- the file
   * would open in a tab instead of landing in Downloads. A blob is same-origin
   * by the time the anchor sees it, so the file name and the save both hold.
   */
  downloadReplyAttachment(replyId: number | string, fileName: string): Observable<Blob> {
    return this.http.get(this.replyAttachmentUrl(replyId, fileName), {
      responseType: 'blob',
    });
  }

  /**
   * POST api/emailautomation/update-receipt — a reviewer's correction to the
   * source fields the pipeline reads (Customer Sender for node 2; Project /
   * Sub Project / Unit for node 3), so the blocked step can be re-run against
   * the corrected row. Keyed on [Email Receipts ID] + [Thread ID].
   *
   * `updatedBy` is journalled against the change in PRIDE_BANK_DETAILS_AUDIT_LOG;
   * the timestamp is the database's own GETDATE(), so every row is stamped on one
   * clock rather than on whatever each browser's is set to.
   */
  updateReceipt(
    date: string,
    threadId: string,
    emailReceiptsId: string,
    fields: ReceiptUpdateFields
  ): Observable<ReceiptUpdateResponse> {
    return this.http.post<ReceiptUpdateResponse>(
      `${this.config.apiBaseUrl}/emailautomation/update-receipt`,
      { date, threadId, emailReceiptsId, updatedBy: this.config.updatedBy, ...fields }
    );
  }

  /**
   * POST api/emailautomation/set-entry-status — the reviewer's own verdict on a
   * payment, from the toggle on its card.
   *
   * A new entry is one that is not on the books yet, stored as
   * [Dublicate Match] = 'Unmatch', which is what lets Bank Reconciliation pick
   * the payment up.
   */
  setEntryStatus(
    threadId: string,
    emailReceiptsDetailsId: string,
    isNewEntry: boolean,
    /**
     * Why the payment is being marked as a duplicate, from the popup the toggle
     * opens when it is switched off. Stored as the row's EntryStatus. Empty when
     * switching on — that direction has no question to answer.
     */
    entryStatus = ''
  ): Observable<EntryStatusResponse> {
    return this.http.post<EntryStatusResponse>(
      `${this.config.apiBaseUrl}/emailautomation/set-entry-status`,
      { threadId, emailReceiptsDetailsId, isNewEntry, entryStatus, updatedBy: this.config.updatedBy }
    );
  }

  /**
   * POST api/emailautomation/assign-thread — writes the thread's owner into
   * main_email_receipts.[Assigned To].
   *
   * The name is resolved here rather than on the server: the project → users
   * mapping and its CRM-head fallback live in config.json, which only this side
   * reads. See ProjectAssignmentService.
   */
  assignThread(
    date: string,
    threadId: string,
    assignedTo: string
  ): Observable<ThreadAssignmentResponse> {
    return this.http.post<ThreadAssignmentResponse>(
      `${this.config.apiBaseUrl}/emailautomation/assign-thread`,
      { date, threadId, assignedTo }
    );
  }

  /**
   * POST api/emailautomation/update-action-status — writes which pipeline step
   * a thread is currently stopped on, and why, into main_email_receipts.
   * [Action] / [Action Status].
   *
   * Both values are computed here on the FE, not the server: the pipeline
   * panel already derives them per node (see statusLabel() in
   * workflow-visualizer.ts), and this call is only how that answer reaches
   * the Email Receipts grid without it having to recompute the whole
   * pipeline for every row it lists.
   */
  updateActionStatus(
    date: string,
    threadId: string,
    action: string,
    actionStatus: string
  ): Observable<ThreadActionStatusResponse> {
    return this.http.post<ThreadActionStatusResponse>(
      `${this.config.apiBaseUrl}/emailautomation/update-action-status`,
      { date, threadId, action, actionStatus }
    );
  }

  /**
   * POST api/emailautomation/apply-booking — writes the booking picked for a
   * thread onto its receipt row, ready for Unit Match to run against.
   *
   * The backend fills only the columns that are currently blank: what the email
   * said is evidence, and a booking chosen here does not overwrite it.
   */
  applyBooking(
    date: string,
    threadId: string,
    emailReceiptsId: string,
    booking: { project: string; subProject: string; unit: string }
  ): Observable<ReceiptUpdateResponse> {
    return this.http.post<ReceiptUpdateResponse>(
      `${this.config.apiBaseUrl}/emailautomation/apply-booking`,
      { date, threadId, emailReceiptsId, updatedBy: this.config.updatedBy, ...booking }
    );
  }

  /**
   * POST api/emailautomation/update-receipt-detail — the payment-row equivalent:
   * the instrument number node 4 could not find, or the amount / account number
   * node 5 needs. Keyed on [Email Receipts Details ID] + [Thread ID].
   */
  updateReceiptDetail(
    threadId: string,
    emailReceiptsDetailsId: string,
    fields: ReceiptDetailUpdateFields
  ): Observable<ReceiptDetailUpdateResponse> {
    return this.http.post<ReceiptDetailUpdateResponse>(
      `${this.config.apiBaseUrl}/emailautomation/update-receipt-detail`,
      { threadId, emailReceiptsDetailsId, updatedBy: this.config.updatedBy, ...fields }
    );
  }

  /**
   * POST api/emailautomation/verify-customer-email — pipeline node 2.
   * Checks the thread's Customer Sender against EMAIL1/EMAIL2/EMAIL3 in
   * SALES_BOOKING_DETAILS. On no match the backend parks the thread by writing
   * "Ticketed Pending CRM head" into the CSV Status column.
   */
  verifyCustomerEmail(date: string, threadId: string): Observable<CustomerEmailVerificationResponse> {
    return this.http.post<CustomerEmailVerificationResponse>(
      `${this.config.apiBaseUrl}/emailautomation/verify-customer-email`,
      { date, threadId }
    );
  }

  /**
   * POST api/emailautomation/match-unit — pipeline node 3.
   * Looks for a booking matching the thread's Unit + Customer Sender + Project
   * together. On no match the backend writes "AI pipline recorde not match" into
   * the CSV Remark column.
   */
  matchUnit(date: string, threadId: string): Observable<UnitMatchResponse> {
    return this.http.post<UnitMatchResponse>(
      `${this.config.apiBaseUrl}/emailautomation/match-unit`,
      { date, threadId }
    );
  }

  /**
   * POST api/emailautomation/verify-agreement-step — the Agreement Workflow's
   * thirteen stages, nodes a1 to a13.
   *
   * One endpoint for all of them; `stepKey` says which. The stages differ only
   * in which column they record, and none has a master-data lookup of its own —
   * verifying one records the reviewer's confirmation and moves the row's
   * Workflow Status on to the stage after it.
   *
   * The backend enforces the order as well as the UI: a stage whose predecessor
   * has not passed comes back 409, and a thread that does not run this workflow
   * at all comes back 400.
   */
  verifyAgreementStep(
    date: string,
    threadId: string,
    stepKey: string
  ): Observable<AgreementStepResponse> {
    return this.http.post<AgreementStepResponse>(
      `${this.config.apiBaseUrl}/emailautomation/verify-agreement-step`,
      { date, threadId, stepKey }
    );
  }

  /**
   * POST api/emailautomation/match-instrument — pipeline node 4.
   * Searches the month's bank statement workbooks for each payment's instrument
   * number, highlights the matching Description cell green, and writes
   * Match/Unmatch into the details file's "Instrument Match" column.
   */
  matchInstrument(date: string, threadId: string): Observable<InstrumentMatchResponse> {
    return this.http.post<InstrumentMatchResponse>(
      `${this.config.apiBaseUrl}/emailautomation/match-instrument`,
      { date, threadId }
    );
  }

  /**
   * POST api/emailautomation/reconcile-bank — pipeline node 5.
   * Requires the statement row to carry both the instrument number and the same
   * amount; fills the amount cell yellow and writes "Bank Reco Match" plus
   * "Dublicate Match" into the details file.
   */
  reconcileBank(date: string, threadId: string): Observable<BankReconciliationResponse> {
    return this.http.post<BankReconciliationResponse>(
      `${this.config.apiBaseUrl}/emailautomation/reconcile-bank`,
      { date, threadId }
    );
  }
}
