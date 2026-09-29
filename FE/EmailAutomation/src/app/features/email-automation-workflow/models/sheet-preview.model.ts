/**
 * A spreadsheet attachment read as rows of text.
 * Mirrors SheetPreviewResponse on the backend.
 *
 * Text, not formatting: this is a reading of the file so it can be checked
 * against the thread, not a rendering of it. Formulas arrive as their last
 * calculated value — what the sheet was showing when it was saved.
 */
export interface SheetPreviewResponse {
  threadId: string;
  fileName: string;
  /** Every sheet in the workbook, for the tab strip. One entry for a CSV. */
  sheetNames: string[];
  /** The one these rows came from. */
  sheetName: string;
  /** Cell text, every row the same width. The first is normally the header. */
  rows: string[][];
  rowCount: number;
  /** True when the sheet holds more rows than were sent. */
  truncated: boolean;
  message: string;
}
