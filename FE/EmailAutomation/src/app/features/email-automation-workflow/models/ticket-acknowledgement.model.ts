/**
 * Tickets raised for one report date's threads (pipeline node 1).
 * Mirrors TicketAcknowledgementResponse returned by the backend.
 */
export interface TicketAcknowledgementItem {
  threadId: string;
  /** e.g. 'TKT-2026-000001'. */
  ticketId: string;
  emailDate: string;
  /** SLA held against the ticket, e.g. '24 Hours'. The window the countdown runs. */
  sla: string;
  /**
   * When the ticket was raised — Created_Date on the ticket row, stamped by the
   * database as the ticket number and SLA were written. 'yyyy-MM-dd HH:mm:ss',
   * or empty on an old ticket that has no creation stamp yet.
   */
  createdDate: string;
  /** When the SLA runs out: createdDate plus the SLA. Display only. */
  slaDue: string;
  /** 'On Track', 'Overdue', or 'Met' once the ticket has been closed. */
  slaStatus: string;
  /**
   * When the ticket was closed — SLA_Closed_On on the ticket row, stamped by
   * the database in the same statement that set its status to Closed, so the
   * time shown is the time the status changed. 'yyyy-MM-dd HH:mm:ss'.
   *
   * Empty on an open ticket, and on one closed before that stamp was being
   * written — those have no recorded close time anywhere, so the UI says so
   * rather than showing the creation date in its place.
   */
  closedOn: string;
  /**
   * Seconds left on the SLA when the backend built this response, going negative
   * once overdue. Null on a ticket with no creation stamp.
   *
   * The countdown is driven off this rather than off slaDue: the deadline is a
   * plain server-local timestamp, and the browser's clock and timezone are not
   * the server's. A number of seconds needs neither to be right.
   */
  slaRemainingSeconds: number | null;
  /** 'Open' or 'Closed' as held on the ticket row. */
  ticketStatus: string;
  /** Outlook link to the thread's email, stored alongside the ticket. */
  emailLink: string;
  /** True when this call raised the ticket, false when an open one was reused. */
  isNew: boolean;
}

/** Response for POST {apiBaseUrl}/emailautomation/close-ticket */
export interface TicketCloseResponse {
  threadId: string;
  ticketId: string;
  /** Where the ticket now stands: 'Closed'. */
  ticketStatus: string;
  /** How the SLA finished: 'Met' if closed inside its window, else 'Overdue'. */
  slaStatus: string;
  /**
   * The instant the close was written, read back out of the same statement —
   * so the panel can show it straight away, on the database's clock rather
   * than the browser's. Empty when the ticket was already closed.
   */
  closedOn: string;
  message: string;
}

/**
 * Response for POST {apiBaseUrl}/emailautomation/refresh-sla — where one
 * ticket's SLA stands, after the backend has re-evaluated it.
 */
export interface TicketSlaResponse {
  ticketId: string;
  createdDate: string;
  slaDue: string;
  slaStatus: string;
  slaRemainingSeconds: number | null;
  /** The database's clock when this was measured. */
  serverTime: string;
  /** How many tickets that call moved to Overdue. */
  markedOverdue: number;
}

export interface TicketAcknowledgementResponse {
  date: string;
  totalThreads: number;
  createdCount: number;
  reusedCount: number;
  /** The database's clock when the tickets were read. */
  serverTime: string;
  tickets: TicketAcknowledgementItem[];

  /**
   * Tickets these threads have already had closed.
   *
   * A thread can hold both at once: closing a ticket is what lets the next load
   * raise a fresh one, so a thread dealt with once and written in again has a
   * closed ticket behind its open one. `tickets` above only ever carries the
   * open half.
   */
  closedTickets?: TicketAcknowledgementItem[];
}
