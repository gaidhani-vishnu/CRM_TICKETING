/*
    Clears [<step> Match Date] on any row whose verdict is not a match.

    Why
    ---
    A stamp is only ever written for a match, so a date beside an Unmatch is a
    stale reading - the step matched once, then a later run disagreed. The
    update helpers deliberately do not clear it themselves: at the moment a run
    comes back Unmatch, nothing in the request is in a position to say the
    earlier match never happened, and blanking it there would quietly destroy
    the one record of it.

    Run this when the UI should show no date against an unmatched row:

      * ONCE after deploying the first build of this feature. An earlier build
        stamped on every run, matched or not, so unmatched rows carry a date
        that was never a match. That is what this script was written for.
      * Whenever else a verdict has turned back to Unmatch and the stale date
        is not wanted.

    Reports how many rows each pair touched, so a second run printing all
    zeroes is the proof it is finished.

    Only ever sets a stamp to NULL - no verdict is read back, rewritten, or
    otherwise changed.

    Idempotent: safe to run more than once.
*/

SET NOCOUNT ON;
GO

DECLARE @pairs TABLE
(
    TableName     sysname,
    VerdictColumn sysname,
    StampColumn   sysname
);

INSERT INTO @pairs (TableName, VerdictColumn, StampColumn)
VALUES
    -- Classic thread: thread-level verdicts on the receipts row.
    ('dbo.main_email_receipts',                   'Customer Email Match', 'Customer Email Match Date'),
    ('dbo.main_email_receipts',                   'Unit Match',           'Unit Match Date'),

    -- Classic thread: payment-level verdicts on the payment rows.
    ('dbo.main_email_receipt_details',            'Instrument Match',     'Instrument Match Date'),
    ('dbo.main_email_receipt_details',            'Bank Reco Match',      'Bank Reco Match Date'),

    -- Loan thread: no receipts row of its own, so all four live here.
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Customer Email Match', 'Customer Email Match Date'),
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Unit Match',           'Unit Match Date'),
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Instrument Match',     'Instrument Match Date'),
    ('dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS', 'Bank Reco Match',      'Bank Reco Match Date');

DECLARE @table   sysname;
DECLARE @verdict sysname;
DECLARE @stamp   sysname;
DECLARE @sql     nvarchar(max);
DECLARE @cleared int;

DECLARE pairs CURSOR LOCAL FAST_FORWARD FOR
    SELECT TableName, VerdictColumn, StampColumn FROM @pairs;

OPEN pairs;
FETCH NEXT FROM pairs INTO @table, @verdict, @stamp;

WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(@table) IS NULL
        PRINT CONCAT('SKIPPED ', @table, ': table does not exist.');
    ELSE IF NOT EXISTS (SELECT 1 FROM sys.columns
                        WHERE object_id = OBJECT_ID(@table) AND name = @stamp)
        PRINT CONCAT('SKIPPED ', @table, '.[', @stamp,
                     ']: column does not exist - run workflow_match_timestamps.sql first.');
    ELSE
    BEGIN
        /*
            A NULL verdict counts as "not matched": the step has not run, so
            there is nothing for a stamp to be describing.

            LTRIM/RTRIM because these columns are free text, and a value that
            arrived with a stray space should not be read as a match.
        */
        SET @sql = CONCAT(
            'UPDATE ', @table,
            ' SET ', QUOTENAME(@stamp), ' = NULL',
            ' WHERE ', QUOTENAME(@stamp), ' IS NOT NULL',
            '   AND (', QUOTENAME(@verdict), ' IS NULL',
            '        OR LTRIM(RTRIM(', QUOTENAME(@verdict), ')) <> ''Match'');',
            ' SET @out = @@ROWCOUNT;');

        EXEC sp_executesql @sql, N'@out int OUTPUT', @out = @cleared OUTPUT;

        PRINT CONCAT('Cleared ', @cleared, ' stale stamp(s) in ',
                     @table, '.[', @stamp, '].');
    END

    FETCH NEXT FROM pairs INTO @table, @verdict, @stamp;
END

CLOSE pairs;
DEALLOCATE pairs;
GO

/*
    What is left. Every row listed here has a stamp AND a matching verdict,
    which is the only combination that should survive.
*/
SELECT 'main_email_receipts' AS TableName,
       SUM(CASE WHEN [Customer Email Match Date] IS NOT NULL THEN 1 ELSE 0 END) AS CustomerEmailStamped,
       SUM(CASE WHEN [Unit Match Date]           IS NOT NULL THEN 1 ELSE 0 END) AS UnitStamped
FROM   dbo.main_email_receipts;
GO
