/**
 * The shapes the summary popup charts.
 *
 * This is the pivot the CRM team keeps rebuilding in Excel — Count of Ticket ID
 * by Assigned To, split by Ticket Status, filtered by Category — computed here
 * from the day's receipts, their tickets, and the project→CRM mapping.
 */

/** One row of the "Assigned To" breakdown: a CRM owner and their ticket counts. */
export interface AssigneeSummary {
  name: string;
  /** Ticket count per status, e.g. { Open: 73 }. */
  byStatus: { [status: string]: number };
  total: number;
}

/** One row of a simple name→count breakdown (category, workflow stage). */
export interface CategorySummary {
  name: string;
  total: number;
}

/**
 * One arc of a donut, pre-computed so the template only binds numbers.
 *
 * The circle is drawn with a circumference of exactly 100, so a slice's length
 * in user units *is* its percentage — no radius arithmetic in the template.
 */
export interface DonutSlice {
  name: string;
  total: number;
  /** Share of the donut's own total, 0–100. */
  pct: number;
  /** Arc length: pct less the surface gap that separates it from its neighbour. */
  len: number;
  /** Where the arc starts, as a negative dash offset. */
  offset: number;
  /**
   * Categorical slot 1–3, or 0 for the folded "Other" arc which wears the
   * de-emphasis gray. Only three slots clear the all-pairs colour gates, which
   * is why a fourth category folds rather than taking a new hue.
   */
  slot: number;
}

/** Everything the popup renders for the selected date + category filter. */
export interface TicketSummary {
  /** Distinct ticket statuses present, in a stable order (Open first). */
  statuses: string[];
  assignees: AssigneeSummary[];
  categories: CategorySummary[];
  /**
   * Where the day's threads currently sit in the pipeline, from the receipts'
   * Workflow Status column — the question the summary could not answer before.
   */
  stages: CategorySummary[];
  totalTickets: number;
  /** Counts for the KPI row, by status. */
  countByStatus: { [status: string]: number };
  /** Threads whose project has no CRM mapping, so they fell to the CRM head. */
  unmappedCount: number;
}
