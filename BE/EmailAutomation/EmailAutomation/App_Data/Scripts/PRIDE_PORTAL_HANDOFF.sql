/*
    PRIDE_PORTAL_HANDOFF
    --------------------
    One row per "Create Record" press on the Email Ticketing system's Customer
    Payment Receipt tab. The ticketing backend inserts it (Status 'Issued') when
    it signs the hand-off token; the Customer Payment Portal backend moves it on:

        Issued  -> Opened    the portal redeemed the token (single use: a second
                             redeem finds it already Opened and is refused)
        Opened  -> Saved     verify-payments saved the batch; TicketNumber set
        Issued/
        Opened  -> Expired   the portal session idled out, or was closed out

    The ticketing tab polls it (GET api/customerpaymentreceipt/handoff-status)
    as the backstop for the cross-tab postMessage, so a result still reaches
    staff when the browser has cut the link between the two tabs.

    Both backends share PRIDE_NEW, so this runs once. The same script is kept in
    both projects' App_Data\Scripts. Safe to re-run.
*/

IF OBJECT_ID('dbo.PRIDE_PORTAL_HANDOFF', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PRIDE_PORTAL_HANDOFF
    (
        HandoffId         UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT PK_PRIDE_PORTAL_HANDOFF PRIMARY KEY,
        AccountItemNo     NVARCHAR(50)     NOT NULL,
        IssuedByUserId    INT              NOT NULL,
        IssuedByUsername  NVARCHAR(100)    NULL,
        IssuedAt          DATETIME2(0)     NOT NULL
            CONSTRAINT DF_PRIDE_PORTAL_HANDOFF_IssuedAt DEFAULT (SYSUTCDATETIME()),
        ExpiresAt         DATETIME2(0)     NOT NULL,
        Status            VARCHAR(10)      NOT NULL
            CONSTRAINT DF_PRIDE_PORTAL_HANDOFF_Status DEFAULT ('Issued'),
        TicketNumber      NVARCHAR(50)     NULL,
        CompletedAt       DATETIME2(0)     NULL,

        CONSTRAINT CK_PRIDE_PORTAL_HANDOFF_Status
            CHECK (Status IN ('Issued', 'Opened', 'Saved', 'Expired'))
    );
END
GO
