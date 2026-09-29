/*
    The Agreement Workflow's thirteen steps - verdict + stamp, per step

    What
    ----
    A Non-Payment thread whose Intent and Sub-Intent are both 'Agreement' runs a
    thirteen-stage back-office process between Unit Match (or, for a system-raised
    thread, the ticket itself) and the reply that ends it. Each stage records one
    verdict and the moment it was reached, exactly as the four original match
    steps do:

        [Booking_KYC_Verification]       ->  [Booking_KYC_Verification_Date]
        [Agreement_Drafting]             ->  [Agreement_Drafting_Date]
        [SDR_BSL_Coordination]           ->  [SDR_BSL_Coordination_Date]
        [Agreement_Approval]             ->  [Agreement_Approval_Date]
        [Payment_ERP_Update]             ->  [Payment_ERP_Update_Date]
        [Document_Preparation]           ->  [Document_Preparation_Date]
        [Agreement_Execution]            ->  [Agreement_Execution_Date]
        [Stamp_Duty_Challan]             ->  [Stamp_Duty_Challan_Date]
        [Registration_Data_Processing]   ->  [Registration_Data_Processing_Date]
        [Registration_Scheduling]        ->  [Registration_Scheduling_Date]
        [HO_Signature_Process]           ->  [HO_Signature_Process_Date]
        [Registration_Appointment]       ->  [Registration_Appointment_Date]
        [Ghoshvara_Verification]         ->  [Ghoshvara_Verification_Date]

    The verdict holds 'Match' / 'Unmatch', the same two words every other step
    on this table writes, so MatchStampColumns in EmailAutomationController can
    stamp these with GETDATE() from the same UPDATE without any new code - a
    verdict and its timestamp can never describe different runs.

    Naming
    ------
    snake_case, no spaces, deliberately unlike the older [Unit Match Date] on
    this same table. New columns follow the new convention; the legacy ones are
    left exactly as they are rather than renamed, because every existing read
    and write names them as they stand. AgreementSteps in the controller is the
    one place these spellings live on the backend - the read list, the writable
    whitelist and the stamp map are all built from it.

    Which table, and why only one
    -----------------------------
    Thread-level only, so main_email_receipts alone. The gate requires a
    Non-Payment category, and a loan customer thread - the one kind with no
    receipts row of its own - is never Non-Payment, so
    PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS needs none of these.

    NULL means the step has not run, which is why there is deliberately NO
    DEFAULT on either column of a pair: a default would backdate every existing
    row to the moment this script was executed, and would claim thirteen steps
    had a verdict on threads that never ran one.

    datetime, written by GETDATE(), to match how every other timestamp in this
    system is stamped. One clock, the database's.

    RUN THIS BEFORE DEPLOYING THE API.
    The verdict and the stamp are set by one statement, so against the old
    schema every agreement-step write fails with "Invalid column name" - and
    that is all thirteen steps, not one. There is no half-working state to fall
    back to.

    Idempotent: safe to run more than once.
*/

SET NOCOUNT ON;
GO

DECLARE @steps TABLE
(
    Ordinal    int,
    ColumnName sysname
);

INSERT INTO @steps (Ordinal, ColumnName)
VALUES
    ( 1, 'Booking_KYC_Verification'),
    ( 2, 'Agreement_Drafting'),
    ( 3, 'SDR_BSL_Coordination'),
    ( 4, 'Agreement_Approval'),
    ( 5, 'Payment_ERP_Update'),
    ( 6, 'Document_Preparation'),
    ( 7, 'Agreement_Execution'),
    ( 8, 'Stamp_Duty_Challan'),
    ( 9, 'Registration_Data_Processing'),
    (10, 'Registration_Scheduling'),
    (11, 'HO_Signature_Process'),
    (12, 'Registration_Appointment'),
    (13, 'Ghoshvara_Verification');

DECLARE @table sysname = 'dbo.main_email_receipts';

IF OBJECT_ID(@table) IS NULL
BEGIN
    RAISERROR('%s does not exist - nothing to alter.', 16, 1, @table);
END
ELSE
BEGIN
    DECLARE @column sysname;
    DECLARE @sql    nvarchar(max);

    -- The verdict and then its stamp, stage by stage, so the PRINT log reads
    -- in the order the pipeline runs rather than alphabetically.
    DECLARE adds CURSOR LOCAL FAST_FORWARD FOR
        SELECT ColumnName FROM
        (
            SELECT Ordinal, 1 AS Part, ColumnName            FROM @steps
            UNION ALL
            SELECT Ordinal, 2 AS Part, ColumnName + '_Date'  FROM @steps
        ) AS ordered
        ORDER BY Ordinal, Part;

    OPEN adds;
    FETCH NEXT FROM adds INTO @column;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        IF EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id = OBJECT_ID(@table) AND name = @column)
        BEGIN
            PRINT CONCAT(@table, '.[', @column, '] already exists.');
        END
        ELSE
        BEGIN
            -- varchar(50) for a verdict, datetime for its stamp. The two are
            -- told apart by the suffix, which is the only thing that differs.
            SET @sql = CONCAT('ALTER TABLE ', @table,
                              ' ADD ', QUOTENAME(@column), ' ',
                              CASE WHEN @column LIKE '%[_]Date'
                                   THEN 'datetime NULL'
                                   ELSE 'varchar(50) NULL'
                              END, ';');

            EXEC sp_executesql @sql;

            PRINT CONCAT('Added ', @table, '.[', @column, '].');
        END

        FETCH NEXT FROM adds INTO @column;
    END

    CLOSE adds;
    DEALLOCATE adds;
END
GO

-- ── What landed ──────────────────────────────────────────────────────
-- Twenty-six rows, and none of them with a space in the name.
SELECT  c.name                     AS ColumnName,
        t.name                     AS DataType,
        c.max_length               AS MaxLength,
        c.is_nullable              AS IsNullable
FROM    sys.columns c
JOIN    sys.types   t ON t.user_type_id = c.user_type_id
WHERE   c.object_id = OBJECT_ID('dbo.main_email_receipts')
  AND   c.name IN
        (
            'Booking_KYC_Verification',          'Booking_KYC_Verification_Date',
            'Agreement_Drafting',                'Agreement_Drafting_Date',
            'SDR_BSL_Coordination',              'SDR_BSL_Coordination_Date',
            'Agreement_Approval',                'Agreement_Approval_Date',
            'Payment_ERP_Update',                'Payment_ERP_Update_Date',
            'Document_Preparation',              'Document_Preparation_Date',
            'Agreement_Execution',               'Agreement_Execution_Date',
            'Stamp_Duty_Challan',                'Stamp_Duty_Challan_Date',
            'Registration_Data_Processing',      'Registration_Data_Processing_Date',
            'Registration_Scheduling',           'Registration_Scheduling_Date',
            'HO_Signature_Process',              'HO_Signature_Process_Date',
            'Registration_Appointment',          'Registration_Appointment_Date',
            'Ghoshvara_Verification',            'Ghoshvara_Verification_Date'
        )
ORDER BY c.name;
GO
