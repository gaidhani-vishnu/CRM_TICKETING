-- =====================================================================
-- 001_auth_role_user_master.sql
--
-- Phase 1 login: adds PRIDE_ROLE_MASTER / PRIDE_USER_MASTER and seeds the
-- five roles and six users the CRM org chart starts with. Nothing else in
-- the database is touched — no stage tables, no changes to the existing
-- main_email_receipts / SALES_BOOKING_DETAILS etc.
--
-- Idempotent: every CREATE and every INSERT is guarded by an existence
-- check, so running this script again (same DB, same script) is a no-op.
-- Run against PRIDE_NEW (the DB named by the "myConnection" connection
-- string in Web.config).
-- =====================================================================

SET NOCOUNT ON;
GO

-- ── PRIDE_ROLE_MASTER ────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PRIDE_ROLE_MASTER')
BEGIN
    CREATE TABLE PRIDE_ROLE_MASTER
    (
        RoleID          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PRIDE_ROLE_MASTER PRIMARY KEY,
        RoleName        NVARCHAR(100) NOT NULL,
        RoleLevel       INT NOT NULL,
        ParentRoleID    INT NULL,
        CanManageUsers  BIT NOT NULL CONSTRAINT DF_PRIDE_ROLE_MASTER_CanManageUsers DEFAULT (0),
        IsActive        BIT NOT NULL CONSTRAINT DF_PRIDE_ROLE_MASTER_IsActive DEFAULT (1),
        CONSTRAINT UQ_PRIDE_ROLE_MASTER_RoleName UNIQUE (RoleName),
        CONSTRAINT FK_PRIDE_ROLE_MASTER_ParentRoleID FOREIGN KEY (ParentRoleID) REFERENCES PRIDE_ROLE_MASTER (RoleID)
    );
END
GO

-- ── PRIDE_USER_MASTER ────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PRIDE_USER_MASTER')
BEGIN
    CREATE TABLE PRIDE_USER_MASTER
    (
        UserID          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PRIDE_USER_MASTER PRIMARY KEY,
        Username        NVARCHAR(100) NOT NULL,
        PasswordHash    NVARCHAR(500) NULL,
        EmployeeName    NVARCHAR(100) NOT NULL,
        Email           NVARCHAR(200) NULL,
        RoleID          INT NULL,
        ParentUserID    INT NULL,
        IsActive        BIT NOT NULL CONSTRAINT DF_PRIDE_USER_MASTER_IsActive DEFAULT (1),
        CreatedDate     DATETIME NOT NULL CONSTRAINT DF_PRIDE_USER_MASTER_CreatedDate DEFAULT (GETDATE()),
        CreatedBy       INT NULL,
        ModifiedDate    DATETIME NULL,
        ModifiedBy      INT NULL,
        LastLoginDate   DATETIME NULL,
        CONSTRAINT UQ_PRIDE_USER_MASTER_Username UNIQUE (Username),
        CONSTRAINT CK_PRIDE_USER_MASTER_ParentNotSelf CHECK (ParentUserID <> UserID),
        CONSTRAINT FK_PRIDE_USER_MASTER_RoleID FOREIGN KEY (RoleID) REFERENCES PRIDE_ROLE_MASTER (RoleID),
        CONSTRAINT FK_PRIDE_USER_MASTER_ParentUserID FOREIGN KEY (ParentUserID) REFERENCES PRIDE_USER_MASTER (UserID)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PRIDE_USER_MASTER_RoleID' AND object_id = OBJECT_ID('PRIDE_USER_MASTER'))
BEGIN
    CREATE INDEX IX_PRIDE_USER_MASTER_RoleID ON PRIDE_USER_MASTER (RoleID);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PRIDE_USER_MASTER_ParentUserID' AND object_id = OBJECT_ID('PRIDE_USER_MASTER'))
BEGIN
    CREATE INDEX IX_PRIDE_USER_MASTER_ParentUserID ON PRIDE_USER_MASTER (ParentUserID);
END
GO

-- ── Role seed ────────────────────────────────────────────────────────
-- Org chart: Admin -> Post_Admin -> {Pre_Admin, Pos_User} ; Pre_Admin -> Pre_User

IF NOT EXISTS (SELECT 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Admin')
    INSERT INTO PRIDE_ROLE_MASTER (RoleName, RoleLevel, ParentRoleID, CanManageUsers, IsActive)
    VALUES ('Admin', 1, NULL, 1, 1);
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Post_Admin')
    INSERT INTO PRIDE_ROLE_MASTER (RoleName, RoleLevel, ParentRoleID, CanManageUsers, IsActive)
    SELECT 'Post_Admin', 2, RoleID, 1, 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Admin';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Pre_Admin')
    INSERT INTO PRIDE_ROLE_MASTER (RoleName, RoleLevel, ParentRoleID, CanManageUsers, IsActive)
    SELECT 'Pre_Admin', 3, RoleID, 0, 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Post_Admin';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Pos_User')
    INSERT INTO PRIDE_ROLE_MASTER (RoleName, RoleLevel, ParentRoleID, CanManageUsers, IsActive)
    SELECT 'Pos_User', 3, RoleID, 0, 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Post_Admin';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Pre_User')
    INSERT INTO PRIDE_ROLE_MASTER (RoleName, RoleLevel, ParentRoleID, CanManageUsers, IsActive)
    SELECT 'Pre_User', 4, RoleID, 0, 1 FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Pre_Admin';
GO

-- ── User seed ────────────────────────────────────────────────────────
-- Inserted top-down so each row's ParentUserID can be resolved by looking
-- its parent's username up in the table as it stands at that point.
--
-- Only vivek gets a PasswordHash (Admin@123, hashed with the exact
-- PBKDF2-HMACSHA256 scheme PasswordHasher.Hash produces — see
-- Services\PasswordHasher.cs). Everyone else is seeded with a NULL hash
-- and cannot log in until a password is set for them; that is intentional
-- for Phase 1, which ships no "set password" UI yet.

IF NOT EXISTS (SELECT 1 FROM PRIDE_USER_MASTER WHERE Username = 'vivek')
    INSERT INTO PRIDE_USER_MASTER (Username, PasswordHash, EmployeeName, Email, RoleID, ParentUserID, IsActive)
    SELECT 'vivek',
           'PBKDF2$SHA256$100000$nzVbZfij8bKSV8TM1OWkbw==$GIrtoz0PFZt8sDuakmeaL1Ojw0ppaoF27KxTJVYmjJc=',
           'Vivek', NULL, RoleID, NULL, 1
    FROM PRIDE_ROLE_MASTER WHERE RoleName = 'Admin';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_USER_MASTER WHERE Username = 'namrata')
    INSERT INTO PRIDE_USER_MASTER (Username, PasswordHash, EmployeeName, Email, RoleID, ParentUserID, IsActive)
    SELECT 'namrata', NULL, 'Namrata', NULL, r.RoleID, p.UserID, 1
    FROM PRIDE_ROLE_MASTER r
    CROSS JOIN PRIDE_USER_MASTER p
    WHERE r.RoleName = 'Post_Admin' AND p.Username = 'vivek';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_USER_MASTER WHERE Username = 'nikita')
    INSERT INTO PRIDE_USER_MASTER (Username, PasswordHash, EmployeeName, Email, RoleID, ParentUserID, IsActive)
    SELECT 'nikita', NULL, 'Nikita', 'CRM@HELLOWORD.COM', r.RoleID, p.UserID, 1
    FROM PRIDE_ROLE_MASTER r
    CROSS JOIN PRIDE_USER_MASTER p
    WHERE r.RoleName = 'Pre_Admin' AND p.Username = 'namrata';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_USER_MASTER WHERE Username = 'sonal')
    INSERT INTO PRIDE_USER_MASTER (Username, PasswordHash, EmployeeName, Email, RoleID, ParentUserID, IsActive)
    SELECT 'sonal', NULL, 'Sonal', 'CRM3@HELLOWORD.COM', r.RoleID, p.UserID, 1
    FROM PRIDE_ROLE_MASTER r
    CROSS JOIN PRIDE_USER_MASTER p
    WHERE r.RoleName = 'Pre_User' AND p.Username = 'nikita';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_USER_MASTER WHERE Username = 'amit')
    INSERT INTO PRIDE_USER_MASTER (Username, PasswordHash, EmployeeName, Email, RoleID, ParentUserID, IsActive)
    SELECT 'amit', NULL, 'Amit', 'CRM11@HELLOWORD.COM', r.RoleID, p.UserID, 1
    FROM PRIDE_ROLE_MASTER r
    CROSS JOIN PRIDE_USER_MASTER p
    WHERE r.RoleName = 'Pre_User' AND p.Username = 'nikita';
GO

IF NOT EXISTS (SELECT 1 FROM PRIDE_USER_MASTER WHERE Username = 'princ.jain')
    INSERT INTO PRIDE_USER_MASTER (Username, PasswordHash, EmployeeName, Email, RoleID, ParentUserID, IsActive)
    SELECT 'princ.jain', NULL, 'Princ Jain', 'CRM5@HELLOWORD.COM', r.RoleID, p.UserID, 1
    FROM PRIDE_ROLE_MASTER r
    CROSS JOIN PRIDE_USER_MASTER p
    WHERE r.RoleName = 'Pos_User' AND p.Username = 'namrata';
GO
