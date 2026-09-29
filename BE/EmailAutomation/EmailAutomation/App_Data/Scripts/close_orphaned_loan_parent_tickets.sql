/*
    One-off cleanup: close the parent-level tickets of 'Payment - Loan/Bank'
    threads.

    Until this release acknowledge-tickets was category-blind: it minted one
    ticket per main_email_receipts.[Thread ID], loan threads included. A loan
    email is now ticketed per customer instead - one ticket per
    PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS.[Customer Thread ID] - and the
    parent thread is no longer listed in the grid at all.

    That leaves the old parent tickets Open against a Thread ID nobody can
    open. The dashboard drops them (its join finds no matching row), but
    MarkOverdueTickets keeps sweeping them to 'Overdue' every time a date is
    selected.

    RUN THIS ONLY AFTER the new per-customer tickets exist and have been
    checked - see the verification steps below. Closing these first would not
    break anything, but it would hide the evidence that the new ones were
    minted correctly.

    Idempotent: safe to run more than once (it only touches Open rows).
*/

-- ── 1. Look before you write: the parent tickets still Open ──────────
SELECT   t.Ticket_ID,
         t.Thread_ID,
         t.Ticket_Status,
         t.SLA_Status,
         t.Created_Date,
         r.Category
FROM     dbo.PRIDE_TICKET_ACJNOWLEDGEMENT AS t
JOIN     dbo.main_email_receipts           AS r ON r.[Thread ID] = t.Thread_ID
WHERE    t.Ticket_Status = 'Open'
  AND    r.Category      = 'Payment - Loan/Bank'
  -- A parent thread, not one of the new per-customer tickets: the customer
  -- threads are '<Thread ID>-<n>' and have no receipts row of their own,
  -- so the JOIN above already excludes them.
ORDER BY t.Ticket_ID;

-- ── 2. And the per-customer tickets that replace them ────────────────
SELECT   t.Thread_ID, t.Ticket_ID, t.Ticket_Status, t.Created_Date
FROM     dbo.PRIDE_TICKET_ACJNOWLEDGEMENT AS t
WHERE    EXISTS (
             SELECT 1
             FROM   dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS AS d
             WHERE  d.[Customer Thread ID] = t.Thread_ID
         )
ORDER BY t.Thread_ID;

-- ── 3. Close the parents ─────────────────────────────────────────────
/*
    Same shape as CloseTicket() in EmailAutomationController.cs: SLA_Status
    settles to 'Met' or 'Overdue' against the ticket's own deadline rather
    than being left mid-flight, so a closed row still reads correctly in the
    SLA report.
*/
UPDATE   t
SET      t.Ticket_Status = 'Closed',
         t.SLA_Closed_On = GETDATE(),
         t.SLA_Status    = CASE
                               WHEN t.Created_Date IS NULL THEN t.SLA_Status
                               WHEN DATEADD(HOUR, 24, t.Created_Date) >= GETDATE() THEN 'Met'
                               ELSE 'Overdue'
                           END
FROM     dbo.PRIDE_TICKET_ACJNOWLEDGEMENT AS t
JOIN     dbo.main_email_receipts           AS r ON r.[Thread ID] = t.Thread_ID
WHERE    t.Ticket_Status = 'Open'
  AND    r.Category      = 'Payment - Loan/Bank';

PRINT CONCAT('Closed ', @@ROWCOUNT, ' orphaned parent-level loan ticket(s).');
GO
