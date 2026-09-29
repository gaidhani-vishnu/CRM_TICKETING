/*
    main_email_receipts.[Action Status]

    Why the thread is stopped on the step named in [Action], in the same four
    words the pipeline panel's own pills use (statusLabel() in the FE's
    workflow-visualizer.ts):

        'Done'                       - the step finished
        'Pending'                    - queued, nothing wrong yet
        'User Verification Required' - already matched, waiting on the
                                        reviewer's own confirmation
        'User Intervention'          - the step's own check came back
                                        incomplete or unmatched, or it is
                                        stopped for some other reason, e.g.
                                        blocked by an earlier step

    'User Edit Required' is retired, per the client, in favour of
    'User Intervention'; the second batch below rewrites any row that still
    holds it.

    Written by the FE (POST api/emailautomation/update-action-status), never
    computed in SQL. Blank until a thread has been opened at least once.

    Idempotent: safe to run more than once.
*/

IF NOT EXISTS (
    SELECT 1
    FROM   sys.columns
    WHERE  object_id = OBJECT_ID('dbo.main_email_receipts')
      AND  name      = 'Action Status'
)
BEGIN
    ALTER TABLE dbo.main_email_receipts
        ADD [Action Status] varchar(50) NULL;

    PRINT 'Added main_email_receipts.[Action Status].';
END
ELSE
BEGIN
    PRINT 'main_email_receipts.[Action Status] already exists.';
END
GO

UPDATE dbo.main_email_receipts
SET    [Action Status] = 'User Intervention'
WHERE  [Action Status] = 'User Edit Required';

PRINT CONCAT('Rewrote ', @@ROWCOUNT, ' row(s) from ''User Edit Required'' to ''User Intervention''.');
GO
