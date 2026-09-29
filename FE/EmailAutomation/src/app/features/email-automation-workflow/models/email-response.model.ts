import { WorkflowStepId } from '../services/workflow-steps/workflow-step.model';

/**
 * A drafted reply to the customer, for one pipeline step.
 *
 * Each step that can stop on a mismatch has its own template — what the customer
 * is being asked for differs completely between "we cannot find your email
 * address" and "the UTR you sent is not in the bank statement" — plus one for
 * the receipt itself, drafted only once every earlier step has passed.
 *
 * Held as plain text: nothing here is sent yet, and the reviewer edits it in the
 * popup before it ever will be.
 */
export interface EmailResponseTemplate {
  /** Which step drafted it, e.g. 'node-4'. */
  stepId: WorkflowStepId;

  /** That step's title, shown as the popup's heading. */
  stepTitle: string;

  /**
   * The thread being answered, e.g. 'THR-c512a5c5'.
   *
   * Carried on the draft rather than read again at send time: the reviewer can
   * leave the popup open while the panel moves on, and the reply has to be
   * filed against the thread it was written about.
   */
  threadId: string;

  /**
   * The ticket it was drafted against, or '' when the thread had none.
   *
   * Sent with the reply rather than looked up server-side, because answering
   * "Close this ticket?" with yes closes this very ticket in the same click --
   * a server-side read of the thread's *open* ticket would then find nothing
   * and file the reply against no ticket at all.
   */
  ticketId: string;

  /**
   * Sender address: the mailbox of the CRM executive in the thread's
   * main_email_receipts.[Assigned To], or the configured CRM head when the
   * thread has no owner stored yet.
   */
  from: string;

  /** Recipient: the thread's Customer Sender, i.e. whoever wrote in. */
  to: string;

  subject: string;

  /** The drafted mail, already filled in with the thread's own details. */
  body: string;

  /**
   * Whether this reply can close the thread's ticket — true only where the reply
   * is the end of the matter, which today means a non-payment query.
   *
   * The popup asks "Close this ticket?" when it is set, and the answer decides
   * both what the customer is told and what happens to the ticket.
   */
  canCloseTicket: boolean;

  /**
   * The two versions of the line that tells the customer where their ticket
   * stands. Held apart from the body so answering the question swaps one
   * sentence rather than re-drafting the mail over whatever has been typed.
   */
  ticketClosedLine: string;
  ticketOpenLine: string;
}

/**
 * A reply being written in the Alert Response popup's inline compose.
 *
 * One shape for both kinds, because there is now one compose and one save call.
 * A reviewer's own words, typed after Respond, start empty here. A pipeline
 * step's Email Response is the same compose with the boxes already filled in
 * from its template — which is why the three fields at the bottom exist, and why
 * only a drafted reply fills them.
 *
 * The template a drafted reply came from stays on <app-alert-popup> as
 * composeTemplate, for the "Close this ticket?" lines it has to swap.
 */
export interface AlertReplyDraft {
  /** The thread being replied on, so the caller knows what it is sending about. */
  threadId: string;

  /**
   * The three address rows, each as its own list rather than a typed string.
   *
   * A list because the compose shows them as removable pills: parsing a
   * comma-separated string back apart on every keystroke to decide where one
   * pill ends and the next begins is the bug that shape invites.
   *
   * To is prefilled from the thread's Customer Sender; Cc and Bcc start empty
   * and their rows stay hidden until the reviewer asks for them.
   */
  to: string[];
  cc: string[];
  bcc: string[];

  /** Empty until the reviewer writes it — nothing is drafted for them here. */
  body: string;

  /** Files picked for the reply. Empty when none. */
  attachments: AlertReplyAttachment[];

  /**
   * The mailbox the reply goes out from. '' on a reply typed after Respond.
   *
   * Shown and editable on a drafted reply, since its template picked one from
   * the thread's owner and the reviewer may want another. Saved as
   * PRIDE_EMAIL_REPLY.Sent_From — a blank one leaves that column alone.
   */
  from: string;

  /**
   * The subject to keep it under, or '' to let the server derive
   * "Re: <the thread's subject>".
   *
   * Only a drafted reply carries one — it has a Subject box because its
   * template wrote a subject worth reading. Respond has no such box: a reviewer
   * answering in their own words is writing a reply, not a header.
   */
  subject: string;

  /**
   * The ticket the reply answers, or '' to let the server read the thread's
   * open one.
   *
   * Filled in on a drafted reply, because answering "Close this ticket?" with
   * yes closes that ticket before Send is ever pressed — a server-side read
   * would then find nothing open and file the reply against no ticket at all.
   */
  ticketId: string;
}

/**
 * One file picked for a reply, with its bytes already read.
 *
 * Named as the save endpoint takes them, since that is the only place they go.
 * The size is kept as a number rather than a formatted string so the compose can
 * both total it against the caps and print it on the chip.
 */
export interface AlertReplyAttachment {
  fileName: string;

  /**
   * The file's bytes as base64. Read with FileReader.readAsDataURL, so it
   * arrives with a "data:<type>;base64," prefix still on it — the backend
   * strips that rather than making every caller remember to.
   */
  contentBase64: string;

  /** True byte length, for the chip's label and the size check. */
  sizeBytes: number;
}
