/*
    Auto-check queue + Pending Step backfill

    What
    ----
    1. dbo.usp_GetAutoCheckQueue - the threads the hourly auto-check run
       (POST api/emailautomation/auto-check, AutoCheck in
       EmailAutomationController) works through:

         - the thread has an Open ticket in PRIDE_TICKET_ACJNOWLEDGEMENT, and
         - its [Workflow Status] waits on one of the four automatic steps
           (Customer Email Match, Unit Match, Instrument Match, Bank
           Reconciliation) or is still blank, and
         - it has not been parked for a reviewer ([Action Status] is not
           'User Intervention'). A reviewer resolving the step in the UI
           rewrites [Action Status], which puts the thread back in the queue.

       Oldest ticket first. Only picks - every check itself runs in the API,
       because Instrument Match and Bank Reconciliation read the bank statement
       workbooks on disk, which T-SQL cannot.

       A ticket's Thread_ID is a main_email_receipts.[Thread ID] (matched on
       the ticket's [Date] = [Email Date], the same scoping every write uses),
       or for 'Payment - Loan/Bank' a PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS
       .[Customer Thread ID] - the same split ResolveBinding makes. A loan
       email's own receipts row is never queued: its tickets are per customer.

    2. One-off backfill: open tickets raised before acknowledge-tickets began
       seeding [Workflow Status] show a blank Pending Step in the grid. They
       are set to 'Pending Customer Email Match' / Action 'Customer Email Match'
       / Action Status 'Pending' ('Pending Email Response' for Non-Payment -
       System threads, which have no Customer Email Match step). Only blank
       rows are touched.

    Idempotent: safe to run more than once.
*/

SET NOCOUNT ON;
GO

IF OBJECT_ID('dbo.usp_GetAutoCheckQueue', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_GetAutoCheckQueue;
GO

CREATE PROCEDURE dbo.usp_GetAutoCheckQueue
AS
BEGIN
    SET NOCOUNT ON;

    SELECT   t.Thread_ID,
             t.Ticket_ID,
             t.[Date] AS EmailDate,
             t.Created_Date,
             COALESCE(r.WorkflowStatus, l.WorkflowStatus) AS WorkflowStatus
    FROM     dbo.PRIDE_TICKET_ACJNOWLEDGEMENT AS t
    OUTER APPLY
    (
        SELECT TOP 1
               LTRIM(RTRIM(ISNULL(x.[Workflow Status], ''))) AS WorkflowStatus,
               LTRIM(RTRIM(ISNULL(x.[Action Status], '')))   AS ActionStatus
        FROM   dbo.main_email_receipts AS x
        WHERE  x.[Thread ID]  = t.Thread_ID
          AND  x.[Email Date] = t.[Date]
          AND  ISNULL(x.Category, '') <> 'Payment - Loan/Bank'
    ) AS r
    OUTER APPLY
    (
        SELECT TOP 1
               LTRIM(RTRIM(ISNULL(y.[Workflow Status], ''))) AS WorkflowStatus,
               LTRIM(RTRIM(ISNULL(y.[Action Status], '')))   AS ActionStatus
        FROM   dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS AS y
        WHERE  y.[Customer Thread ID] = t.Thread_ID
        -- A customer's thread-level columns hold the same value on each of its
        -- payment rows; prefer one that says something.
        ORDER BY CASE WHEN ISNULL(y.[Workflow Status], '') = '' THEN 1 ELSE 0 END
    ) AS l
    WHERE    t.Ticket_Status = 'Open'
      AND   (r.WorkflowStatus IS NOT NULL OR l.WorkflowStatus IS NOT NULL)
      AND    COALESCE(r.WorkflowStatus, l.WorkflowStatus) IN
             ('', 'N/A', 'Pending Customer Email Match', 'Pending Unit Match',
              'Pending Instrument Match', 'Pending Bank Reconciliation')
      AND    COALESCE(r.ActionStatus, l.ActionStatus) NOT IN
             ('User Intervention', 'User Edit Required')
    ORDER BY t.Created_Date, t.Ticket_ID;
END
GO

-- ── Backfill: blank Pending Step on open tickets ─────────────────────

-- Look first.
SELECT   t.Ticket_ID, t.Thread_ID, r.Category, r.[Workflow Status], r.[Action], r.[Action Status]
FROM     dbo.PRIDE_TICKET_ACJNOWLEDGEMENT AS t
JOIN     dbo.main_email_receipts           AS r
         ON r.[Thread ID] = t.Thread_ID AND r.[Email Date] = t.[Date]
WHERE    t.Ticket_Status = 'Open'
  AND    ISNULL(LTRIM(RTRIM(r.[Workflow Status])), '') = ''
  AND    ISNULL(r.Category, '') <> 'Payment - Loan/Bank'
ORDER BY t.Ticket_ID;
GO

-- Classic threads.
UPDATE r
SET    r.[Workflow Status] = CASE WHEN r.Category = 'Non-Payment - System'
                                  THEN 'Pending Email Response'
                                  ELSE 'Pending Customer Email Match' END,
       r.[Action]          = CASE WHEN r.Category = 'Non-Payment - System'
                                  THEN 'Email Response'
                                  ELSE 'Customer Email Match' END,
       r.[Action Status]   = 'Pending'
FROM   dbo.main_email_receipts           AS r
JOIN   dbo.PRIDE_TICKET_ACJNOWLEDGEMENT AS t
       ON t.Thread_ID = r.[Thread ID] AND t.[Date] = r.[Email Date]
WHERE  t.Ticket_Status = 'Open'
  AND  ISNULL(LTRIM(RTRIM(r.[Workflow Status])), '') = ''
  AND  ISNULL(r.Category, '') <> 'Payment - Loan/Bank';

PRINT CONCAT('main_email_receipts rows seeded: ', @@ROWCOUNT);
GO

-- Loan customer threads (every payment row of the customer carries the value).
IF OBJECT_ID('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS') IS NOT NULL
BEGIN
    UPDATE y
    SET    y.[Workflow Status] = 'Pending Customer Email Match',
           y.[Action]          = 'Customer Email Match',
           y.[Action Status]   = 'Pending'
    FROM   dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS AS y
    JOIN   dbo.PRIDE_TICKET_ACJNOWLEDGEMENT          AS t
           ON t.Thread_ID = y.[Customer Thread ID]
    WHERE  t.Ticket_Status = 'Open'
      AND  NOT EXISTS (SELECT 1
                       FROM   dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS AS z
                       WHERE  z.[Customer Thread ID] = y.[Customer Thread ID]
                         AND  ISNULL(LTRIM(RTRIM(z.[Workflow Status])), '') <> '');

    PRINT CONCAT('Loan payment rows seeded: ', @@ROWCOUNT);
END
GO

-- ── What the run will pick up ────────────────────────────────────────
EXEC dbo.usp_GetAutoCheckQueue;
GO
