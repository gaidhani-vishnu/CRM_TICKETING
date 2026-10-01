/*
    Project / Sub Project / Unit index for the Customer Payment Receipt tab
    -----------------------------------------------------------------------
    The tab's cascading lists (CustomerPaymentReceiptController: projects,
    subprojects, units, customers, bookings) each ask SALES_BOOKING_DETAILS for
    DISTINCT values filtered by PROJECT_NAME, then SUBPROJECT_NAME, then UNIT_NO.
    Without an index on those columns every one of them reads the whole master.

    Optional, but recommended. Run once against PRIDE_NEW. Safe to re-run.

    If SALES_BOOKING_DETAILS is a view this does nothing, by design — see the note
    in SALES_BOOKING_DETAILS_email_indexes.sql.
*/

IF OBJECTPROPERTY(OBJECT_ID('dbo.SALES_BOOKING_DETAILS'), 'IsTable') = 1
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name = 'IX_SALES_BOOKING_DETAILS_PROJECT_UNIT'
                     AND object_id = OBJECT_ID('dbo.SALES_BOOKING_DETAILS'))
    BEGIN
        CREATE NONCLUSTERED INDEX IX_SALES_BOOKING_DETAILS_PROJECT_UNIT
            ON dbo.SALES_BOOKING_DETAILS (PROJECT_NAME, SUBPROJECT_NAME, UNIT_NO)
            INCLUDE (BOOKING_STATUS_NAME, ACCOUNT_ITEM_NO, CUST_TITLE, CUST_FNAME, LAST_NAME);
    END
END
GO
