using System.Collections.Generic;
using Newtonsoft.Json;

namespace EmailAutomation.Models
{
    // ── Dropdown DTOs ──────────────────────────────────────────────

    /// <summary>
    /// One selectable entry in the FE's "Email Date" dropdown.
    /// Each date represents one day's batch of daily-email report files
    /// (main_email_receipts_*.csv / main_email_receipt_details_*.csv).
    /// </summary>
    public class EmailDateDropdownItem
    {
        /// <summary>Machine value, e.g. "2026-05-13". Send this back when calling other endpoints for this date.</summary>
        [JsonProperty("date")]
        public string Date { get; set; }

        /// <summary>Human-friendly value to show in the dropdown, e.g. "13-05-2026".</summary>
        [JsonProperty("displayDate")]
        public string DisplayDate { get; set; }
    }

    /// <summary>
    /// One row of PRIDE_PROJECT_BANK_ACCOUNT_MASTER: the two accounts a payment
    /// on a given project (and wing) is receipted against.
    ///
    /// ProjectName holds the project and its wings as one string, in whichever
    /// shape the master was typed in — "MONTREAL-A-B-C-D", "WELLINGTON - E-H-J-K",
    /// "BOSTON - A B C", or just "RIO TOWER" where there are no wings at all. The
    /// FE splits it; the API hands it over as stored.
    /// </summary>
    public class ProjectBankAccountItem
    {
        [JsonProperty("projectBankAccountId")]
        public string ProjectBankAccountId { get; set; }

        [JsonProperty("projectName")]
        public string ProjectName { get; set; }

        [JsonProperty("collectionBankAccount")]
        public string CollectionBankAccount { get; set; }

        [JsonProperty("sdrMnglGstBankAccount")]
        public string SdrMnglGstBankAccount { get; set; }
    }

    // ── Receipts table DTOs ───────────────────────────────────────

    /// <summary>
    /// One data row read from main_email_receipts_{date}.csv.
    /// Property order matches the CSV's column order exactly.
    /// </summary>
    public class EmailReceiptRow
    {
        /// <summary>
        /// The table's own key. Carried to the UI so an edit can be written back
        /// to exactly the row it was made on, rather than to every row of the thread.
        /// </summary>
        [JsonProperty("emailReceiptsId")]
        public string EmailReceiptsId { get; set; }

        /// <summary>
        /// The row's own thread key: a main_email_receipts.[Thread ID] for every
        /// category but 'Payment - Loan/Bank', and for that one the customer's
        /// [Customer Thread ID]. What the ticket is minted on, what the payment
        /// panel asks for, and what every write keys on.
        /// </summary>
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>
        /// Set only on a 'Payment - Loan/Bank' row, where it repeats ThreadId:
        /// one loan email covers many customers, and this row is one of them. Blank
        /// for every other category, which is how a consumer tells a loan row apart
        /// without reading the shape of an id.
        /// </summary>
        [JsonProperty("customerThreadId")]
        public string CustomerThreadId { get; set; }

        /// <summary>
        /// The email itself — main_email_receipts.[Thread ID]. The same as ThreadId
        /// except on a loan row, where it is the email the customer was one of.
        /// What is still the email's own is named after it: its attachment folder,
        /// its subject.
        /// </summary>
        [JsonProperty("parentThreadId")]
        public string ParentThreadId { get; set; }

        [JsonProperty("category")]
        public string Category { get; set; }

        [JsonProperty("runDate")]
        public string RunDate { get; set; }

        [JsonProperty("emailDate")]
        public string EmailDate { get; set; }

        [JsonProperty("emailSubject")]
        public string EmailSubject { get; set; }

        [JsonProperty("customerName")]
        public string CustomerName { get; set; }

        [JsonProperty("project")]
        public string Project { get; set; }

        [JsonProperty("subProject")]
        public string SubProject { get; set; }

        [JsonProperty("unit")]
        public string Unit { get; set; }

        [JsonProperty("customerSender")]
        public string CustomerSender { get; set; }

        [JsonProperty("emailLink")]
        public string EmailLink { get; set; }

        [JsonProperty("emailBody")]
        public string EmailBody { get; set; }

        [JsonProperty("forwardDetails")]
        public string ForwardDetails { get; set; }

        [JsonProperty("intent")]
        public string Intent { get; set; }

        [JsonProperty("subIntent")]
        public string SubIntent { get; set; }

        [JsonProperty("sentiment")]
        public string Sentiment { get; set; }

        [JsonProperty("actionRequired")]
        public string ActionRequired { get; set; }

        [JsonProperty("reason")]
        public string Reason { get; set; }

        [JsonProperty("confidence")]
        public string Confidence { get; set; }

        [JsonProperty("customerSpecific")]
        public string CustomerSpecific { get; set; }

        [JsonProperty("aiCustomerEmail")]
        public string AiCustomerEmail { get; set; }

        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        [JsonProperty("turnAroundDateTime")]
        public string TurnAroundDateTime { get; set; }

        /// <summary>From the appended "Status" column. Blank until it is filled in.</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        /// <summary>From the appended "Remark" column. Blank until it is filled in.</summary>
        [JsonProperty("remark")]
        public string Remark { get; set; }

        /// <summary>"Match"/"Unmatch" from the Customer Email Verification step, blank until it runs.</summary>
        [JsonProperty("customerEmailMatch")]
        public string CustomerEmailMatch { get; set; }

        /// <summary>
        /// When each step matched, ISO 8601, or "" when it has not matched.
        ///
        /// Written only on a match - see MatchStampColumns - so a value here
        /// always names a moment the step actually matched, which is what the
        /// pipeline card prints under its title.
        /// </summary>
        [JsonProperty("customerEmailMatchDate")]
        public string CustomerEmailMatchDate { get; set; }

        [JsonProperty("unitMatchDate")]
        public string UnitMatchDate { get; set; }

        /// <summary>
        /// The Agreement Workflow's verdicts, keyed by step key
        /// ("booking-kyc", "agreement-drafting", …) — "Match" once the step has
        /// been verified.
        ///
        /// A map rather than thirteen properties because the steps are a list,
        /// and every reader on either side walks them as one. Only steps that
        /// have actually been decided appear; a thread that has run none of them
        /// — which is every thread that is not an agreement thread — sends an
        /// empty object.
        ///
        /// The columns behind it are snake_case and spaceless
        /// ([Booking_KYC_Verification] and the rest); the wire stays camelCase
        /// like every other field here, so nothing on the UI side sees a column
        /// name at all. AgreementSteps in EmailAutomationController maps the two.
        /// </summary>
        [JsonProperty("agreementSteps")]
        public Dictionary<string, string> AgreementSteps { get; set; }

        /// <summary>
        /// When each agreement step was verified, ISO 8601, keyed the same way.
        ///
        /// Written only on a match, exactly as customerEmailMatchDate is, so a
        /// value here always names a moment the step actually passed — which is
        /// what the step's pipeline card prints under its title.
        /// </summary>
        [JsonProperty("agreementStepDates")]
        public Dictionary<string, string> AgreementStepDates { get; set; }

        /// <summary>"Match"/"Unmatch" from the Unit Match step, blank until it runs.</summary>
        [JsonProperty("unitMatch")]
        public string UnitMatch { get; set; }

        /// <summary>
        /// The CRM executive who owns this thread, written when Unit Match settles:
        /// the first user its Project + Sub Project map to, or the configured CRM
        /// head when the unit did not match. Blank until that step has run.
        /// </summary>
        [JsonProperty("assignedTo")]
        public string AssignedTo { get; set; }

        /// <summary>
        /// Which pipeline step the thread is currently stopped on, e.g. "Instrument
        /// Match" — from the appended "Action" column. Blank until the FE has opened
        /// the thread at least once and pushed a value via update-action-status.
        /// </summary>
        [JsonProperty("action")]
        public string ActionName { get; set; }

        /// <summary>
        /// Why it is stopped there, from the appended "Action Status" column: one of
        /// "Done", "Pending", "User Verification Required" or "User Intervention" —
        /// the same words statusLabel() shows on the pipeline panel's own pills.
        /// Blank until that step has been opened and evaluated.
        /// </summary>
        [JsonProperty("actionStatus")]
        public string ActionStatus { get; set; }

        /// <summary>
        /// From the appended "Alert Received" bit column: whether an alert has come
        /// in for this thread. Shown as its own icon beside the Ticket ID and
        /// filterable in the Email Receipts grid.
        /// </summary>
        [JsonProperty("alertReceived")]
        public bool AlertReceived { get; set; }

        /// <summary>
        /// From the appended "Latest Customer Reply" column: the most recent reply
        /// the customer sent on this thread. Shown in the Alert Response popup
        /// underneath the original Email Body, and only when AlertReceived is set.
        /// </summary>
        [JsonProperty("latestCustomerReply")]
        public string LatestCustomerReply { get; set; }

        /// <summary>
        /// A shallow copy — every property, strings and all, which for a row of
        /// nothing but strings and a bool is a complete one.
        ///
        /// Exists for the loan grid: one loan email becomes one row per customer,
        /// each carrying the email's own fields unchanged. Copying the row and
        /// overwriting the customer's few fields means a column added above is
        /// inherited by every customer without anyone remembering to copy it.
        /// </summary>
        public EmailReceiptRow Clone()
        {
            return (EmailReceiptRow)MemberwiseClone();
        }
    }

    /// <summary>Response for GET api/emailautomation/receipts?date=...</summary>
    public class EmailReceiptsReportResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("fileName")]
        public string FileName { get; set; }

        [JsonProperty("rows")]
        public List<EmailReceiptRow> Rows { get; set; }
    }

    // ── Receipt detail (payment) DTOs ─────────────────────────────

    /// <summary>
    /// One data row read from main_email_receipt_details_{date}.csv, already
    /// filtered down to a single Thread ID. A thread can have several of
    /// these (e.g. one per payment instrument on that email).
    /// </summary>
    public class EmailReceiptDetailRow
    {
        /// <summary>The details table's own key, for the same reason as EmailReceiptsId.</summary>
        [JsonProperty("emailReceiptsDetailsId")]
        public string EmailReceiptsDetailsId { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>
        /// Which customer of a loan email this payment belongs to, from
        /// PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS.[Customer Thread ID]. Blank for
        /// every other category, whose payments are keyed on ThreadId alone.
        /// </summary>
        [JsonProperty("customerThreadId")]
        public string CustomerThreadId { get; set; }

        /// <summary>
        /// Blank on a loan payment: the loan table has no [Run Date] column, and
        /// nothing renders a payment row's run date — only the receipt row's.
        /// </summary>
        [JsonProperty("runDate")]
        public string RunDate { get; set; }

        [JsonProperty("paymentNo")]
        public string PaymentNo { get; set; }

        [JsonProperty("customerName")]
        public string CustomerName { get; set; }

        [JsonProperty("project")]
        public string Project { get; set; }

        [JsonProperty("subProject")]
        public string SubProject { get; set; }

        [JsonProperty("unit")]
        public string Unit { get; set; }

        [JsonProperty("instrumentNumber")]
        public string InstrumentNumber { get; set; }

        [JsonProperty("amount")]
        public string Amount { get; set; }

        [JsonProperty("paymentMode")]
        public string PaymentMode { get; set; }

        [JsonProperty("customerBank")]
        public string CustomerBank { get; set; }

        [JsonProperty("customerAccountNumber")]
        public string CustomerAccountNumber { get; set; }

        [JsonProperty("verificationFlag")]
        public string VerificationFlag { get; set; }

        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        [JsonProperty("remark")]
        public string Remark { get; set; }

        /// <summary>From the appended "Instrument Match" column. Blank until it is filled in.</summary>
        [JsonProperty("instrumentMatch")]
        public string InstrumentMatch { get; set; }

        /// <summary>From the appended "Bank Reco Match" column. Blank until it is filled in.</summary>
        [JsonProperty("bankRecoMatch")]
        public string BankRecoMatch { get; set; }

        /// <summary>
        /// When each of the two payment-level steps matched this row, ISO 8601,
        /// or "" while it has not matched.
        ///
        /// Per payment rather than per thread, because the verdict beside them
        /// is: a thread with three payments settles them one at a time. The
        /// pipeline card shows the latest of a thread's rows, which is when the
        /// step finished with the thread as a whole.
        /// </summary>
        [JsonProperty("instrumentMatchDate")]
        public string InstrumentMatchDate { get; set; }

        [JsonProperty("bankRecoMatchDate")]
        public string BankRecoMatchDate { get; set; }

        /// <summary>From the appended "Dublicate Match" column. Blank until it is filled in.</summary>
        [JsonProperty("dublicateMatch")]
        public string DublicateMatch { get; set; }

        /// <summary>
        /// The collection account this payment is receipted against, picked by the
        /// reviewer from PRIDE_PROJECT_BANK_ACCOUNT_MASTER. Blank until picked.
        /// </summary>
        [JsonProperty("cashHeaderAccount")]
        public string CashHeaderAccount { get; set; }

        /// <summary>
        /// "New Entry" or "Duplicate Entry" — what [Dublicate Match] means in the
        /// words the payment card shows. Blank until Instrument Match has run.
        /// </summary>
        [JsonProperty("entryStatus")]
        public string EntryStatus { get; set; }

        /// <summary>
        /// "Automate" or "Manual" — who last settled the duplicate verdict, which
        /// is what decides whether the New Entry toggle can still be moved. Blank
        /// until Instrument Match has run.
        /// </summary>
        [JsonProperty("editType")]
        public string EditType { get; set; }

        /// <summary>
        /// From the appended "Bank Reco Note" column: two raw facts, not a
        /// finished sentence — which statement workbook Bank Reconciliation
        /// searched and its last record's Value Date, stored as
        /// "KOTAK_SOHO_5968.xlsm|31-05-2026". The FE composes the sentence a
        /// reviewer actually reads and decides which part reads bold; this is
        /// deliberately just the data. Set only when [Bank Reco Match] is
        /// "Unmatch"; cleared the moment a later run finds the payment.
        /// </summary>
        [JsonProperty("bankRecoNote")]
        public string BankRecoNote { get; set; }
    }

    /// <summary>
    /// Body for POST api/emailautomation/set-entry-status — the reviewer flipping
    /// the New Entry / Duplicate Entry toggle on one payment card.
    /// </summary>
    public class EntryStatusRequest
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("emailReceiptsDetailsId")]
        public string EmailReceiptsDetailsId { get; set; }

        /// <summary>
        /// True for a new entry — the toggle switched on. Stored as
        /// [Dublicate Match] = 'Unmatch', which is what lets the payment go on to
        /// Bank Reconciliation.
        /// </summary>
        [JsonProperty("isNewEntry")]
        public bool IsNewEntry { get; set; }

        /// <summary>
        /// Why the reviewer is marking this payment as a duplicate, typed into the
        /// popup the toggle opens when it is switched off. Stored as the row's
        /// EntryStatus, so the reason is the status.
        ///
        /// Only read when isNewEntry is false; omitted, the column falls back to
        /// the step's own wording ("Duplicate Entry"). Switching the toggle on
        /// never carries one — the row goes back to "New Entry".
        /// </summary>
        [JsonProperty("entryStatus")]
        public string EntryStatus { get; set; }

        [JsonProperty("updatedBy")]
        public string UpdatedBy { get; set; }
    }

    /// <summary>Response for POST api/emailautomation/set-entry-status.</summary>
    public class EntryStatusResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("emailReceiptsDetailsId")]
        public string EmailReceiptsDetailsId { get; set; }

        [JsonProperty("dublicateMatch")]
        public string DublicateMatch { get; set; }

        [JsonProperty("entryStatus")]
        public string EntryStatus { get; set; }

        /// <summary>Always "Manual" — this endpoint is the reviewer's own verdict.</summary>
        [JsonProperty("editType")]
        public string EditType { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>Response for GET api/emailautomation/receipt-details?date=...&amp;threadId=...</summary>
    public class EmailReceiptDetailsResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("fileName")]
        public string FileName { get; set; }

        [JsonProperty("rows")]
        public List<EmailReceiptDetailRow> Rows { get; set; }
    }

    // ── Thread attachments ───────────────────────────────────────

    /// <summary>
    /// One file saved for a thread by the ingestion pipeline, under
    /// {AttachmentsFolderPath}\{Thread ID}\.
    /// </summary>
    public class ThreadAttachment
    {
        /// <summary>File name as it sits on disk, e.g. "0a41b2be_SalesReceipt.pdf".</summary>
        [JsonProperty("fileName")]
        public string FileName { get; set; }

        /// <summary>Lower-case extension without the dot, e.g. "pdf". '' when there is none.</summary>
        [JsonProperty("extension")]
        public string Extension { get; set; }

        [JsonProperty("sizeBytes")]
        public long SizeBytes { get; set; }

        /// <summary>Last write time, ISO-8601, for display in the popup.</summary>
        [JsonProperty("modified")]
        public string Modified { get; set; }

        /// <summary>True for the types the popup can show inline rather than only download.</summary>
        [JsonProperty("isImage")]
        public bool IsImage { get; set; }
    }

    /// <summary>Response for GET api/emailautomation/attachments?threadId=...</summary>
    public class ThreadAttachmentsResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>False when the thread has no folder at all — not an error.</summary>
        [JsonProperty("folderExists")]
        public bool FolderExists { get; set; }

        [JsonProperty("files")]
        public List<ThreadAttachment> Files { get; set; }
    }

    /// <summary>
    /// One spreadsheet attachment read as rows of text, for the popup to draw as
    /// a table. Response for GET api/emailautomation/attachment-preview.
    /// </summary>
    public class SheetPreviewResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("fileName")]
        public string FileName { get; set; }

        /// <summary>Every sheet in the workbook, so the popup can offer tabs.</summary>
        [JsonProperty("sheetNames")]
        public List<string> SheetNames { get; set; }

        /// <summary>The one these rows came from.</summary>
        [JsonProperty("sheetName")]
        public string SheetName { get; set; }

        /// <summary>Cell text, every row the same width.</summary>
        [JsonProperty("rows")]
        public List<List<string>> Rows { get; set; }

        [JsonProperty("rowCount")]
        public int RowCount { get; set; }

        /// <summary>True when the sheet holds more rows than were sent.</summary>
        [JsonProperty("truncated")]
        public bool Truncated { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Reviewer edits: correcting a row before a step re-runs ────

    /// <summary>
    /// Body for POST api/emailautomation/update-receipt.
    ///
    /// Sent when a reviewer fills in a value the pipeline needs but the row is
    /// missing — a blank Customer Sender before Customer Email Verification, or a
    /// blank Project/Unit before Unit Match. Only the fields present are written;
    /// a null one is left alone, which is what lets one dialog edit one field.
    /// </summary>
    public class ReceiptUpdateRequest
    {
        /// <summary>Report date of the thread, e.g. "2026-05-13".</summary>
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The row's [Email Receipts ID]. Together with Thread ID it keys the update.</summary>
        [JsonProperty("emailReceiptsId")]
        public string EmailReceiptsId { get; set; }

        [JsonProperty("customerSender")]
        public string CustomerSender { get; set; }

        [JsonProperty("project")]
        public string Project { get; set; }

        [JsonProperty("subProject")]
        public string SubProject { get; set; }

        [JsonProperty("unit")]
        public string Unit { get; set; }

        /// <summary>
        /// Who made the correction, for the audit log. Optional: the app has no
        /// sign-in yet, so the backend falls back to a fixed label.
        /// </summary>
        [JsonProperty("updatedBy")]
        public string UpdatedBy { get; set; }
    }

    /// <summary>Response for POST api/emailautomation/update-receipt.</summary>
    public class ReceiptUpdateResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>Columns actually written, e.g. ["Customer Sender"].</summary>
        [JsonProperty("updatedColumns")]
        public List<string> UpdatedColumns { get; set; }

        /// <summary>The row as it now stands, so the UI re-syncs instead of guessing.</summary>
        [JsonProperty("row")]
        public EmailReceiptRow Row { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>
    /// Body for POST api/emailautomation/update-receipt-detail.
    ///
    /// One payment row's correctable fields: the instrument number a match could
    /// not find, or the amount/account number Bank Reconciliation needs.
    /// </summary>
    public class ReceiptDetailUpdateRequest
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The payment row's [Email Receipts Details ID].</summary>
        [JsonProperty("emailReceiptsDetailsId")]
        public string EmailReceiptsDetailsId { get; set; }

        [JsonProperty("instrumentNumber")]
        public string InstrumentNumber { get; set; }

        [JsonProperty("amount")]
        public string Amount { get; set; }

        [JsonProperty("customerAccountNumber")]
        public string CustomerAccountNumber { get; set; }

        [JsonProperty("paymentMode")]
        public string PaymentMode { get; set; }

        [JsonProperty("customerBank")]
        public string CustomerBank { get; set; }

        /// <summary>
        /// The collection account picked for this payment. Not a correction to a
        /// value a step read, but the same write path: one column on one payment
        /// row, audited like the rest.
        /// </summary>
        [JsonProperty("cashHeaderAccount")]
        public string CashHeaderAccount { get; set; }

        /// <summary>Who made the correction, for the audit log. See ReceiptUpdateRequest.</summary>
        [JsonProperty("updatedBy")]
        public string UpdatedBy { get; set; }
    }

    /// <summary>Response for POST api/emailautomation/update-receipt-detail.</summary>
    public class ReceiptDetailUpdateResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("updatedColumns")]
        public List<string> UpdatedColumns { get; set; }

        /// <summary>Every payment row of the thread as it now stands.</summary>
        [JsonProperty("rows")]
        public List<EmailReceiptDetailRow> Rows { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Workflow step: Customer Email Verification (node-2) ───────

    /// <summary>
    /// Body for POST api/emailautomation/apply-booking.
    ///
    /// The booking the reviewer picked (or the only one there was) for a thread,
    /// written back onto its receipt row.
    /// </summary>
    public class BookingSelectionRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("emailReceiptsId")]
        public string EmailReceiptsId { get; set; }

        [JsonProperty("project")]
        public string Project { get; set; }

        [JsonProperty("subProject")]
        public string SubProject { get; set; }

        [JsonProperty("unit")]
        public string Unit { get; set; }

        [JsonProperty("updatedBy")]
        public string UpdatedBy { get; set; }
    }

    /// <summary>Body for POST api/emailautomation/close-ticket.</summary>
    public class TicketCloseRequest
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The ticket to close, e.g. 'TKT-2026-000001'.</summary>
        [JsonProperty("ticketId")]
        public string TicketId { get; set; }

        [JsonProperty("updatedBy")]
        public string UpdatedBy { get; set; }
    }

    /// <summary>Response for POST api/emailautomation/close-ticket.</summary>
    public class TicketCloseResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("ticketId")]
        public string TicketId { get; set; }

        /// <summary>Where the ticket now stands: 'Closed'.</summary>
        [JsonProperty("ticketStatus")]
        public string TicketStatus { get; set; }

        /// <summary>
        /// How the SLA finished: "Met" when the ticket was closed inside its
        /// window, "Overdue" when it had already run past it. Settled by the
        /// close itself, so the UI can stop its clock and show the outcome.
        /// </summary>
        [JsonProperty("slaStatus")]
        public string SlaStatus { get; set; }

        /// <summary>
        /// The instant the close was written, read straight back out of the same
        /// statement — so the panel can show it without a reload, and shows the
        /// database's clock rather than the browser's.
        ///
        /// "yyyy-MM-dd HH:mm:ss". Empty when the ticket was already closed and
        /// this call changed nothing.
        /// </summary>
        [JsonProperty("closedOn")]
        public string ClosedOn { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>Body for POST api/emailautomation/verify-customer-email.</summary>
    public class CustomerEmailVerificationRequest
    {
        /// <summary>Report date of the thread, e.g. "2026-05-13".</summary>
        [JsonProperty("date")]
        public string Date { get; set; }

        /// <summary>Thread being verified, e.g. "THR-d48b00bb".</summary>
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }
    }

    /// <summary>
    /// One live booked unit the email sender owns, as returned by
    /// dbo.PRIDE_CUSTOMER_PORTAL_BOOKED_UNITS — either from the booking master,
    /// or from the co-applicant table where the sender is a co-applicant. In the
    /// co-applicant case the unit and project fields are still the master's and
    /// the name and CUSTOMER_ID are the co-applicant's, so the shape is the same
    /// either way and the caller is not told which answered.
    ///
    /// Carries the unit/project fields the Unit Match step needs next.
    /// </summary>
    public class CustomerBookingMatch
    {
        [JsonProperty("accountItemNo")]
        public string AccountItemNo { get; set; }

        [JsonProperty("bookingStatusName")]
        public string BookingStatusName { get; set; }

        [JsonProperty("projectId")]
        public string ProjectId { get; set; }

        [JsonProperty("projectName")]
        public string ProjectName { get; set; }

        [JsonProperty("subProjectId")]
        public string SubProjectId { get; set; }

        [JsonProperty("subProjectName")]
        public string SubProjectName { get; set; }

        [JsonProperty("unitId")]
        public string UnitId { get; set; }

        [JsonProperty("unitNo")]
        public string UnitNo { get; set; }

        [JsonProperty("floorNo")]
        public string FloorNo { get; set; }

        [JsonProperty("unitTypeName")]
        public string UnitTypeName { get; set; }

        [JsonProperty("customerId")]
        public string CustomerId { get; set; }

        [JsonProperty("customerName")]
        public string CustomerName { get; set; }
    }

    /// <summary>Result of the Customer Email Verification step for one thread.</summary>
    public class CustomerEmailVerificationResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The Customer Sender address the master was searched with.</summary>
        [JsonProperty("senderEmail")]
        public string SenderEmail { get; set; }

        /// <summary>True when the sender matched EMAIL1, EMAIL2 or EMAIL3 of at least one booking.</summary>
        [JsonProperty("matched")]
        public bool Matched { get; set; }

        /// <summary>Bookings the sender matched. Empty when Matched is false.</summary>
        [JsonProperty("bookings")]
        public List<CustomerBookingMatch> Bookings { get; set; }

        /// <summary>
        /// The bookings above, narrowed by whatever Project / Sub Project / Unit
        /// the receipt row already carries.
        ///
        /// One candidate means the thread's booking is settled and Unit Match can
        /// run against it. Several means the customer holds more than one unit
        /// that fits, and the reviewer has to say which — the Project &amp; Unit
        /// card lists these for them to pick from.
        /// </summary>
        [JsonProperty("candidates")]
        public List<CustomerBookingMatch> Candidates { get; set; }

        /// <summary>Where the pipeline goes next: "Unit Match" on a match, otherwise null.</summary>
        [JsonProperty("nextStep")]
        public string NextStep { get; set; }

        /// <summary>Value written into the CSV Status column, or null when nothing was written.</summary>
        [JsonProperty("statusWritten")]
        public string StatusWritten { get; set; }

        /// <summary>Value written into the row's "Workflow Status" column by this step.</summary>
        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        /// <summary>
        /// When this step matched, ISO 8601, read back from the stamp column the
        /// write set — or "" when it did not match and nothing was stamped.
        ///
        /// Returned so the pipeline card can print the time the moment the step
        /// finishes. Without it the browser knew the verdict but not its instant,
        /// and the card stayed blank until the row was fetched again.
        /// </summary>
        [JsonProperty("matchDate")]
        public string MatchDate { get; set; }

        /// <summary>Human-readable outcome for the Step Inspector.</summary>
        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Workflow step: Unit Match (node-3) ────────────────────────

    /// <summary>Body for POST api/emailautomation/match-unit.</summary>
    public class UnitMatchRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }
    }

    /// <summary>Result of the Unit Match step for one thread.</summary>
    public class UnitMatchResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>Unit from the receipt row, matched against the part of UNIT_NO after its first space.</summary>
        [JsonProperty("unit")]
        public string Unit { get; set; }

        [JsonProperty("senderEmail")]
        public string SenderEmail { get; set; }

        [JsonProperty("project")]
        public string Project { get; set; }

        /// <summary>True when a booking matched on unit + email + project together.</summary>
        [JsonProperty("matched")]
        public bool Matched { get; set; }

        [JsonProperty("bookings")]
        public List<CustomerBookingMatch> Bookings { get; set; }

        /// <summary>Where the pipeline goes next: "Instrument Match" on a match, otherwise null.</summary>
        [JsonProperty("nextStep")]
        public string NextStep { get; set; }

        /// <summary>Value written into the CSV Remark column, or null when nothing was written.</summary>
        [JsonProperty("remarkWritten")]
        public string RemarkWritten { get; set; }

        /// <summary>Value written into the row's "Workflow Status" column by this step.</summary>
        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        /// <summary>
        /// When this step matched, ISO 8601, read back from the stamp column the
        /// write set — or "" when it did not match and nothing was stamped.
        ///
        /// Returned so the pipeline card can print the time the moment the step
        /// finishes, rather than waiting for the row to be fetched again.
        /// </summary>
        [JsonProperty("matchDate")]
        public string MatchDate { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Workflow steps: the Agreement Workflow (nodes a1-a13) ─────

    /// <summary>
    /// Body for POST api/emailautomation/verify-agreement-step.
    ///
    /// One body for all thirteen stages; which one is being verified is the
    /// stepKey. See AgreementSteps in EmailAutomationController for the keys and
    /// the order they run in.
    /// </summary>
    public class AgreementStepRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>
        /// Which stage, e.g. "booking-kyc" or "ghoshvara-verification".
        ///
        /// Resolved against AgreementSteps and rejected when it names none, which
        /// is also what keeps a column name out of a caller's hands: the column
        /// written is the one the table holds for this key, never a value that
        /// arrived here.
        /// </summary>
        [JsonProperty("stepKey")]
        public string StepKey { get; set; }
    }

    /// <summary>Result of verifying one Agreement Workflow stage for a thread.</summary>
    public class AgreementStepResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The stage that was verified, echoed back.</summary>
        [JsonProperty("stepKey")]
        public string StepKey { get; set; }

        /// <summary>Its display title, e.g. "Agreement Drafting".</summary>
        [JsonProperty("stepTitle")]
        public string StepTitle { get; set; }

        /// <summary>
        /// Always true on a 200. These stages carry no lookup that could come
        /// back unmatched — verifying one is the reviewer confirming it — so a
        /// stage that cannot pass yet is refused outright rather than answered
        /// with a false here. Present so the FE can read this response with the
        /// same shape it reads every other step's.
        /// </summary>
        [JsonProperty("matched")]
        public bool Matched { get; set; }

        /// <summary>
        /// The stage after this one, or "Email Response" after the thirteenth.
        /// </summary>
        [JsonProperty("nextStep")]
        public string NextStep { get; set; }

        /// <summary>Value written into the row's "Workflow Status" column by this step.</summary>
        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        /// <summary>
        /// When this stage was verified, ISO 8601, read back from the stamp the
        /// write set — so the card can print the time without fetching the row
        /// again.
        /// </summary>
        [JsonProperty("matchDate")]
        public string MatchDate { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Workflow step: Bank Reconciliation (node-5) ───────────────

    /// <summary>Body for POST api/emailautomation/reconcile-bank.</summary>
    public class BankReconciliationRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }
    }

    /// <summary>Reconciliation outcome for one payment row.</summary>
    public class BankReconciliationPayment
    {
        /// <summary>
        /// The Pride account this payment settles to. Its last 4 digits pick the
        /// statement workbook — the customer's own account number does not, since
        /// the statement is of the Pride side of the transfer.
        /// </summary>
        [JsonProperty("cashHeaderAccount")]
        public string CashHeaderAccount { get; set; }

        [JsonProperty("paymentNo")]
        public string PaymentNo { get; set; }

        [JsonProperty("instrumentNumber")]
        public string InstrumentNumber { get; set; }

        [JsonProperty("amount")]
        public string Amount { get; set; }

        [JsonProperty("customerAccountNumber")]
        public string CustomerAccountNumber { get; set; }

        [JsonProperty("accountLastFour")]
        public string AccountLastFour { get; set; }

        [JsonProperty("statementFile")]
        public string StatementFile { get; set; }

        /// <summary>
        /// Every workbook in the month folder whose name carries this account's
        /// last four digits, searched in turn until the payment is found.
        ///
        /// More than one because two accounts can end in the same four digits -
        /// ...978100 and ...968100 both live in files named "ICICI 8100 ..." - and
        /// the row is in exactly one of them. Server-side only: the FE is told
        /// which workbook answered, in StatementFile, not which were tried.
        /// </summary>
        [JsonIgnore]
        public List<string> StatementPaths { get; set; }

        /// <summary>
        /// The last Value Date on the workbook named in StatementFile, kept while
        /// the files are being walked so the note ends up naming the one with the
        /// most recent data rather than whichever was opened last. Server-side
        /// only; the FE reads the same date out of BankRecoNote.
        /// </summary>
        [JsonIgnore]
        public string LastStatementDate { get; set; }

        [JsonProperty("sheetName")]
        public string SheetName { get; set; }

        /// <summary>"Match" or "Unmatch" — written to the "Bank Reco Match" column.</summary>
        [JsonProperty("bankRecoMatch")]
        public string BankRecoMatch { get; set; }

        /// <summary>"Match" (a duplicate was found) or "Unmatch" — written to "Dublicate Match".</summary>
        [JsonProperty("dublicateMatch")]
        public string DublicateMatch { get; set; }

        [JsonProperty("matched")]
        public bool Matched { get; set; }

        [JsonProperty("duplicateFound")]
        public bool DuplicateFound { get; set; }

        /// <summary>How many statement rows carried this instrument and amount.</summary>
        [JsonProperty("matchCount")]
        public int MatchCount { get; set; }

        /// <summary>Amount cells filled yellow, e.g. ["G205"].</summary>
        [JsonProperty("matchedCells")]
        public List<string> MatchedCells { get; set; }

        [JsonProperty("reason")]
        public string Reason { get; set; }

        /// <summary>
        /// Two raw facts, not a finished sentence: which workbook the search
        /// looked in and its last record's Value Date, stored as
        /// "KOTAK_SOHO_5968.xlsm|31-05-2026". The FE composes the actual wording
        /// and decides what reads bold. Empty on a match — nothing left to
        /// explain — and persisted to main_email_receipt_details.[Bank Reco Note]
        /// so the payment card can show it without re-running the step.
        /// </summary>
        [JsonProperty("bankRecoNote")]
        public string BankRecoNote { get; set; }
    }

    /// <summary>Result of the Bank Reconciliation step for one thread.</summary>
    public class BankReconciliationResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("monthFolder")]
        public string MonthFolder { get; set; }

        [JsonProperty("payments")]
        public List<BankReconciliationPayment> Payments { get; set; }

        [JsonProperty("matchedCount")]
        public int MatchedCount { get; set; }

        [JsonProperty("totalCount")]
        public int TotalCount { get; set; }

        [JsonProperty("duplicateCount")]
        public int DuplicateCount { get; set; }

        /// <summary>True only when every payment on the thread reconciled.</summary>
        [JsonProperty("allMatched")]
        public bool AllMatched { get; set; }

        /// <summary>
        /// When this step matched, ISO 8601 — the latest [Bank Reco Match Date]
        /// across the thread's payment rows, read back from the stamps the write
        /// set. "" when nothing reconciled and nothing was stamped.
        ///
        /// Returned so the pipeline card can print the time the moment the step
        /// finishes, rather than waiting for the rows to be fetched again.
        /// </summary>
        [JsonProperty("matchDate")]
        public string MatchDate { get; set; }

        [JsonProperty("nextStep")]
        public string NextStep { get; set; }

        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Workflow step: Ticket Acknowledgement (node-1) ────────────

    /// <summary>Body for POST api/emailautomation/acknowledge-tickets.</summary>
    public class TicketAcknowledgementRequest
    {
        /// <summary>Report date whose threads should get tickets, e.g. "2026-05-13".</summary>
        [JsonProperty("date")]
        public string Date { get; set; }
    }

    /// <summary>The ticket now held by one thread.</summary>
    public class TicketAcknowledgementItem
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>e.g. "TKT-2026-000001".</summary>
        [JsonProperty("ticketId")]
        public string TicketId { get; set; }

        [JsonProperty("emailDate")]
        public string EmailDate { get; set; }

        /// <summary>SLA held against the ticket, e.g. "24 Hours". The window the countdown runs.</summary>
        [JsonProperty("sla")]
        public string Sla { get; set; }

        /// <summary>
        /// When the ticket was raised — Created_Date on the row, stamped by the
        /// database at the instant the Ticket ID and SLA were written. This is
        /// what the countdown is anchored to, so it is the same instant on every
        /// thread click, in every browser, after every refresh.
        ///
        /// "yyyy-MM-dd HH:mm:ss", or empty on an old ticket raised before the
        /// column existed whose email date could not be parsed.
        /// </summary>
        [JsonProperty("createdDate")]
        public string CreatedDate { get; set; }

        /// <summary>
        /// When the SLA runs out: CreatedDate plus the SLA. Derived, never
        /// stored — one creation stamp and one rule cannot fall out of step,
        /// a second stored copy of the deadline could. Display only; the clock
        /// itself runs off SlaRemainingSeconds.
        /// </summary>
        [JsonProperty("slaDue")]
        public string SlaDue { get; set; }

        /// <summary>"On Track", "Overdue", or "Met" once the ticket is closed.</summary>
        [JsonProperty("slaStatus")]
        public string SlaStatus { get; set; }

        /// <summary>
        /// When the ticket was closed — SLA_Closed_On on the row, stamped by the
        /// database in the same statement that set Ticket_Status to 'Closed', so
        /// the time shown is the time the status changed and not a second
        /// reading of the clock.
        ///
        /// "yyyy-MM-dd HH:mm:ss", like CreatedDate. Empty on an open ticket, and
        /// on a ticket closed before the column was stamped.
        /// </summary>
        [JsonProperty("closedOn")]
        public string ClosedOn { get; set; }

        /// <summary>
        /// Seconds left on the SLA at the moment this response was built, going
        /// negative once it is overdue.
        ///
        /// Relative rather than absolute on purpose: Created_Date is a bare
        /// DATETIME with no offset, and the browser's clock and timezone are not
        /// the server's. A number of seconds needs neither to be right — the UI
        /// just does Date.now() + this. Null when the ticket has no Created_Date.
        /// </summary>
        [JsonProperty("slaRemainingSeconds")]
        public int? SlaRemainingSeconds { get; set; }

        /// <summary>"Open" or "Closed" as held on the ticket row.</summary>
        [JsonProperty("ticketStatus")]
        public string TicketStatus { get; set; }

        /// <summary>Outlook link to the thread's email, stored alongside the ticket.</summary>
        [JsonProperty("emailLink")]
        public string EmailLink { get; set; }

        /// <summary>True when this call raised the ticket, false when an open one was reused.</summary>
        [JsonProperty("isNew")]
        public bool IsNew { get; set; }
    }

    /// <summary>Result of raising tickets for one report date.</summary>
    public class TicketAcknowledgementResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("totalThreads")]
        public int TotalThreads { get; set; }

        [JsonProperty("createdCount")]
        public int CreatedCount { get; set; }

        [JsonProperty("reusedCount")]
        public int ReusedCount { get; set; }

        /// <summary>
        /// The database's clock when the tickets were read, "yyyy-MM-dd HH:mm:ss".
        /// Every slaRemainingSeconds above was measured against it.
        /// </summary>
        [JsonProperty("serverTime")]
        public string ServerTime { get; set; }

        [JsonProperty("tickets")]
        public List<TicketAcknowledgementItem> Tickets { get; set; }

        /// <summary>
        /// Tickets these same threads have already had closed.
        ///
        /// Separate from <see cref="Tickets"/> because a thread can hold both:
        /// closing a ticket is what lets the next load raise a fresh one, so a
        /// thread that has been dealt with once and written in again carries a
        /// closed ticket and an open one at the same time. Without this list the
        /// browser only ever sees the open half, and the closed ones — which is
        /// what "Closed Tickets" on screen means — could not be shown at all.
        /// </summary>
        [JsonProperty("closedTickets")]
        public List<TicketAcknowledgementItem> ClosedTickets { get; set; }
    }

    /// <summary>
    /// Body for POST api/emailautomation/refresh-sla.
    ///
    /// Sent by the UI when a countdown reaches zero, so the breach is recorded
    /// the moment it happens rather than waiting for the next date load.
    /// </summary>
    public class TicketSlaRequest
    {
        /// <summary>
        /// The ticket to re-evaluate, e.g. "TKT-2026-000001". Leave empty to
        /// sweep every open ticket instead.
        /// </summary>
        [JsonProperty("ticketId")]
        public string TicketId { get; set; }
    }

    /// <summary>Where one ticket's SLA stands, after re-evaluating it.</summary>
    public class TicketSlaResponse
    {
        [JsonProperty("ticketId")]
        public string TicketId { get; set; }

        /// <summary>When the ticket was raised, "yyyy-MM-dd HH:mm:ss".</summary>
        [JsonProperty("createdDate")]
        public string CreatedDate { get; set; }

        /// <summary>CreatedDate plus the SLA. Derived, not stored.</summary>
        [JsonProperty("slaDue")]
        public string SlaDue { get; set; }

        /// <summary>"On Track", "Overdue" or "Met".</summary>
        [JsonProperty("slaStatus")]
        public string SlaStatus { get; set; }

        /// <summary>Seconds left, negative once overdue. Null without a Created_Date.</summary>
        [JsonProperty("slaRemainingSeconds")]
        public int? SlaRemainingSeconds { get; set; }

        /// <summary>The database's clock when this was measured.</summary>
        [JsonProperty("serverTime")]
        public string ServerTime { get; set; }

        /// <summary>How many tickets this call moved to Overdue.</summary>
        [JsonProperty("markedOverdue")]
        public int MarkedOverdue { get; set; }
    }

    // ── Thread ownership ─────────────────────────────────────────

    /// <summary>Body for POST api/emailautomation/assign-thread.</summary>
    public class ThreadAssignmentRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>
        /// The CRM executive's name as config.json spells it, e.g. "KAILASH D".
        /// Resolved by the caller from the project mapping — see AssignThread.
        /// </summary>
        [JsonProperty("assignedTo")]
        public string AssignedTo { get; set; }
    }

    /// <summary>What was written into main_email_receipts.[Assigned To].</summary>
    public class ThreadAssignmentResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("assignedTo")]
        public string AssignedTo { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Thread action status ──────────────────────────────────────

    /// <summary>Body for POST api/emailautomation/update-action-status.</summary>
    public class ThreadActionStatusRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The pipeline step the thread is stopped on, e.g. "Instrument Match".</summary>
        [JsonProperty("action")]
        public string Action { get; set; }

        /// <summary>
        /// One of "Done", "Pending", "User Verification Required" or
        /// "User Intervention" — see UpdateActionStatus.
        /// </summary>
        [JsonProperty("actionStatus")]
        public string ActionStatus { get; set; }
    }

    /// <summary>What was written into main_email_receipts.[Action] / [Action Status].</summary>
    public class ThreadActionStatusResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("action")]
        public string Action { get; set; }

        [JsonProperty("actionStatus")]
        public string ActionStatus { get; set; }
    }

    // ── Workflow step: Instrument Match (node-4) ──────────────────

    /// <summary>Body for POST api/emailautomation/match-instrument.</summary>
    public class InstrumentMatchRequest
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }
    }

    /// <summary>
    /// What the SALES_RECEIPT lookup found for one payment row, and whether the
    /// row itself is complete enough to receipt.
    ///
    /// The two verdicts are independent and answer different questions:
    ///   • DublicateMatch — is this payment already on the books?
    ///   • InstrumentMatch — does the row carry every field a receipt needs?
    /// </summary>
    public class InstrumentMatchPayment
    {
        [JsonProperty("emailReceiptsDetailsId")]
        public string EmailReceiptsDetailsId { get; set; }

        [JsonProperty("paymentNo")]
        public string PaymentNo { get; set; }

        [JsonProperty("instrumentNumber")]
        public string InstrumentNumber { get; set; }

        [JsonProperty("amount")]
        public string Amount { get; set; }

        /// <summary>
        /// The Pride account, as held on the row. Filled in from the matched
        /// receipt's BANKHEADER when the row had none and the lookup found one.
        /// </summary>
        [JsonProperty("cashHeaderAccount")]
        public string CashHeaderAccount { get; set; }

        /// <summary>True when this call wrote the account onto the row.</summary>
        [JsonProperty("cashHeaderAccountFilled")]
        public bool CashHeaderAccountFilled { get; set; }

        /// <summary>"Match" when SALES_RECEIPT already holds this payment.</summary>
        [JsonProperty("dublicateMatch")]
        public string DublicateMatch { get; set; }

        /// <summary>"New Entry" / "Duplicate Entry" — DublicateMatch in words.</summary>
        [JsonProperty("entryStatus")]
        public string EntryStatus { get; set; }

        /// <summary>
        /// "Automate" for a verdict this run reached from SALES_RECEIPT, or the
        /// stored value on a row it left alone.
        /// </summary>
        [JsonProperty("editType")]
        public string EditType { get; set; }

        /// <summary>"Match" when every field a receipt needs is present on the row.</summary>
        [JsonProperty("instrumentMatch")]
        public string InstrumentMatch { get; set; }

        /// <summary>True when InstrumentMatch is "Match".</summary>
        [JsonProperty("matched")]
        public bool Matched { get; set; }

        /// <summary>Receipt the payment was found on, when it was.</summary>
        [JsonProperty("receiptId")]
        public string ReceiptId { get; set; }

        [JsonProperty("receiptStatus")]
        public string ReceiptStatus { get; set; }

        /// <summary>Fields the row is missing, e.g. ["Customer Account Number"].</summary>
        [JsonProperty("missingFields")]
        public List<string> MissingFields { get; set; }

        /// <summary>Why the row is not ready, in one line for the card.</summary>
        [JsonProperty("reason")]
        public string Reason { get; set; }
    }

    /// <summary>Result of the Instrument Match step for one thread.</summary>
    public class InstrumentMatchResponse
    {
        [JsonProperty("date")]
        public string Date { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("payments")]
        public List<InstrumentMatchPayment> Payments { get; set; }

        /// <summary>Payments whose row carries every field a receipt needs.</summary>
        [JsonProperty("matchedCount")]
        public int MatchedCount { get; set; }

        [JsonProperty("totalCount")]
        public int TotalCount { get; set; }

        /// <summary>Payments already on the books — SALES_RECEIPT had them.</summary>
        [JsonProperty("duplicateCount")]
        public int DuplicateCount { get; set; }

        /// <summary>Rows whose Pride account this call filled in from the receipt.</summary>
        [JsonProperty("accountsFilledCount")]
        public int AccountsFilledCount { get; set; }

        /// <summary>True only when every payment on the thread is complete.</summary>
        [JsonProperty("allMatched")]
        public bool AllMatched { get; set; }

        /// <summary>
        /// True when every payment on the thread is already on the books. Bank
        /// Reconciliation only looks at "Unmatch" rows, so there is nothing for it
        /// to do and the thread skips straight to Email Response.
        /// </summary>
        [JsonProperty("allDuplicates")]
        public bool AllDuplicates { get; set; }

        /// <summary>
        /// When this step matched, ISO 8601 — the latest [Instrument Match Date]
        /// across the thread's payment rows, read back from the stamps the write
        /// set. "" when nothing matched and nothing was stamped.
        ///
        /// Returned so the pipeline card can print the time the moment the step
        /// finishes, rather than waiting for the rows to be fetched again.
        /// </summary>
        [JsonProperty("matchDate")]
        public string MatchDate { get; set; }

        /// <summary>
        /// Where the thread goes next: "Bank Reconciliation" normally, "Draft
        /// Receipt Email" when every payment is a duplicate, otherwise null.
        /// </summary>
        [JsonProperty("nextStep")]
        public string NextStep { get; set; }

        /// <summary>Value written into the receipts row's "Workflow Status" column by this step.</summary>
        [JsonProperty("workflowStatus")]
        public string WorkflowStatus { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ── Thread replies: what the reviewer wrote back ─────────────

    /// <summary>
    /// One file attached to a reply, on its way up from the browser.
    ///
    /// Carried as base64 inside the JSON body rather than as a multipart part.
    /// Nothing else in this API is multipart, and inlining the bytes keeps the
    /// reply and its files a single call that either lands whole or not at all.
    /// </summary>
    public class ThreadReplyAttachmentUpload
    {
        /// <summary>Name as the reviewer's machine spelled it, e.g. 'receipt.pdf'.</summary>
        [JsonProperty("fileName")]
        public string FileName { get; set; }

        /// <summary>
        /// The file's bytes, base64-encoded. A browser data: URL prefix
        /// ("data:application/pdf;base64,") is tolerated and stripped.
        /// </summary>
        [JsonProperty("contentBase64")]
        public string ContentBase64 { get; set; }
    }

    /// <summary>
    /// Body for POST api/emailautomation/save-thread-reply.
    ///
    /// Sent when a reviewer writes back to the customer from the Alert Response
    /// popup. Recipients arrive as lists because that is the shape the compose
    /// holds them in — one pill per address — and are joined for storage here
    /// rather than in the browser.
    /// </summary>
    public class ThreadReplyRequest
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("to")]
        public List<string> To { get; set; }

        [JsonProperty("cc")]
        public List<string> Cc { get; set; }

        [JsonProperty("bcc")]
        public List<string> Bcc { get; set; }

        /// <summary>
        /// The subject to keep the reply under. Optional.
        ///
        /// The Alert Response compose has no Subject box -- a reviewer there
        /// writes a reply, not a header -- so it omits this and the backend
        /// derives 'Re: &lt;the thread's subject&gt;'. The Email Response popup
        /// does have one, already filled in by the step's template and editable,
        /// and what the reviewer sent under is what must be kept.
        /// </summary>
        [JsonProperty("subject")]
        public string Subject { get; set; }

        /// <summary>
        /// The ticket the reply was written against. Optional.
        ///
        /// Omitted by callers that have no ticket in hand, in which case the
        /// backend reads the thread's open one. Sent by the Email Response popup,
        /// which is already showing a ticket and must file the reply against that
        /// one -- answering "Close this ticket?" with yes closes it in the same
        /// click, and a re-read afterwards would find no open ticket at all.
        /// </summary>
        [JsonProperty("ticketId")]
        public string TicketId { get; set; }

        [JsonProperty("body")]
        public string Body { get; set; }

        /// <summary>
        /// The mailbox the reply goes out from, kept as Sent_From. Optional.
        ///
        /// Only the Email Response popup has a From box -- its template picks a
        /// sender off the thread's owner and the reviewer may change it -- so a
        /// reply typed after Respond omits this and the column is left to
        /// whatever the sender fills in.
        /// </summary>
        [JsonProperty("from")]
        public string From { get; set; }

        /// <summary>Files attached to the reply. Omitted or empty when there are none.</summary>
        [JsonProperty("attachments")]
        public List<ThreadReplyAttachmentUpload> Attachments { get; set; }

        /// <summary>
        /// Who wrote it. Optional: the app has no sign-in yet, so the backend
        /// falls back to the same fixed label the audit log uses.
        /// </summary>
        [JsonProperty("updatedBy")]
        public string UpdatedBy { get; set; }
    }

    /// <summary>One file saved against a reply, as the history lists it.</summary>
    public class ThreadReplyAttachmentRow
    {
        [JsonProperty("id")]
        public int Id { get; set; }

        /// <summary>Name to show. Not necessarily what is on disk — see storedName.</summary>
        [JsonProperty("fileName")]
        public string FileName { get; set; }

        /// <summary>
        /// Name to ask for when downloading it, which is what the file is
        /// actually called under the reply's folder.
        /// </summary>
        [JsonProperty("storedName")]
        public string StoredName { get; set; }

        /// <summary>Lower-case, no dot, e.g. 'pdf'. '' when there is none.</summary>
        [JsonProperty("extension")]
        public string Extension { get; set; }

        [JsonProperty("sizeBytes")]
        public long SizeBytes { get; set; }

        /// <summary>True for the types a browser renders in place rather than downloading.</summary>
        [JsonProperty("isImage")]
        public bool IsImage { get; set; }
    }

    /// <summary>
    /// One reply already written on a thread, as the popup replays it.
    ///
    /// Addresses come back joined rather than as lists: the history is read
    /// only, so there is nothing to edit them with and nothing to gain from
    /// splitting them apart again.
    /// </summary>
    public class ThreadReplyRow
    {
        [JsonProperty("id")]
        public int Id { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>The ticket open when it was written, e.g. 'TKT-2026-000377'. '' when there was none.</summary>
        [JsonProperty("ticketId")]
        public string TicketId { get; set; }

        [JsonProperty("to")]
        public string To { get; set; }

        [JsonProperty("cc")]
        public string Cc { get; set; }

        [JsonProperty("bcc")]
        public string Bcc { get; set; }

        [JsonProperty("subject")]
        public string Subject { get; set; }

        [JsonProperty("body")]
        public string Body { get; set; }

        /// <summary>'Saved' until there is a transport to move it past that.</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        [JsonProperty("createdBy")]
        public string CreatedBy { get; set; }

        /// <summary>When it was saved, ISO-8601.</summary>
        [JsonProperty("createdOn")]
        public string CreatedOn { get; set; }

        [JsonProperty("attachments")]
        public List<ThreadReplyAttachmentRow> Attachments { get; set; }
    }

    /// <summary>
    /// Response for GET api/emailautomation/thread-replies?threadId=... and for
    /// POST api/emailautomation/save-thread-reply.
    ///
    /// The save returns the whole list, not just the row it wrote, so the popup
    /// repaints its history from one call instead of two.
    /// </summary>
    public class ThreadRepliesResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        [JsonProperty("replies")]
        public List<ThreadReplyRow> Replies { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>
    /// One mail that came in on a thread, from main_email_messages.
    ///
    /// Only what the Alert Response popup's history shows: the subject, when it
    /// arrived and what it said. The classifier's columns stay in the table.
    /// </summary>
    public class ThreadMessageRow
    {
        /// <summary>[Message Key], the mail's own Message-ID. Unique per message.</summary>
        [JsonProperty("messageKey")]
        public string MessageKey { get; set; }

        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>
        /// [Received Time] as ISO-8601 in the same shape PRIDE_EMAIL_REPLY's
        /// Created_On is sent, so the popup can interleave the two by time. The
        /// raw stored text when it would not parse.
        /// </summary>
        [JsonProperty("receivedTime")]
        public string ReceivedTime { get; set; }

        [JsonProperty("subject")]
        public string Subject { get; set; }

        [JsonProperty("messageText")]
        public string MessageText { get; set; }
    }

    /// <summary>Response for GET api/emailautomation/thread-messages?threadId=...</summary>
    public class ThreadMessagesResponse
    {
        [JsonProperty("threadId")]
        public string ThreadId { get; set; }

        /// <summary>Oldest first, by [Received Time].</summary>
        [JsonProperty("messages")]
        public List<ThreadMessageRow> Messages { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }
}
