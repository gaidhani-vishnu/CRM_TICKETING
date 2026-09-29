/*
    dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS - keys and indexes

    The loan payment table ships as a HEAP with no index at all, and both of
    its thread columns are varchar(max), which SQL Server cannot use as an
    index key. Every read the API does against it is therefore a table scan:

        GET  api/emailautomation/receipts        - once per date, and the grid's
                                                   "All Dates" mode fires one
                                                   request per date
        GET  api/emailautomation/receipt-details - once per selected row
        POST every pipeline step                 - reads, then UPDATEs

    A scan meeting a step's UPDATE head on is exactly what SQL Server picks as
    the deadlock victim, which is why the reads are wrapped in
    ReadWithDeadlockRetry. This script removes the cause rather than the
    symptom.

    Column narrowing: 120 / 100 match PRIDE_TICKET_ACJNOWLEDGEMENT.Thread_ID
    varchar(100) and the @threadId parameter sizes the controller already
    uses. The longest values in the table today are 16 and 12 characters.

    Idempotent: safe to run more than once.

    RUN THIS BEFORE DEPLOYING THE 'Payment - Loan/Bank' CODE.
*/

-- ── Guard: refuse to narrow a column that would lose data ────────────
DECLARE @longestCustomerThread int = (
    SELECT ISNULL(MAX(LEN([Customer Thread ID])), 0)
    FROM   dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS
);
DECLARE @longestThread int = (
    SELECT ISNULL(MAX(LEN([Thread ID])), 0)
    FROM   dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS
);

PRINT CONCAT('Longest [Customer Thread ID]: ', @longestCustomerThread, ' (limit 120).');
PRINT CONCAT('Longest [Thread ID]: ', @longestThread, ' (limit 100).');

IF @longestCustomerThread > 120 OR @longestThread > 100
BEGIN
    RAISERROR('Values are longer than the intended column widths - stopping before data is truncated.', 16, 1);
    RETURN;
END
GO

-- ── The two thread columns, narrowed so they can be indexed ──────────
IF EXISTS (
    SELECT 1
    FROM   sys.columns
    WHERE  object_id = OBJECT_ID('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS')
      AND  name      = 'Customer Thread ID'
      AND  max_length = -1                      -- -1 means varchar(max)
)
BEGIN
    ALTER TABLE dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS
        ALTER COLUMN [Customer Thread ID] varchar(120) NULL;

    PRINT 'Narrowed [Customer Thread ID] to varchar(120).';
END
ELSE
BEGIN
    PRINT '[Customer Thread ID] is already indexable.';
END
GO

IF EXISTS (
    SELECT 1
    FROM   sys.columns
    WHERE  object_id = OBJECT_ID('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS')
      AND  name      = 'Thread ID'
      AND  max_length = -1
)
BEGIN
    ALTER TABLE dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS
        ALTER COLUMN [Thread ID] varchar(100) NULL;

    PRINT 'Narrowed [Thread ID] to varchar(100).';
END
ELSE
BEGIN
    PRINT '[Thread ID] is already indexable.';
END
GO

/*
    The row key. Every payment-level write keys on
    [Email Receipts Details ID] + [Customer Thread ID], so the identity
    column earns the clustered index.
*/
IF NOT EXISTS (
    SELECT 1
    FROM   sys.indexes
    WHERE  object_id = OBJECT_ID('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS')
      AND  name      = 'CIX_PRIDE_LOAN_DETAILS_Id'
)
BEGIN
    CREATE UNIQUE CLUSTERED INDEX CIX_PRIDE_LOAN_DETAILS_Id
        ON dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS ([Email Receipts Details ID]);

    PRINT 'Created CIX_PRIDE_LOAN_DETAILS_Id.';
END
ELSE
BEGIN
    PRINT 'CIX_PRIDE_LOAN_DETAILS_Id already exists.';
END
GO

/*
    One customer thread's payments - what receipt-details reads and what
    every thread-level write keys on. [Payment No] is INCLUDEd because the
    reads order by it to pick the anchor row.
*/
IF NOT EXISTS (
    SELECT 1
    FROM   sys.indexes
    WHERE  object_id = OBJECT_ID('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS')
      AND  name      = 'IX_PRIDE_LOAN_DETAILS_CustomerThread'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_PRIDE_LOAN_DETAILS_CustomerThread
        ON dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS ([Customer Thread ID])
        INCLUDE ([Thread ID], [Payment No]);

    PRINT 'Created IX_PRIDE_LOAN_DETAILS_CustomerThread.';
END
ELSE
BEGIN
    PRINT 'IX_PRIDE_LOAN_DETAILS_CustomerThread already exists.';
END
GO

/*
    All customer threads of a parent email - what the grid's expansion reads
    once per date to turn one loan receipt row into one row per customer.
*/
IF NOT EXISTS (
    SELECT 1
    FROM   sys.indexes
    WHERE  object_id = OBJECT_ID('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS')
      AND  name      = 'IX_PRIDE_LOAN_DETAILS_Thread'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_PRIDE_LOAN_DETAILS_Thread
        ON dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS ([Thread ID])
        INCLUDE ([Customer Thread ID]);

    PRINT 'Created IX_PRIDE_LOAN_DETAILS_Thread.';
END
ELSE
BEGIN
    PRINT 'IX_PRIDE_LOAN_DETAILS_Thread already exists.';
END
GO
