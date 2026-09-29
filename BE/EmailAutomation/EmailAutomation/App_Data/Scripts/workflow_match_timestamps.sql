/*
    When each Workflow Pipeline match step decided - [<step> Match Date]

    What
    ----
    The four match steps record what they decided but not when. These columns
    hold the moment each verdict was reached, written by the same UPDATE that
    writes the verdict itself (MatchStampColumns in EmailAutomationController),
    so a verdict and its timestamp can never describe different runs.

        [Customer Email Match]  ->  [Customer Email Match Date]     node 2
        [Unit Match]            ->  [Unit Match Date]               node 3
        [Instrument Match]      ->  [Instrument Match Date]         node 4
        [Bank Reco Match]       ->  [Bank Reco Match Date]          node 5

    Which tables, and why eight columns for four steps
    --------------------------------------------------
    A thread binds to one set of tables or the other, never both - see
    ResolveBinding. A classic thread keeps its two thread-level verdicts on
    main_email_receipts and its two payment-level ones on
    main_email_receipt_details. A loan customer thread has no receipts row of
    its own, so ALL FOUR of its verdicts are written to its payment rows in
    PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS - which is why that table needs all
    four stamps and the other two need only their own pair.

    Stamped on every run, matched or not, and overwritten when a step is re-run,
    so the column reads "this step last decided at". NULL therefore means the
    step has not run at all, which is why there is deliberately NO DEFAULT: one
    would backdate every existing row to the moment this script was executed.

    datetime, written by GETDATE(), to match how every other timestamp in this
    system is stamped - Created_Date and SLA_Closed_On on the ticket table, and
    UpdateDateTime on the audit log. One clock, the database's.

    RUN THIS BEFORE DEPLOYING THE API.
    The verdict and the stamp are set by one statement, so against the old
    schema every verdict write fails with "Invalid column name" - and that is
    all four steps, not one. There is no half-working state to fall back to.

    Idempotent: safe to run more than once.
*/

SET NOCOUNT ON;
GO

DECLARE @adds TABLE
(
    TableName  sysname,
    ColumnName sysname
);

INSERT INTO @adds (TableName, ColumnName)
VALUES
    -- Classic thread: thread-level verdicts live on the receipts row.
    ('dbo.main_email_receipts',                   'Customer Email Match Date'),
    ('dbo.main_email_receipts',                   'Unit Match Date'),

    -- Classic thread: payment-level verdicts live on the payment rows.
    ('dbo.main_email_receipt_details',            'Instrument Match Date'),
    ('dbo.main_email_receipt_details',            'Bank Reco Match Date'),

    -- Loan thread: no receipts row of its own, so all four land here.
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Customer Email Match Date'),
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Unit Match Date'),
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Instrument Match Date'),
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Bank Reco Match Date');

DECLARE @table  sysname;
DECLARE @column sysname;
DECLARE @sql    nvarchar(max);

DECLARE adds CURSOR LOCAL FAST_FORWARD FOR
    SELECT TableName, ColumnName FROM @adds;

OPEN adds;
FETCH NEXT FROM adds INTO @table, @column;

WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(@table) IS NULL
    BEGIN
        -- Not an error: a site that has never handled loan email has no loan
        -- table, and the classic tables are equally optional in principle.
        PRINT CONCAT('SKIPPED ', @table, '.[', @column, ']: table does not exist.');
    END
    ELSE IF EXISTS (SELECT 1 FROM sys.columns
                    WHERE object_id = OBJECT_ID(@table) AND name = @column)
    BEGIN
        PRINT CONCAT(@table, '.[', @column, '] already exists.');
    END
    ELSE
    BEGIN
        SET @sql = CONCAT('ALTER TABLE ', @table,
                          ' ADD ', QUOTENAME(@column), ' datetime NULL;');

        EXEC sp_executesql @sql;

        PRINT CONCAT('Added ', @table, '.[', @column, '].');
    END

    FETCH NEXT FROM adds INTO @table, @column;
END

CLOSE adds;
DEALLOCATE adds;
GO

-- ── What landed ──────────────────────────────────────────────────────
SELECT  TABLE_NAME  AS TableName,
        COLUMN_NAME AS ColumnName,
        DATA_TYPE   AS DataType,
        IS_NULLABLE AS IsNullable
FROM    INFORMATION_SCHEMA.COLUMNS
WHERE   COLUMN_NAME LIKE '%Match Date'
ORDER BY TABLE_NAME, COLUMN_NAME;
GO
