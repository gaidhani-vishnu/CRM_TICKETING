/**
 * Replies the CRM has written back to the customer on a thread, kept in
 * PRIDE_EMAIL_REPLY and replayed in the Alert Response popup.
 *
 * Mirrors ThreadReplyRow / ThreadReplyAttachmentRow / ThreadRepliesResponse on
 * the backend.
 */

/** One file saved against a reply. The bytes live on disk, not in the row. */
export interface ThreadReplyAttachment {
  id: number;
  /** Name to show — what the reviewer's machine called it. */
  fileName: string;
  /**
   * Name to ask the download endpoint for. Differs from fileName when the
   * original had characters a path cannot carry, or when the same name was
   * attached twice to one reply.
   */
  storedName: string;
  /** Lower-case, no dot, e.g. 'pdf'. '' when there is none. */
  extension: string;
  sizeBytes: number;
  isImage: boolean;
}

/** One reply already written on the thread. Read-only — the history never edits. */
export interface ThreadReply {
  id: number;
  threadId: string;
  /** The ticket open when it was written. '' when the thread had none. */
  ticketId: string;
  /** Addresses come back joined with '; ', since nothing here edits them. */
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** 'Saved' until there is a transport to move it past that. */
  status: string;
  createdBy: string;
  /** When it was saved, ISO-8601. */
  createdOn: string;
  attachments: ThreadReplyAttachment[];
}

/**
 * Response for GET {apiBaseUrl}/emailautomation/thread-replies?threadId=...
 * and for POST {apiBaseUrl}/emailautomation/save-thread-reply.
 *
 * The save returns the whole list, not just the row it wrote, so the popup
 * repaints its history from one call rather than two.
 */
export interface ThreadRepliesResponse {
  threadId: string;
  /** Oldest first. */
  replies: ThreadReply[];
  message: string;
}
