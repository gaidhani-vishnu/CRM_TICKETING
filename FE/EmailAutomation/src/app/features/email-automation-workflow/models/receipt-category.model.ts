/**
 * Which [Category] values the workspace counts as workload.
 *
 * One rule, shared: the Email Receipts grid filters its rows through it and
 * the KPI ribbon filters its tickets through it, so the count beside "Email
 * Receipts" and the ribbon's Open figure are always drawn from the same
 * population. They used to disagree — the ribbon counted every category the
 * classifier writes while the grid showed only these — and the two numbers on
 * one screen never matched.
 *
 * In today's data this excludes exactly "Payment - Unverified". It is written
 * as an allow-list rather than as that one name so a category nobody has seen
 * yet is left out of both places at once, rather than slipping into one of them
 * and reopening the mismatch.
 *
 * "Payment - Loan/Bank" is listed, but a row of it is not an email: one loan
 * email covers many customers, and the backend lists one row per customer
 * (PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS.[Customer Thread ID]) in place of the
 * email they share, each with its own ticket. Nothing here has to know that —
 * such a row arrives with its threadId already set to the customer — but the
 * count beside "Email Receipts" counts customers for these, not emails.
 *
 * "Non-Payment" was split into "Non-Payment - Customer" and
 * "Non-Payment - System", and both are listed so both reach the grid. Being
 * listed only makes a thread *visible*, though — it is not what gives it the
 * non-payment pipeline. That still belongs to the Customer half alone:
 * isNonPaymentThread() in workflow-visualizer.ts and
 * IsNonPaymentCustomerCategory() in EmailAutomationController.cs both match
 * "Non-Payment - Customer" and nothing else, so a System thread lists without
 * inheriting a workflow that was never written for it — including the thirteen
 * agreement stages, which are gated on the Customer half only.
 */
const LISTED_CATEGORIES = new Set([
  'non-payment - customer',
  'non-payment - system',
  'payment - customer',
  'payment - loan/bank',
]);

/** True when a thread's [Category] is one the workspace counts. */
export function isListedCategory(category: string | undefined | null): boolean {
  return LISTED_CATEGORIES.has((category || '').trim().toLowerCase());
}
