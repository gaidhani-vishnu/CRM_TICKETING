/**
 * Files the ingestion pipeline saved for a thread, under
 * {AttachmentsFolderPath}\{Thread ID}\ on the server.
 *
 * Mirrors ThreadAttachment / ThreadAttachmentsResponse on the backend.
 */

export interface ThreadAttachment {
  /** File name as it sits on disk, e.g. '0a41b2be_SalesReceipt.pdf'. */
  fileName: string;
  /** Lower-case extension without the dot, e.g. 'pdf'. '' when there is none. */
  extension: string;
  sizeBytes: number;
  /** Last write time, ISO-8601. */
  modified: string;
  /** True for the types the popup previews as a thumbnail. */
  isImage: boolean;
}

/** Response for GET {apiBaseUrl}/emailautomation/attachments?threadId=... */
export interface ThreadAttachmentsResponse {
  threadId: string;
  /** False when the thread has no folder at all — it simply had no attachments. */
  folderExists: boolean;
  files: ThreadAttachment[];
}
