/**
 * View model for the reviewer-edit popup shared by the pipeline's four edit
 * gates (blank sender before node 2, blank project/unit before node 3, an
 * unmatched instrument number after node 4, missing amount/account before
 * node 5).
 *
 * Deliberately field-driven rather than one component per gate: the four
 * dialogs differ only in which fields they show and which row they write to.
 */

/** One editable input in the popup. */
export interface WorkflowEditField {
  /** Payload key sent to the backend, e.g. 'customerSender' or 'instrumentNumber'. */
  key: string;
  /** Input label, e.g. 'Customer Sender'. */
  label: string;
  /** Current value; bound directly, so the dialog edits its own copy. */
  value: string;
  placeholder?: string;
  /**
   * Turns the field into a dropdown of these choices instead of a text box.
   *
   * For a value that has to be one of a known set — a CRM user's name, say —
   * where typing it out invites a spelling the rest of the app cannot match.
   */
  options?: string[];
  /** Save stays disabled while a required field is blank. */
  required?: boolean;
  /** Small grey line under the input, e.g. why the step needs this field. */
  hint?: string;
}

/**
 * The fields belonging to one database row.
 *
 * A receipt edit has exactly one group; a payment edit has one per payment row,
 * which is why the id travels with the fields rather than with the request.
 */
export interface WorkflowEditGroup {
  /** [Email Receipts ID] or [Email Receipts Details ID] this group writes to. */
  id: string;
  /** Heading shown when a request carries more than one group. */
  title?: string;
  /**
   * The required fields this row is short of, e.g. 'Customer Bank, Pride AC No'.
   * Shown in red beside the heading — the reason this group is in the dialog.
   */
  missing?: string;
  fields: WorkflowEditField[];
}

/** Everything the popup needs to render one edit. */
export interface WorkflowEditRequest {
  /**
   * Which gate opened it — the visualizer switches on this when saving.
   *
   * 'assign-owner' is not a pipeline node: it is the owner picker node 3 offers
   * when the booking's stage is unknown, and it writes [Assigned To] rather
   * than a column of the receipt row.
   */
  gate: 'node-2' | 'node-3' | 'node-4' | 'node-5' | 'assign-owner';
  title: string;
  /** Sentence under the title explaining why the pipeline stopped. */
  description: string;
  saveLabel: string;
  groups: WorkflowEditGroup[];
}

/** What the popup hands back on save: group id → field key → value. */
export interface WorkflowEditSubmission {
  gate: WorkflowEditRequest['gate'];
  values: { [groupId: string]: { [fieldKey: string]: string } };
}
