-- =====================================================================
-- 002_user_master_emails.sql
--
-- Data only: sets PRIDE_USER_MASTER.Email to the mailbox each CRM user's
-- tickets actually carry in main_email_receipts.[Assigned To] (the same
-- addresses config.json's users[] lists). The UI maps [Assigned To] back to
-- EmployeeName through GET api/usermaster/users, and decides which tickets a
-- Pre_User / Pos_User may see by matching it against their own Email — so a
-- user whose Email is blank or wrong shows as a raw address and sees nothing.
--
-- No schema change. Idempotent: each UPDATE only touches a row whose Email
-- differs, so running this again is a no-op.
-- Run against PRIDE_NEW (the DB named by "myConnection" in Web.config).
-- =====================================================================

SET NOCOUNT ON;
GO

UPDATE PRIDE_USER_MASTER SET Email = 'CRMHEAD@PRIDEWORLDCITY.COM', ModifiedDate = GETDATE()
WHERE Username = 'namrata' AND ISNULL(Email, '') <> 'CRMHEAD@PRIDEWORLDCITY.COM';
GO

UPDATE PRIDE_USER_MASTER SET Email = 'CRM@PRIDEWORLDCITY.COM', ModifiedDate = GETDATE()
WHERE Username = 'nikita' AND ISNULL(Email, '') <> 'CRM@PRIDEWORLDCITY.COM';
GO

UPDATE PRIDE_USER_MASTER SET Email = 'CRM3@PRIDEWORLDCITY.COM', ModifiedDate = GETDATE()
WHERE Username = 'sonal' AND ISNULL(Email, '') <> 'CRM3@PRIDEWORLDCITY.COM';
GO

UPDATE PRIDE_USER_MASTER SET Email = 'CRM11@PRIDEWORLDCITY.COM', ModifiedDate = GETDATE()
WHERE Username = 'amit' AND ISNULL(Email, '') <> 'CRM11@PRIDEWORLDCITY.COM';
GO

UPDATE PRIDE_USER_MASTER SET Email = 'CRM5@PRIDEWORLDCITY.COM', ModifiedDate = GETDATE()
WHERE Username = 'princ.jain' AND ISNULL(Email, '') <> 'CRM5@PRIDEWORLDCITY.COM';
GO
