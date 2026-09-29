import { ThreadReply } from './thread-reply.model';

/**
 * Mail that came in on a thread, kept in main_email_messages and replayed in
 * the Alert Response popup's history beside the replies from PRIDE_EMAIL_REPLY.
 *
 * Mirrors ThreadMessageRow / ThreadMessagesResponse on the backend.
 */

/** One incoming mail. Only the fields the history shows. */
export interface ThreadMessage {
  /** [Message Key], the mail's Message-ID. */
  messageKey: string;
  threadId: string;
  /** [Received Time] as ISO-8601, or the raw stored text when it would not parse. */
  receivedTime: string;
  subject: string;
  messageText: string;
}

/** Response for GET {apiBaseUrl}/emailautomation/thread-messages?threadId=... */
export interface ThreadMessagesResponse {
  threadId: string;
  /** Oldest first. */
  messages: ThreadMessage[];
  message: string;
}

/**
 * One entry of the popup's conversation: a mail the customer sent, or a reply
 * the CRM saved. Both kinds sit in one list ordered by `at`, so the thread
 * reads in the order it happened.
 */
export type ThreadHistoryEntry =
  | { kind: 'received'; at: string; message: ThreadMessage }
  | { kind: 'sent'; at: string; reply: ThreadReply };
