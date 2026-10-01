using EmailAutomation.Models;
using EmailAutomation.Services;
using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data;
using System.Data.SqlClient;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Hosting;
using System.Web.Http;
using System.Web.Http.Cors;

namespace EmailAutomation.Controllers
{
    [EnableCors(origins: "*", headers: "Content-Type, Authorization", methods: "GET, POST, PUT, DELETE")]
    /// <summary>
    /// Serves the daily email reports from the main_email_receipts and
    /// main_email_receipt_details tables in the database named by the
    /// "myConnection" connection string in Web.config.
    ///
    /// These replaced the per-day main_email_receipts_{date}.csv /
    /// main_email_receipt_details_{date}.csv files: same columns and values, one
    /// table instead of a file per day. The bank statement workbooks are still
    /// files — only the report data moved.
    /// </summary>
    //[RoutePrefix("emailautomation")]
    [RoutePrefix("api/emailautomation")]
    public class EmailAutomationController : ApiController
    {
        // ── SQL: the report tables ───────────────────────────────────

        /// <summary>
        /// The two tables the reports now live in. They replaced the
        /// main_email_receipts_{date}.csv / main_email_receipt_details_{date}.csv
        /// files: same columns, same values, one table instead of a file per day.
        /// </summary>
        private const string ReceiptsTable = "main_email_receipts";
        private const string ReceiptDetailsTable = "main_email_receipt_details";

        /// <summary>
        /// Project → its collection and SDR/MNGL/GST accounts. Read-only master,
        /// maintained outside this app; the payment cards offer its two accounts
        /// for whichever project the thread belongs to.
        /// </summary>
        private const string ProjectBankAccountTable = "PRIDE_PROJECT_BANK_ACCOUNT_MASTER";

        // ── The Agreement Workflow's thirteen steps ───────────────────

        /// <summary>
        /// One stage of the Agreement Workflow: the key the API is called with,
        /// the title the pipeline card shows, and the column its verdict is
        /// written to.
        /// </summary>
        private sealed class AgreementStepDefinition
        {
            public AgreementStepDefinition(string stepKey, string title, string column)
            {
                StepKey = stepKey;
                Title = title;
                Column = column;
            }

            /// <summary>What a request names this step by, e.g. "agreement-drafting".</summary>
            public string StepKey { get; private set; }

            /// <summary>Display title, and the value written to [Action].</summary>
            public string Title { get; private set; }

            /// <summary>
            /// The verdict column, snake_case and with no spaces. Its stamp is
            /// this plus "_Date" - see AgreementStampColumn.
            /// </summary>
            public string Column { get; private set; }

            /// <summary>What [Workflow Status] reads while the thread waits here.</summary>
            public string PendingStatus { get { return "Pending " + Title; } }
        }

        /// <summary>
        /// The thirteen stages a Non-Payment thread about an agreement runs
        /// through, in order, between Unit Match and the reply that ends it.
        ///
        /// Only threads that pass IsAgreementThread have these steps at all;
        /// every other thread's pipeline is untouched by this table.
        ///
        /// This is the ONE place an agreement column name is spelled on the
        /// backend. The read list, the writable whitelist and the stamp map are
        /// all built from it, and an incoming stepKey is resolved against it -
        /// which is also what keeps a caller from naming a column of their own,
        /// the same guard the older whitelists provide.
        /// </summary>
        private static readonly AgreementStepDefinition[] AgreementSteps =
        {
            new AgreementStepDefinition("booking-kyc",              "Booking & KYC Verification",     "Booking_KYC_Verification"),
            new AgreementStepDefinition("agreement-drafting",       "Agreement Drafting",             "Agreement_Drafting"),
            new AgreementStepDefinition("sdr-bsl-coordination",     "SDR / BSL Coordination",         "SDR_BSL_Coordination"),
            new AgreementStepDefinition("agreement-approval",       "Agreement Approval",             "Agreement_Approval"),
            new AgreementStepDefinition("payment-erp-update",       "Payment & ERP Update",           "Payment_ERP_Update"),
            new AgreementStepDefinition("document-preparation",     "Document Preparation",           "Document_Preparation"),
            new AgreementStepDefinition("agreement-execution",      "Agreement Execution / Signature","Agreement_Execution"),
            new AgreementStepDefinition("stamp-duty-challan",       "Stamp Duty Challan",             "Stamp_Duty_Challan"),
            new AgreementStepDefinition("registration-data",        "Registration Data Processing",   "Registration_Data_Processing"),
            new AgreementStepDefinition("registration-scheduling",  "Registration Scheduling",        "Registration_Scheduling"),
            new AgreementStepDefinition("ho-signature",             "HO Signature Process",           "HO_Signature_Process"),
            new AgreementStepDefinition("registration-appointment", "Registration Appointment",       "Registration_Appointment"),
            new AgreementStepDefinition("ghoshvara-verification",   "Ghoshvara Verification",         "Ghoshvara_Verification")
        };

        /// <summary>The stamp that goes with one agreement verdict column.</summary>
        private static string AgreementStampColumn(AgreementStepDefinition step)
        {
            return step.Column + "_Date";
        }

        /// <summary>
        /// The twenty-six agreement columns as a SELECT tail, leading comma and
        /// all, for appending to ReceiptColumns. Verdict then stamp, in step
        /// order, so a SELECT * -style read of the tail reads as the pipeline runs.
        /// </summary>
        private static readonly string AgreementStepColumnList =
            string.Concat(AgreementSteps.Select(step =>
                $", [{step.Column}], [{AgreementStampColumn(step)}]"));

        /// <summary>
        /// The receipt columns every read selects, in the order ReadReceiptRow expects.
        /// Shared so the whole-day read and the single-thread read cannot drift apart.
        ///
        /// The Agreement Workflow's twenty-six columns are appended by the static
        /// constructor rather than typed in here, so their spelling lives in
        /// AgreementSteps alone — see that table.
        /// </summary>
        private static readonly string ReceiptColumns =
            "[Email Receipts ID], [Thread ID], Category, [Run Date], [Email Date], [Email Subject], " +
            "[Customer Name], Project, [Sub Project], Unit, [Customer Sender], [Email Link], [Email Body], " +
            "[Forward Details], Intent, [Sub-Intent], Sentiment, [Action Required], Reason, Confidence, " +
            "[Customer Specific], [AI Customer Email], [Workflow Status], [Turn Around Date & Time], " +
            "Status, Remark, [Customer Email Match], [Unit Match], [Assigned To], [Action], [Action Status], " +
            "[Alert Received], [Latest Customer Reply], " +
            // When each step matched, for the pipeline cards - see MatchStampColumns.
            "[Customer Email Match Date], [Unit Match Date]" +
            AgreementStepColumnList;

        /// <summary>
        /// Columns a step is allowed to write back. The names are only ever supplied
        /// by the code below, never by a caller, but the update runs them through
        /// this list before bracketing them into the SQL so a column name can never
        /// become an injection point.
        ///
        /// The thirteen Agreement verdict columns are appended by the static
        /// constructor. Their thirteen stamps are deliberately left out, exactly as
        /// the four older stamps are - see MatchStampColumns.
        /// </summary>
        private static readonly string[] WritableReceiptColumns =
            new[]
            {
                "Status", "Remark", "Customer Email Match", "Unit Match", "Workflow Status", "Assigned To",
                "Action", "Action Status"
            }
            .Concat(AgreementSteps.Select(step => step.Column))
            .ToArray();

        private static readonly string[] WritableDetailColumns =
        {
            "Instrument Match", "Bank Reco Match", "Dublicate Match", "Workflow Status", "Remark",
            "EntryStatus", "CashHeaderAccount", "EditType", "Bank Reco Note",
            // Written by the pipeline as well as edited by a reviewer: Instrument
            // Match fills a blank one in with its default — see the three
            // ApplyDefault* helpers.
            "Payment Mode", "Customer Account Number", "Customer Bank"
        };

        /// <summary>
        /// The timestamp column that goes with each step's verdict column.
        ///
        /// A verdict and the time it was reached are one fact, so they are written
        /// by one statement: whenever an update sets a verdict column, the helpers
        /// append `[&lt;its stamp&gt;] = GETDATE()` to the same SET list. No call
        /// site has to remember to do it, the verdict and its stamp can never
        /// disagree about what was decided, and it costs no extra round trip.
        ///
        /// GETDATE() rather than a parameter because the SLA countdown, the audit
        /// log and the ticket table are all stamped by the database — one clock,
        /// and no skew between the app server and the row it is writing.
        ///
        /// Written only when the verdict is a match. An Unmatch leaves whatever
        /// is already there alone, so the column always names a moment the step
        /// actually matched rather than merely ran - which is how the UI reads it,
        /// and the reason a date must never appear beside an UNMATCHED row.
        ///
        /// Deliberately NOT in the writable lists above. Those gate values that
        /// arrive from outside; a stamp is never passed in, only appended here, so
        /// keeping it out means nothing can set it to an arbitrary string. The
        /// name is safe to bracket into the SQL for the same reason the whitelists
        /// are — it comes from this map, never from a request.
        /// </summary>
        private static readonly Dictionary<string, string> MatchStampColumns = BuildMatchStampColumns();

        /// <summary>
        /// The four original verdict/stamp pairs, plus one per Agreement step.
        ///
        /// The agreement pairs are added from AgreementSteps rather than typed
        /// out, which is what lets every one of those thirteen steps be stamped
        /// by MatchStampAssignment without a line of new code at the call sites.
        /// </summary>
        private static Dictionary<string, string> BuildMatchStampColumns()
        {
            var columns = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "Customer Email Match", "Customer Email Match Date" },
                { "Unit Match",           "Unit Match Date" },
                { "Instrument Match",     "Instrument Match Date" },
                { "Bank Reco Match",      "Bank Reco Match Date" }
            };

            foreach (var step in AgreementSteps)
            {
                columns[step.Column] = AgreementStampColumn(step);
            }

            return columns;
        }

        /// <summary>
        /// The `[stamp] = GETDATE()` assignment for a verdict column, or null when
        /// the column carries no stamp or the verdict being written is not a
        /// match. Every update helper appends this to its SET list, so the three
        /// of them stamp identically.
        ///
        /// Null for an Unmatch rather than an assignment to NULL: the step may
        /// have matched on an earlier run, and nothing here is in a position to
        /// say that the earlier match did not happen. See ClearStaleMatchStamps
        /// in App_Data/Scripts if a verdict that has since turned back to Unmatch
        /// needs its stamp retired.
        /// </summary>
        private static string MatchStampAssignment(string columnName, string value)
        {
            string stampColumn;

            if (!MatchStampColumns.TryGetValue(columnName ?? string.Empty, out stampColumn))
            {
                return null;
            }

            return IsMatchedVerdict(value) ? $"[{stampColumn}] = GETDATE()" : null;
        }

        /// <summary>
        /// True for the one value that counts as a match. MatchedValue and
        /// InstrumentMatchedValue are the same word - the receipts steps and the
        /// payment steps agree on it - so one test serves every stamped column.
        /// </summary>
        private static bool IsMatchedVerdict(string value)
        {
            return string.Equals(
                (value ?? string.Empty).Trim(), MatchedValue, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// A whole SET list for the two detail helpers, which each write exactly
        /// one column: the column itself, and its timestamp when it has one and
        /// the verdict is a match.
        /// </summary>
        private static string StampedAssignment(string columnName, string value)
        {
            var stamp = MatchStampAssignment(columnName, value);

            return stamp == null
                ? $"[{columnName}] = @value"
                : $"[{columnName}] = @value, {stamp}";
        }

        /// <summary>
        /// Columns a *reviewer* is allowed to correct from the UI, before a step
        /// is re-run against the corrected value.
        ///
        /// Deliberately disjoint from the two lists above: a step's own verdict
        /// columns are written by the pipeline and must never be settable from a
        /// dialog, and the source fields below are never written by a step.
        /// </summary>
        private static readonly string[] EditableReceiptColumns =
        {
            "Customer Sender", "Project", "Sub Project", "Unit"
        };

        private static readonly string[] EditableDetailColumns =
        {
            "Instrument Number", "Amount", "Customer Account Number", "CashHeaderAccount",
            // Instrument Match reads these too, so the reviewer has to be able to
            // supply them when the extractor found nothing.
            "Payment Mode", "Customer Bank"
        };

        /// <summary>
        /// The bank/loan payment table.
        ///
        /// One loan email covers many customers, so its payments cannot live in
        /// main_email_receipt_details, which is keyed on Thread ID alone: they
        /// are keyed on a [Customer Thread ID] instead ("&lt;Thread ID&gt;-&lt;n&gt;", one
        /// per customer), with one or more payment rows per customer.
        ///
        /// Same columns and same types as main_email_receipt_details, plus
        /// [Customer Thread ID] and the thread-level columns the receipts table
        /// holds for every other category - a loan customer has no receipts row
        /// of its own to keep them on. It has no [Run Date] and no [Email Date].
        /// </summary>
        private const string LoanReceiptDetailsTable = "dbo.PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS";

        /// <summary>
        /// The one [Category] whose payments live in LoanReceiptDetailsTable and
        /// whose unit of work is the customer rather than the email. Tested with
        /// IsLoanCategory, never compared against directly.
        /// </summary>
        private const string LoanCategory = "Payment - Loan/Bank";

        /// <summary>
        /// The detail columns a read selects, in the order the row mapper expects.
        /// Shared with the loan list below so the two cannot drift apart, the same
        /// reason ReceiptColumns is shared by the whole-day and single-thread reads.
        /// </summary>
        private const string ReceiptDetailColumns =
            "[Email Receipts Details ID], [Thread ID], [Run Date], [Payment No], [Customer Name], " +
            "Project, [Sub Project], Unit, [Instrument Number], Amount, [Payment Mode], [Customer Bank], " +
            "[Customer Account Number], [Verification Flag], [Workflow Status], Remark, [Instrument Match], " +
            "[Bank Reco Match], [Dublicate Match], CashHeaderAccount, EntryStatus, EditType, [Bank Reco Note], " +
            "[Instrument Match Date], [Bank Reco Match Date]";

        /// <summary>
        /// ReceiptDetailColumns for the loan table: [Customer Thread ID] in,
        /// [Run Date] out - the loan table has no such column, and nothing reads
        /// a payment row's run date.
        /// </summary>
        private const string LoanDetailColumns =
            "[Email Receipts Details ID], [Thread ID], [Customer Thread ID], [Payment No], [Customer Name], " +
            "Project, [Sub Project], Unit, [Instrument Number], Amount, [Payment Mode], [Customer Bank], " +
            "[Customer Account Number], [Verification Flag], [Workflow Status], Remark, [Instrument Match], " +
            "[Bank Reco Match], [Dublicate Match], CashHeaderAccount, EntryStatus, EditType, [Bank Reco Note], " +
            "[Instrument Match Date], [Bank Reco Match Date]";

        /// <summary>
        /// The values a loan customer thread owns that every other category keeps
        /// on its receipts row: the customer's own fields, and the thread-level
        /// state the pipeline writes.
        ///
        /// Read back out of the payment rows to build the customer's grid row -
        /// they hold the same value on every row of the customer thread, because
        /// that is how the thread-level writes put it there.
        /// </summary>
        private const string LoanThreadColumns =
            "[Customer Name], Project, [Sub Project], Unit, [Customer Sender], [Workflow Status], " +
            "Status, Remark, [Customer Email Match], [Unit Match], [Assigned To], [Action], [Action Status], " +
            "[Customer Email Match Date], [Unit Match Date]";

        /// <summary>
        /// The stored [Email Date] values that fall on one yyyy-MM-dd date.
        ///
        /// The column holds display text ("13-May-26"), not a date, so the API keeps
        /// taking yyyy-MM-dd and every stored value is parsed and compared here. A
        /// list rather than a single value because the same day could in principle
        /// be spelled more than one way.
        /// </summary>
        private static List<string> ResolveEmailDateValues(string date)
        {
            DateTime wanted;

            if (!DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out wanted))
            {
                return new List<string>();
            }

            var matches = MatchStoredEmailDates(CachedEmailDateValues(false), wanted);

            // A day the cache was filled before is indistinguishable from a day
            // that is not in the table at all, and the caller would report the
            // second for the first — "no row for that date" — on a thread that
            // had only just been loaded. So a miss, and only a miss, pays for a
            // fresh read; a hit is answered from what the last one saw.
            return matches.Count > 0
                ? matches
                : MatchStoredEmailDates(CachedEmailDateValues(true), wanted);
        }

        /// <summary>The stored labels that parse to one calendar date.</summary>
        private static List<string> MatchStoredEmailDates(List<string> stored, DateTime wanted)
        {
            var matches = new List<string>();

            foreach (var value in stored)
            {
                DateTime parsed;

                if (TryParseEmailDate(value, out parsed) && parsed.Date == wanted.Date)
                {
                    matches.Add(value);
                }
            }

            return matches;
        }

        /// <summary>
        /// How long the distinct [Email Date] labels may be reused before they
        /// are read again. Short: the set only changes when a new day's rows are
        /// loaded, and a date the cache has not got is re-read immediately
        /// anyway, so this only bounds how long a *deleted* day lingers.
        /// </summary>
        private static readonly TimeSpan EmailDateCacheLifetime = TimeSpan.FromSeconds(60);

        private static readonly object EmailDateCacheLock = new object();
        private static List<string> _emailDateCache;
        private static DateTime _emailDateCacheStamp;

        /// <summary>
        /// The distinct [Email Date] labels in the receipts table, cached.
        ///
        /// ResolveEmailDateValues sits at the top of every endpoint, so this
        /// DISTINCT ran once per request against the whole table — and while it
        /// ran it held shared locks across a table the pipeline's own UPDATEs
        /// were writing. That is the pairing Unit Match kept dying on: its three
        /// writes against another request's opening scan. Reading it once a
        /// minute instead of once a request takes most of those scans out of the
        /// picture entirely.
        /// </summary>
        private static List<string> CachedEmailDateValues(bool forceRefresh)
        {
            lock (EmailDateCacheLock)
            {
                if (!forceRefresh &&
                    _emailDateCache != null &&
                    DateTime.UtcNow - _emailDateCacheStamp < EmailDateCacheLifetime)
                {
                    return _emailDateCache;
                }
            }

            var values = ReadWithDeadlockRetry(ReadDistinctEmailDates);

            lock (EmailDateCacheLock)
            {
                _emailDateCache = values;
                _emailDateCacheStamp = DateTime.UtcNow;
            }

            return values;
        }

        /// <summary>
        /// Reads the distinct [Email Date] labels.
        ///
        /// READUNCOMMITTED because this query takes no shared locks under it, so
        /// it cannot be one half of a lock cycle no matter what else is writing.
        /// Safe for what it returns: a set of display labels used only to build
        /// the IN clause of the query that follows, and that query still reads
        /// committed data. A label glimpsed from an uncommitted insert simply
        /// finds no rows; one missed is a row not yet inserted, which is what the
        /// caller would have been told anyway.
        /// </summary>
        private static List<string> ReadDistinctEmailDates()
        {
            var values = new List<string>();

            var sql = $"SELECT DISTINCT [Email Date] FROM {ReceiptsTable} WITH (READUNCOMMITTED)";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        values.Add(ReadString(reader, "Email Date"));
                    }
                }
            }

            return values;
        }

        /// <summary>
        /// Runs a read, and runs it once more if SQL Server picks it as a
        /// deadlock victim (1205) or aborts a no-lock scan because rows moved
        /// under it (601).
        ///
        /// The reader's half of ExecuteWithDeadlockRetry, and it has to take the
        /// whole open-run-materialise cycle rather than a command: once a read
        /// has been rolled back there is no reader left to re-run, and the
        /// connection it was on is finished with.
        /// </summary>
        private static T ReadWithDeadlockRetry<T>(Func<T> read)
        {
            const int deadlockVictim = 1205;
            const int noLockScanAborted = 601;

            try
            {
                return read();
            }
            catch (SqlException ex) when (ex.Number == deadlockVictim || ex.Number == noLockScanAborted)
            {
                Thread.Sleep(120);

                return read();
            }
        }

        /// <summary>Reads an [Email Date] value such as "13-May-26".</summary>
        private static bool TryParseEmailDate(string value, out DateTime parsed)
        {
            var formats = new[]
            {
                "dd-MMM-yy", "dd-MMM-yyyy", "d-MMM-yy", "d-MMM-yyyy",
                "dd-MM-yyyy", "d-M-yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy"
            };

            return DateTime.TryParseExact((value ?? string.Empty).Trim(), formats,
                CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed);
        }

        /// <summary>
        /// Builds "IN (@d0, @d1, …)" for a set of [Email Date] values and adds the
        /// parameters to the command.
        /// </summary>
        private static string AddEmailDateParameters(SqlCommand command, List<string> emailDates)
        {
            var names = new List<string>();

            for (var i = 0; i < emailDates.Count; i++)
            {
                var name = "@emailDate" + i;
                command.Parameters.Add(name, SqlDbType.VarChar).Value = emailDates[i];
                names.Add(name);
            }

            return string.Join(", ", names);
        }

        /// <summary>
        /// Builds "IN (@threadKey0, @threadKey1, …)" for a set of thread keys and
        /// adds the parameters to the command. AddEmailDateParameters' sibling.
        /// </summary>
        private static string AddThreadKeyParameters(SqlCommand command, List<string> threadKeys)
        {
            var names = new List<string>();

            for (var i = 0; i < threadKeys.Count; i++)
            {
                var name = "@threadKey" + i;
                command.Parameters.Add(name, SqlDbType.VarChar).Value = threadKeys[i] ?? string.Empty;
                names.Add(name);
            }

            return string.Join(", ", names);
        }

        /// <summary>Every receipt row for one report date.</summary>
        private static List<EmailReceiptRow> ReadReceipts(List<string> emailDates)
        {
            var rows = new List<EmailReceiptRow>();

            if (emailDates.Count == 0)
            {
                return rows;
            }

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand())
            {
                command.Connection = connection;

                var inClause = AddEmailDateParameters(command, emailDates);

                command.CommandText =
                    $"SELECT {ReceiptColumns} FROM {ReceiptsTable} WHERE [Email Date] IN ({inClause})";

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        rows.Add(ReadReceiptRow(reader));
                    }
                }
            }

            return rows;
        }

        private static EmailReceiptRow ReadReceiptRow(IDataRecord reader)
        {
            var row = new EmailReceiptRow
            {
                EmailReceiptsId = ReadString(reader, "Email Receipts ID"),
                ThreadId = ReadString(reader, "Thread ID"),
                Category = ReadString(reader, "Category"),
                RunDate = ReadString(reader, "Run Date"),
                EmailDate = ReadString(reader, "Email Date"),
                EmailSubject = ReadString(reader, "Email Subject"),
                CustomerName = ReadString(reader, "Customer Name"),
                Project = ReadString(reader, "Project"),
                SubProject = ReadString(reader, "Sub Project"),
                Unit = ReadString(reader, "Unit"),
                CustomerSender = ReadString(reader, "Customer Sender"),
                EmailLink = ReadString(reader, "Email Link"),
                EmailBody = ReadString(reader, "Email Body"),
                ForwardDetails = ReadString(reader, "Forward Details"),
                Intent = ReadString(reader, "Intent"),
                SubIntent = ReadString(reader, "Sub-Intent"),
                Sentiment = ReadString(reader, "Sentiment"),
                ActionRequired = ReadString(reader, "Action Required"),
                Reason = ReadString(reader, "Reason"),
                Confidence = ReadString(reader, "Confidence"),
                CustomerSpecific = ReadString(reader, "Customer Specific"),
                AiCustomerEmail = ReadString(reader, "AI Customer Email"),
                WorkflowStatus = ReadString(reader, "Workflow Status"),
                TurnAroundDateTime = ReadString(reader, "Turn Around Date & Time"),
                Status = ReadString(reader, "Status"),
                Remark = ReadString(reader, "Remark"),
                CustomerEmailMatch = ReadString(reader, "Customer Email Match"),
                UnitMatch = ReadString(reader, "Unit Match"),
                CustomerEmailMatchDate = ReadIsoDateTime(reader, "Customer Email Match Date"),
                UnitMatchDate = ReadIsoDateTime(reader, "Unit Match Date"),
                AssignedTo = ReadString(reader, "Assigned To"),
                ActionName = ReadString(reader, "Action"),
                ActionStatus = NormalizeActionStatus(ReadString(reader, "Action Status")),
                AlertReceived = ReadBool(reader, "Alert Received"),
                LatestCustomerReply = ReadString(reader, "Latest Customer Reply")
            };

            ReadAgreementSteps(reader, row);

            return row;
        }

        /// <summary>
        /// The thirteen agreement verdicts and their stamps, keyed by step key.
        ///
        /// Two maps rather than twenty-six properties: the steps are a list, not
        /// thirteen unrelated facts, and every reader on either side walks them
        /// as one. A row that has run none of them carries two empty maps, which
        /// is exactly how a non-agreement thread reads.
        /// </summary>
        private static void ReadAgreementSteps(IDataRecord reader, EmailReceiptRow row)
        {
            row.AgreementSteps = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            row.AgreementStepDates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (var step in AgreementSteps)
            {
                var verdict = ReadString(reader, step.Column);
                var stamp = ReadIsoDateTime(reader, AgreementStampColumn(step));

                // Only what has actually been decided. A blank verdict is the
                // absence of a run, and putting it in the map would make every
                // thread look as though it had thirteen steps underway.
                if (!string.IsNullOrWhiteSpace(verdict))
                {
                    row.AgreementSteps[step.StepKey] = verdict;
                }

                if (!string.IsNullOrWhiteSpace(stamp))
                {
                    row.AgreementStepDates[step.StepKey] = stamp;
                }
            }
        }

        /// <summary>
        /// One thread's receipt row for a date, or null when it is not there.
        ///
        /// Filtered in SQL rather than by reading the whole day and picking the row
        /// out in memory: every pipeline step calls this, and a busy day's report
        /// was being pulled across the wire in full — email bodies and all — each
        /// time, only for one row of it to be used.
        /// </summary>
        private static EmailReceiptRow ReadReceiptForThread(List<string> emailDates, string threadId)
        {
            if (emailDates.Count == 0)
            {
                return null;
            }

            // Retried on a deadlock like the writes are: until the lookup index
            // is in place this is a table scan, and a scan is what SQL Server
            // picks as the victim when it meets a step's UPDATE head on.
            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand())
                {
                    command.Connection = connection;
                    command.CommandTimeout = SqlCommandTimeoutSeconds;

                    var inClause = AddEmailDateParameters(command, emailDates);

                    command.CommandText =
                        $"SELECT {ReceiptColumns} FROM {ReceiptsTable} " +
                        $"WHERE [Thread ID] = @threadId AND [Email Date] IN ({inClause})";

                    command.Parameters.Add("@threadId", SqlDbType.VarChar).Value = threadId ?? string.Empty;

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        return reader.Read() ? ReadReceiptRow(reader) : null;
                    }
                }
            });
        }

        /// <summary>
        /// A thread's payment rows. Neither details table has an [Email Date] of
        /// its own, so payments are keyed on the thread alone — as they were in
        /// the CSV.
        ///
        /// Which table, and which column the key matches, comes from the binding:
        /// a classic thread's payments sit in main_email_receipt_details under
        /// [Thread ID], a loan customer's in the loan table under
        /// [Customer Thread ID].
        /// </summary>
        private static List<EmailReceiptDetailRow> ReadReceiptDetails(ThreadBinding binding)
        {
            var rows = new List<EmailReceiptDetailRow>();

            // Table name and key column come from the binding, which only ever
            // holds the private constants above — never anything a caller sent.
            // The thread key itself stays a parameter.
            var sql =
                $"SELECT {(binding.IsLoan ? LoanDetailColumns : ReceiptDetailColumns)} " +
                $"FROM {binding.DetailsTable} WHERE [{binding.ThreadKeyColumn}] = @threadKey";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        rows.Add(new EmailReceiptDetailRow
                        {
                            EmailReceiptsDetailsId = ReadString(reader, "Email Receipts Details ID"),
                            ThreadId = ReadString(reader, "Thread ID"),
                            CustomerThreadId =
                                binding.IsLoan ? ReadString(reader, "Customer Thread ID") : string.Empty,
                            // The loan table has no [Run Date] column. Nothing
                            // renders a payment row's run date — only the receipt
                            // row's is shown — so it is left empty rather than
                            // borrowed from the parent email to fill the gap.
                            RunDate = binding.IsLoan ? string.Empty : ReadString(reader, "Run Date"),
                            PaymentNo = ReadString(reader, "Payment No"),
                            CustomerName = ReadString(reader, "Customer Name"),
                            Project = ReadString(reader, "Project"),
                            SubProject = ReadString(reader, "Sub Project"),
                            Unit = ReadString(reader, "Unit"),
                            InstrumentNumber = ReadString(reader, "Instrument Number"),
                            Amount = ReadString(reader, "Amount"),
                            PaymentMode = ReadString(reader, "Payment Mode"),
                            CustomerBank = ReadString(reader, "Customer Bank"),
                            CustomerAccountNumber = ReadString(reader, "Customer Account Number"),
                            VerificationFlag = ReadString(reader, "Verification Flag"),
                            WorkflowStatus = ReadString(reader, "Workflow Status"),
                            Remark = ReadString(reader, "Remark"),
                            InstrumentMatch = ReadString(reader, "Instrument Match"),
                            BankRecoMatch = ReadString(reader, "Bank Reco Match"),
                            InstrumentMatchDate = ReadIsoDateTime(reader, "Instrument Match Date"),
                            BankRecoMatchDate = ReadIsoDateTime(reader, "Bank Reco Match Date"),
                            DublicateMatch = ReadString(reader, "Dublicate Match"),
                            CashHeaderAccount = ReadString(reader, "CashHeaderAccount"),
                            EntryStatus = ReadString(reader, "EntryStatus"),
                            EditType = ReadString(reader, "EditType"),
                            BankRecoNote = ReadString(reader, "Bank Reco Note")
                        });
                    }
                }
            }

            return rows;
        }

        /// <summary>
        /// Which tables one grid row's values live behind, and which column
        /// identifies it in them.
        ///
        /// Every category but one answers this the same way: a row is a
        /// main_email_receipts.[Thread ID], its payments are the
        /// main_email_receipt_details rows carrying that Thread ID, and its
        /// thread-level state — Status, [Assigned To], each step's verdict —
        /// sits on the receipts row itself.
        ///
        /// 'Payment - Loan/Bank' answers it differently. A row there is one
        /// customer of a shared email, so its payments *and* its thread-level
        /// state both live in the loan table keyed on [Customer Thread ID], and
        /// its receipts row — the email — is shared with every other customer on
        /// it and must never be written: one customer's verdict would otherwise
        /// land on all nineteen.
        ///
        /// Resolved once per request and handed to the data helpers in place of a
        /// bare thread id, so no helper has to re-decide which table it is
        /// talking to and no two of them can decide differently.
        /// </summary>
        private sealed class ThreadBinding
        {
            /// <summary>
            /// What the caller sent: a [Thread ID], or a loan [Customer Thread ID].
            /// The identity of the row on screen, and the key every read and write
            /// below matches on.
            /// </summary>
            public string ThreadKey { get; set; }

            /// <summary>
            /// The email itself — main_email_receipts.[Thread ID]. The same as
            /// ThreadKey for every category but loan, where it is the parent of the
            /// customer thread. What the things that are still the email's are
            /// named after: its [Email Date], its subject, its attachment folder.
            /// </summary>
            public string ParentThreadId { get; set; }

            /// <summary>True when ThreadKey is a loan [Customer Thread ID].</summary>
            public bool IsLoan { get; set; }

            /// <summary>Which table holds the payment rows.</summary>
            public string DetailsTable { get; set; }

            /// <summary>The column in DetailsTable that ThreadKey matches.</summary>
            public string ThreadKeyColumn { get; set; }

            /// <summary>
            /// Where a thread-level column is read and written: the receipts row
            /// for a classic thread, the customer's own payment rows for a loan
            /// one — every one of them, since there is no single row to hold it.
            /// </summary>
            public string ThreadColumnTable { get; set; }
        }

        /// <summary>The [Thread ID] column, which a classic binding keys on.</summary>
        private const string ThreadIdColumn = "Thread ID";

        /// <summary>The [Customer Thread ID] column, which a loan binding keys on.</summary>
        private const string CustomerThreadIdColumn = "Customer Thread ID";

        /// <summary>
        /// Works out which tables a thread key belongs to.
        ///
        /// One indexed seek answers both questions at once — whether the key is a
        /// loan customer thread, and which email it belongs to — and it is made
        /// unconditionally rather than from a flag the caller passes, because an
        /// id's shape cannot tell the two apart: "THR-3bd00513-19" is a perfectly
        /// legal classic [Thread ID]. Asking the table is proof; reading the id is
        /// a guess, and a wrong guess here writes one customer's verdict to the
        /// wrong table without failing.
        ///
        /// A key the loan table has never held binds classically, so an endpoint
        /// answers with the 404 it already has for a thread that is not there.
        /// </summary>
        private static ThreadBinding ResolveBinding(string threadKey)
        {
            var key = (threadKey ?? string.Empty).Trim();
            var parentThreadId = key.Length == 0 ? null : ReadLoanParentThreadId(key);

            if (parentThreadId == null)
            {
                return new ThreadBinding
                {
                    ThreadKey = key,
                    ParentThreadId = key,
                    IsLoan = false,
                    DetailsTable = ReceiptDetailsTable,
                    ThreadKeyColumn = ThreadIdColumn,
                    ThreadColumnTable = ReceiptsTable
                };
            }

            return new ThreadBinding
            {
                ThreadKey = key,
                ParentThreadId = parentThreadId,
                IsLoan = true,
                DetailsTable = LoanReceiptDetailsTable,
                ThreadKeyColumn = CustomerThreadIdColumn,
                ThreadColumnTable = LoanReceiptDetailsTable
            };
        }

        /// <summary>
        /// The email a loan customer thread belongs to, or null when the key is
        /// not a loan customer thread at all.
        ///
        /// An empty string rather than null means the loan table does hold the
        /// customer thread but has no parent recorded for it — still a loan
        /// binding, because that is where its rows are, whatever became of the
        /// email.
        /// </summary>
        private static string ReadLoanParentThreadId(string customerThreadId)
        {
            var sql =
                $"SELECT TOP 1 ISNULL([{ThreadIdColumn}], '') FROM {LoanReceiptDetailsTable} " +
                $"WHERE [{CustomerThreadIdColumn}] = @customerThreadId";

            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@customerThreadId", SqlDbType.VarChar).Value = customerThreadId;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value
                        ? null
                        : Convert.ToString(value).Trim();
                }
            });
        }

        /// <summary>
        /// One loan customer's values, folded together from its payment rows.
        ///
        /// Every field here holds the same value on each of the customer's
        /// payment rows — the customer's own fields because the extractor repeats
        /// them per payment, the thread-level ones because that is how the
        /// thread-level writes put them there — so reading the first that says
        /// anything reads the customer's value.
        /// </summary>
        private sealed class LoanCustomerThread
        {
            public string CustomerThreadId { get; set; }
            public string ParentThreadId { get; set; }
            public string CustomerName { get; set; }
            public string Project { get; set; }
            public string SubProject { get; set; }
            public string Unit { get; set; }
            public string CustomerSender { get; set; }
            public string WorkflowStatus { get; set; }
            public string Status { get; set; }
            public string Remark { get; set; }
            public string CustomerEmailMatch { get; set; }
            public string CustomerEmailMatchDate { get; set; }
            public string UnitMatchDate { get; set; }
            public string UnitMatch { get; set; }
            public string AssignedTo { get; set; }
            public string ActionName { get; set; }
            public string ActionStatus { get; set; }
        }

        /// <summary>
        /// The loan customer threads under a set of keys — every customer of a set
        /// of emails when keyColumn is [Thread ID], one named customer when it is
        /// [Customer Thread ID].
        ///
        /// Ordered by payment number so "the first value that says anything" is
        /// the first payment's, rather than whichever row the storage engine
        /// happened to hand back first; [Payment No] is nullable, hence the CASE
        /// keeping NULLs last instead of first.
        /// </summary>
        private static List<LoanCustomerThread> ReadLoanCustomerThreads(string keyColumn, List<string> keys)
        {
            if (keys.Count == 0)
            {
                return new List<LoanCustomerThread>();
            }

            // Until the loan table's indexes are in place this is a heap scan, and
            // a scan is what SQL Server picks as the victim when it meets a step's
            // UPDATE head on — so it is retried like the other reads.
            return ReadWithDeadlockRetry(() =>
            {
                var threads = new List<LoanCustomerThread>();

                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand())
                {
                    command.Connection = connection;
                    command.CommandTimeout = SqlCommandTimeoutSeconds;

                    var inClause = AddThreadKeyParameters(command, keys);

                    command.CommandText =
                        $"SELECT [{ThreadIdColumn}], [{CustomerThreadIdColumn}], {LoanThreadColumns} " +
                        $"FROM {LoanReceiptDetailsTable} WHERE [{keyColumn}] IN ({inClause}) " +
                        $"ORDER BY [{CustomerThreadIdColumn}], " +
                        "CASE WHEN [Payment No] IS NULL THEN 1 ELSE 0 END, [Payment No], " +
                        "[Email Receipts Details ID]";

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        LoanCustomerThread current = null;

                        while (reader.Read())
                        {
                            var customerThreadId = ReadString(reader, CustomerThreadIdColumn);

                            if (customerThreadId.Length == 0)
                            {
                                // A payment row with no customer of its own. There
                                // is nothing to list it under, and folding it into
                                // the customer before it would put one customer's
                                // payment on another's ticket.
                                continue;
                            }

                            if (current == null || !string.Equals(
                                    current.CustomerThreadId, customerThreadId, StringComparison.OrdinalIgnoreCase))
                            {
                                current = new LoanCustomerThread
                                {
                                    CustomerThreadId = customerThreadId,
                                    ParentThreadId = ReadString(reader, ThreadIdColumn)
                                };

                                threads.Add(current);
                            }

                            FoldLoanCustomerRow(current, reader);
                        }
                    }
                }

                return threads;
            });
        }

        /// <summary>Takes each value the customer does not have yet from one more of its payment rows.</summary>
        private static void FoldLoanCustomerRow(LoanCustomerThread thread, IDataRecord reader)
        {
            thread.CustomerName = FirstNonBlank(thread.CustomerName, ReadString(reader, "Customer Name"));
            thread.Project = FirstNonBlank(thread.Project, ReadString(reader, "Project"));
            thread.SubProject = FirstNonBlank(thread.SubProject, ReadString(reader, "Sub Project"));
            thread.Unit = FirstNonBlank(thread.Unit, ReadString(reader, "Unit"));
            thread.CustomerSender = FirstNonBlank(thread.CustomerSender, ReadString(reader, "Customer Sender"));
            thread.WorkflowStatus = FirstNonBlank(thread.WorkflowStatus, ReadString(reader, "Workflow Status"));
            thread.Status = FirstNonBlank(thread.Status, ReadString(reader, "Status"));
            thread.Remark = FirstNonBlank(thread.Remark, ReadString(reader, "Remark"));
            thread.CustomerEmailMatch =
                FirstNonBlank(thread.CustomerEmailMatch, ReadString(reader, "Customer Email Match"));
            thread.UnitMatch = FirstNonBlank(thread.UnitMatch, ReadString(reader, "Unit Match"));
            thread.CustomerEmailMatchDate =
                FirstNonBlank(thread.CustomerEmailMatchDate, ReadIsoDateTime(reader, "Customer Email Match Date"));
            thread.UnitMatchDate =
                FirstNonBlank(thread.UnitMatchDate, ReadIsoDateTime(reader, "Unit Match Date"));
            thread.AssignedTo = FirstNonBlank(thread.AssignedTo, ReadString(reader, "Assigned To"));
            thread.ActionName = FirstNonBlank(thread.ActionName, ReadString(reader, "Action"));
            thread.ActionStatus = FirstNonBlank(thread.ActionStatus, ReadString(reader, "Action Status"));
        }

        /// <summary>
        /// The earlier of two values unless it says nothing, in which case the
        /// later one. IsBlankValue's idea of nothing, so the "N/A" the extractor
        /// writes where it found no value counts as a gap rather than as an answer.
        /// </summary>
        private static string FirstNonBlank(string current, string candidate)
        {
            return IsBlankValue(current) ? candidate : current;
        }

        /// <summary>
        /// One receipt row per loan customer, in place of the one row per loan email.
        ///
        /// A loan email is a batch. The row main_email_receipts holds for it
        /// carries the email — subject, body, date, intent — and nothing anyone
        /// can act on, because the customers, their units and their payments are
        /// all in the loan table. So the grid lists the customers instead: each
        /// one carries the email's own fields unchanged, and its own customer
        /// fields and thread-level state from the loan table.
        ///
        /// Called by both the receipts read and the ticket step, so the rows on
        /// screen and the rows that get a ticket are the same population by
        /// construction — one ticket per row listed, and none for a thread that is
        /// not listed at all. The same argument the FE's isListedCategory makes
        /// for sharing one predicate between the grid and the KPI ribbon.
        ///
        /// A loan thread with no rows in the loan table contributes nothing: its
        /// customers have not been extracted yet, and there is nothing to act on.
        /// </summary>
        private static List<EmailReceiptRow> ExpandLoanReceipts(List<EmailReceiptRow> receiptRows)
        {
            var rows = new List<EmailReceiptRow>();

            var parents = receiptRows
                .Where(row => IsLoanCategory(row.Category) && !string.IsNullOrWhiteSpace(row.ThreadId))
                .GroupBy(row => row.ThreadId.Trim(), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);

            if (parents.Count == 0)
            {
                return rows;
            }

            foreach (var customer in ReadLoanCustomerThreads(ThreadIdColumn, parents.Keys.ToList()))
            {
                EmailReceiptRow parent;

                if (parents.TryGetValue(customer.ParentThreadId ?? string.Empty, out parent))
                {
                    rows.Add(BuildLoanReceiptRow(parent, customer));
                }
            }

            return rows;
        }

        /// <summary>
        /// One loan customer as a receipt row: the email's row with the customer
        /// laid over it.
        ///
        /// Cloned rather than rebuilt field by field, so every column the email
        /// owns — subject, body, link, intent, sentiment, turn around, alert — is
        /// inherited by construction, and a column added to the receipts table
        /// later cannot be forgotten here.
        /// </summary>
        private static EmailReceiptRow BuildLoanReceiptRow(EmailReceiptRow parent, LoanCustomerThread customer)
        {
            var row = parent.Clone();

            // The customer is the row now. Its [Customer Thread ID] is what the
            // ticket is minted on, what the payment panel asks for and what every
            // write keys on — everything downstream is already keyed on "the row's
            // thread id", and for a loan row that is the customer. The email keeps
            // its own id alongside, for what is still the email's: its
            // attachments, its subject.
            row.ThreadId = customer.CustomerThreadId;
            row.CustomerThreadId = customer.CustomerThreadId;
            row.ParentThreadId = customer.ParentThreadId ?? string.Empty;

            row.CustomerName = customer.CustomerName ?? string.Empty;
            row.Project = customer.Project ?? string.Empty;
            row.SubProject = customer.SubProject ?? string.Empty;
            row.Unit = customer.Unit ?? string.Empty;
            row.CustomerSender = customer.CustomerSender ?? string.Empty;

            row.WorkflowStatus = customer.WorkflowStatus ?? string.Empty;
            row.Status = customer.Status ?? string.Empty;
            row.Remark = customer.Remark ?? string.Empty;
            row.CustomerEmailMatch = customer.CustomerEmailMatch ?? string.Empty;
            row.UnitMatch = customer.UnitMatch ?? string.Empty;
            row.CustomerEmailMatchDate = customer.CustomerEmailMatchDate ?? string.Empty;
            row.UnitMatchDate = customer.UnitMatchDate ?? string.Empty;
            row.AssignedTo = customer.AssignedTo ?? string.Empty;
            row.ActionName = customer.ActionName ?? string.Empty;
            row.ActionStatus = NormalizeActionStatus(customer.ActionStatus);

            return row;
        }

        /// <summary>
        /// Every receipt row a date should list: the classic rows as they are, and
        /// each loan email replaced by its customers.
        /// </summary>
        private static List<EmailReceiptRow> ReadListedReceipts(List<string> emailDates)
        {
            var receiptRows = ReadReceipts(emailDates);

            return receiptRows
                .Where(row => !IsLoanCategory(row.Category))
                .Concat(ExpandLoanReceipts(receiptRows))
                .ToList();
        }

        /// <summary>
        /// The receipt row behind one thread key — the receipts row itself for
        /// every category but loan, and for loan the customer's own row as the
        /// grid shows it.
        ///
        /// Every step reads the thread this way rather than through
        /// ReadReceiptForThread directly, so a step checks the same
        /// [Customer Sender], Unit and verdicts the reviewer is looking at rather
        /// than the shared email's empty ones.
        /// </summary>
        private static EmailReceiptRow ReadThreadRow(List<string> emailDates, ThreadBinding binding)
        {
            if (!binding.IsLoan)
            {
                return ReadReceiptForThread(emailDates, binding.ThreadKey);
            }

            var parent = ReadReceiptForThread(emailDates, binding.ParentThreadId);

            if (parent == null)
            {
                return null;
            }

            var customer = ReadLoanCustomerThreads(CustomerThreadIdColumn, new List<string> { binding.ThreadKey })
                .FirstOrDefault();

            return customer == null ? null : BuildLoanReceiptRow(parent, customer);
        }

        /// <summary>
        /// Sets one column of a thread's thread-level state.
        ///
        /// Scoped by Thread ID AND Email Date on purpose: the same thread appears
        /// once per day it was seen, so keying on Thread ID alone would stamp one
        /// day's verdict onto every other day's row as well. A loan customer
        /// thread is scoped differently — see UpdateReceiptColumns.
        /// </summary>
        private static bool UpdateReceiptColumn(
            List<string> emailDates, ThreadBinding binding, string columnName, string value)
        {
            return UpdateReceiptColumns(
                emailDates, binding, new[] { new KeyValuePair<string, string>(columnName, value) });
        }

        /// <summary>
        /// Sets several columns on a thread's receipt row — in a single statement.
        ///
        /// The same lesson as UpdateEditableDetailColumns further down: one
        /// statement per column is one pass over the table per column, each
        /// taking its own locks on the way, and a step that settles a verdict
        /// writes two or three of them back to back. Unit Match is the worst of
        /// them — [Unit Match], then [Workflow Status], then Remark on a
        /// no-match — and those three interleaving with another request's read
        /// is what the deadlock was made of. Written together they are one pass,
        /// one set of locks, and nothing for a reader to get caught between.
        /// </summary>
        private static bool UpdateReceiptColumns(
            List<string> emailDates, ThreadBinding binding, IList<KeyValuePair<string, string>> values)
        {
            // A loan customer thread needs no dates: it belongs to exactly one
            // email, so there is no second day's row for the value to leak onto.
            if (emailDates.Count == 0 && !binding.IsLoan)
            {
                return false;
            }

            var writable = values
                .Where(v => WritableReceiptColumns.Contains(v.Key, StringComparer.OrdinalIgnoreCase))
                .ToList();

            if (writable.Count == 0)
            {
                return false;
            }

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand())
            {
                command.Connection = connection;
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                var assignments = new List<string>();

                for (var i = 0; i < writable.Count; i++)
                {
                    var parameterName = "@v" + i;
                    assignments.Add($"[{writable[i].Key}] = {parameterName}");
                    command.Parameters.Add(parameterName, SqlDbType.VarChar).Value =
                        writable[i].Value ?? string.Empty;

                    // A matched verdict brings its timestamp with it, into this
                    // same statement - see MatchStampColumns.
                    var stamp = MatchStampAssignment(writable[i].Key, writable[i].Value);

                    if (stamp != null)
                    {
                        assignments.Add(stamp);
                    }
                }

                if (binding.IsLoan)
                {
                    // Every payment row of the customer thread takes the value.
                    // The loan table has no single row to hold one copy of it —
                    // and no [Email Date] to scope by — so the customer thread
                    // itself is the scope, which is exactly the one email it
                    // belongs to.
                    command.CommandText =
                        $"UPDATE {LoanReceiptDetailsTable} SET {string.Join(", ", assignments)} " +
                        $"WHERE [{CustomerThreadIdColumn}] = @threadKey";
                }
                else
                {
                    var inClause = AddEmailDateParameters(command, emailDates);

                    command.CommandText =
                        $"UPDATE {ReceiptsTable} SET {string.Join(", ", assignments)} " +
                        $"WHERE [{ThreadIdColumn}] = @threadKey AND [Email Date] IN ({inClause})";
                }

                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                return ExecuteWithDeadlockRetry(command) > 0;
            }
        }

        /// <summary>
        /// Reads back the stamp a step has just written, as an ISO 8601 string,
        /// or "" when the column is NULL.
        ///
        /// The stamp is set with GETDATE() inside the UPDATE — see
        /// MatchStampAssignment — so only the database knows the instant it
        /// holds. Without reading it back the step's response carried the
        /// verdict but not its time, and the pipeline card had nothing to print
        /// until the whole row was fetched again on the next page load.
        ///
        /// Read after the write rather than computed alongside it, for the same
        /// reason the ticket close returns the stored [SLA_Closed_On]: the card
        /// prints the moment that was recorded, not the moment this request
        /// happened to run.
        ///
        /// `verdictColumn` is a verdict name from MatchStampColumns, never a
        /// caller's string — the stamp column it maps to is what gets bracketed
        /// into the SQL, exactly as the update helpers do it.
        /// </summary>
        private static string ReadMatchStamp(
            List<string> emailDates, ThreadBinding binding, string verdictColumn)
        {
            string stampColumn;

            if (!MatchStampColumns.TryGetValue(verdictColumn ?? string.Empty, out stampColumn))
            {
                return string.Empty;
            }

            // A loan customer thread keeps its thread-level columns on its own
            // payment rows and has no [Email Date] to scope by — the same split
            // UpdateReceiptColumns makes for the write.
            string sql;

            if (binding.IsLoan)
            {
                sql =
                    $"SELECT TOP 1 [{stampColumn}] FROM {LoanReceiptDetailsTable} " +
                    $"WHERE [{CustomerThreadIdColumn}] = @threadKey " +
                    $"ORDER BY [{stampColumn}] DESC";
            }
            else
            {
                if (emailDates.Count == 0)
                {
                    return string.Empty;
                }

                sql = null;
            }

            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand())
                {
                    command.Connection = connection;
                    command.CommandTimeout = SqlCommandTimeoutSeconds;

                    if (sql != null)
                    {
                        command.CommandText = sql;
                    }
                    else
                    {
                        var inClause = AddEmailDateParameters(command, emailDates);

                        command.CommandText =
                            $"SELECT TOP 1 [{stampColumn}] FROM {ReceiptsTable} " +
                            $"WHERE [{ThreadIdColumn}] = @threadKey AND [Email Date] IN ({inClause}) " +
                            $"ORDER BY [{stampColumn}] DESC";
                    }

                    command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                        binding.ThreadKey ?? string.Empty;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value
                        ? string.Empty
                        : Convert.ToDateTime(value).ToString("o", CultureInfo.InvariantCulture);
                }
            });
        }

        /// <summary>
        /// The latest [Instrument Match Date] across a thread's payment rows.
        ///
        /// The step judges each payment on its own, so the rows carry a stamp
        /// each; the card names one step, so it prints the last of them — the
        /// moment the step finished with the thread. The same rule the browser
        /// applies when it has the rows to hand.
        /// </summary>
        private static string ReadLatestDetailMatchStamp(
            ThreadBinding binding, string verdictColumn)
        {
            string stampColumn;

            if (!MatchStampColumns.TryGetValue(verdictColumn ?? string.Empty, out stampColumn))
            {
                return string.Empty;
            }

            var sql =
                $"SELECT MAX([{stampColumn}]) FROM {binding.DetailsTable} " +
                $"WHERE [{binding.ThreadKeyColumn}] = @threadKey";

            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value = binding.ThreadKey ?? string.Empty;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value
                        ? string.Empty
                        : Convert.ToDateTime(value).ToString("o", CultureInfo.InvariantCulture);
                }
            });
        }

        /// <summary>
        /// Sets one column on the payment rows of a thread that carry a given
        /// instrument number — the details table's equivalent key.
        /// </summary>
        private static bool UpdateDetailColumn(
            ThreadBinding binding, string instrumentNumber, string columnName, string value)
        {
            if (!WritableDetailColumns.Contains(columnName, StringComparer.OrdinalIgnoreCase))
            {
                return false;
            }

            var sql =
                $"UPDATE {binding.DetailsTable} SET {StampedAssignment(columnName, value)} " +
                $"WHERE [{binding.ThreadKeyColumn}] = @threadKey " +
                "AND LTRIM(RTRIM(ISNULL([Instrument Number], ''))) = @instrument";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.Parameters.Add("@value", SqlDbType.VarChar).Value = value ?? string.Empty;
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;
                command.Parameters.Add("@instrument", SqlDbType.VarChar).Value =
                    (instrumentNumber ?? string.Empty).Trim();

                connection.Open();

                return command.ExecuteNonQuery() > 0;
            }
        }

        // ── DROPDOWN: Get distinct report dates ──────────────────────

        /// <summary>
        /// GET api/emailautomation/dates
        /// The distinct [Email Date] values in main_email_receipts, newest first,
        /// for binding the FE date dropdown. The column holds display text, so each
        /// value is parsed here and handed back as yyyy-MM-dd — which is what every
        /// other endpoint takes.
        /// </summary>
        [HttpGet]
        [Route("dates")]
        public IHttpActionResult GetAvailableDates()
        {
            var dates = new List<DateTime>();

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(
                $"SELECT DISTINCT [Email Date] FROM {ReceiptsTable} WHERE [Email Date] IS NOT NULL", connection))
            {
                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        DateTime parsed;

                        if (TryParseEmailDate(ReadString(reader, "Email Date"), out parsed))
                        {
                            dates.Add(parsed.Date);
                        }
                    }
                }
            }

            var items = dates
                .Distinct()
                .OrderByDescending(date => date)
                .Select(date => new EmailDateDropdownItem
                {
                    Date = date.ToString("yyyy-MM-dd"),
                    DisplayDate = date.ToString("dd-MM-yyyy")
                })
                .ToList();

            return Ok(items);
        }

        // ── DROPDOWN: Project → collection accounts ──────────────────

        /// <summary>
        /// GET api/emailautomation/project-bank-accounts
        /// Every active row of PRIDE_PROJECT_BANK_ACCOUNT_MASTER, for the account
        /// dropdown on each payment card.
        ///
        /// The whole master is sent, not the accounts for one project: it is 15
        /// rows, the FE holds it for the session, and matching a thread's project
        /// and wing to a ProjectName is a rule the FE already implements for the
        /// CRM assignment mapping.
        /// </summary>
        [HttpGet]
        [Route("project-bank-accounts")]
        public IHttpActionResult GetProjectBankAccounts()
        {
            var items = new List<ProjectBankAccountItem>();

            var sql = $@"
SELECT   ProjectBankAccountId, ProjectName, CollectionBankAccount, SDR_MNGL_GST_BankAccount
FROM     {ProjectBankAccountTable}
WHERE    IsActive = 1
ORDER BY ProjectBankAccountId";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        items.Add(new ProjectBankAccountItem
                        {
                            ProjectBankAccountId = ReadString(reader, "ProjectBankAccountId"),
                            ProjectName = ReadString(reader, "ProjectName"),
                            CollectionBankAccount = ReadString(reader, "CollectionBankAccount"),
                            SdrMnglGstBankAccount = ReadString(reader, "SDR_MNGL_GST_BankAccount")
                        });
                    }
                }
            }

            return Ok(items);
        }

        // ── TABLE: Get main_email_receipts rows for one date ─────────

        /// <summary>
        /// GET api/emailautomation/receipts?date=2026-05-10
        /// Every main_email_receipts row whose [Email Date] falls on that date —
        /// except a 'Payment - Loan/Bank' row, which is replaced by one row per
        /// customer on that email. See ExpandLoanReceipts.
        /// </summary>
        [HttpGet]
        [Route("receipts")]
        public IHttpActionResult GetReceipts(string date)
        {
            if (!DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            var emailDates = ResolveEmailDateValues(date);

            if (emailDates.Count == 0)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"No rows in {ReceiptsTable} for {date}." });
            }

            return Ok(new EmailReceiptsReportResponse
            {
                Date = date,
                FileName = ReceiptsTable,
                Rows = ReadListedReceipts(emailDates)
            });
        }

        // ── PANEL: Get main_email_receipt_details rows for one thread ──

        /// <summary>
        /// GET api/emailautomation/receipt-details?date=2026-05-10&amp;threadId=THR-847d8689
        /// A thread's payment rows — one per instrument mentioned in that email.
        /// Neither details table has an [Email Date] of its own, so 'date' is
        /// carried for context only; the rows are keyed on the thread.
        ///
        /// 'threadId' is whatever the grid row's own thread key is: a [Thread ID]
        /// for every category but loan, and a [Customer Thread ID] for that one,
        /// which returns that customer's payments rather than the whole email's.
        /// Which table it means is resolved from the key itself — see ResolveBinding.
        /// </summary>
        [HttpGet]
        [Route("receipt-details")]
        public IHttpActionResult GetReceiptDetails(string date, string threadId)
        {
            if (!DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(threadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var binding = ResolveBinding(threadId);

            return Ok(new EmailReceiptDetailsResponse
            {
                Date = date,
                ThreadId = threadId,
                FileName = binding.DetailsTable,
                Rows = ReadReceiptDetails(binding)
            });
        }

        // ── THREAD ATTACHMENTS ───────────────────────────────────────

        /// <summary>
        /// Root folder the ingestion pipeline saves attachments under, one
        /// sub-folder per Thread ID.
        /// </summary>
        private static string AttachmentsFolderPath
        {
            get
            {
                var configuredPath = ConfigurationManager.AppSettings["AttachmentsFolderPath"];

                if (string.IsNullOrWhiteSpace(configuredPath))
                {
                    throw new ConfigurationErrorsException(
                        "Web.config is missing the 'AttachmentsFolderPath' appSetting.");
                }

                return configuredPath.StartsWith("~")
                    ? HostingEnvironment.MapPath(configuredPath)
                    : configuredPath;
            }
        }

        /// <summary>Image types the popup shows as a thumbnail rather than only a download.</summary>
        private static readonly string[] ImageExtensions = { "png", "jpg", "jpeg", "gif", "bmp", "webp" };

        /// <summary>
        /// A thread's attachment folder, or null when the name is not one this
        /// endpoint will serve.
        ///
        /// The Thread ID arrives from the caller and is used as a folder name, so it
        /// is checked against the shape the pipeline actually writes rather than
        /// trusted: anything carrying a separator, a drive or ".." is refused before
        /// it can climb out of the attachments root.
        ///
        /// Only a POR thread ("POR-809b50e7") keeps its files straight in
        /// {AttachmentsFolderPath}\{Thread ID}\. Every other thread ("THR-7dcb836d")
        /// is served from the folder of its first mail instead -- see
        /// FirstMessageFolderOrNull.
        /// </summary>
        private static string ThreadFolderOrNull(string threadId)
        {
            var name = (threadId ?? string.Empty).Trim();

            if (name.Length == 0 || !Regex.IsMatch(name, @"^[A-Za-z0-9._-]+$"))
            {
                return null;
            }

            if (!name.StartsWith(PorThreadIdPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return FirstMessageFolderOrNull(name);
            }

            var root = Path.GetFullPath(AttachmentsFolderPath);
            var folder = Path.GetFullPath(Path.Combine(root, name));

            // Belt and braces: even a name that passed the pattern must still resolve
            // to somewhere inside the root.
            return folder.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? folder : null;
        }

        /// <summary>
        /// What turns a main_email_messages.[ID] into the reference its attachments
        /// are filed under ("13-M"): the name of its folder and its Reply_ID in
        /// PRIDE_EMAIL_REPLY_ATTACHMENT. Only a mail carries it -- a reply written
        /// in the app keeps its bare PRIDE_EMAIL_REPLY.ID ("18").
        /// </summary>
        private const string MessageRefSuffix = "-M";

        /// <summary>What a POR thread's id starts with.</summary>
        private const string PorThreadIdPrefix = "POR-";

        /// <summary>
        /// The attachment folder of the first mail on a thread:
        /// {ReplyAttachmentsFolderPath}\{Thread ID}\{main_email_messages.ID}-M\
        /// (e.g. ...\reply-attachments\THR-33c4daf3\13-M\), or null when the
        /// thread id is not a plain name.
        ///
        /// A thread with no mail recorded gets the folder of message 0, which the
        /// identity column never issues, so it reads as a thread with no
        /// attachments rather than as a bad request.
        /// </summary>
        private static string FirstMessageFolderOrNull(string threadId)
        {
            var threadFolder = ReplyThreadFolderOrNull(threadId);

            if (threadFolder == null)
            {
                return null;
            }

            var messageId = ReadFirstMessageId(threadId);

            return Path.Combine(threadFolder, messageId.ToString(CultureInfo.InvariantCulture) + MessageRefSuffix);
        }

        /// <summary>The [ID] of the first mail recorded against a thread, or 0 when there is none.</summary>
        private static int ReadFirstMessageId(string threadId)
        {
            const string sql = "SELECT MIN([ID]) FROM main_email_messages WHERE [Thread ID] = @threadId";

            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.NVarChar, 128).Value = threadId;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value ? 0 : Convert.ToInt32(value);
                }
            });
        }

        /// <summary>
        /// The files PRIDE_EMAIL_REPLY_ATTACHMENT records against one incoming
        /// mail, by its Reply_ID ("13-M").
        ///
        /// Only a mail's reference carries the "-M"; a reply written in the app
        /// keeps its bare PRIDE_EMAIL_REPLY.ID ("18") in the same column, so the
        /// two never match each other's rows. Named by Stored_Name, since that is
        /// the name the file has on disk and the one the popup asks for it by. A
        /// row whose file is no longer in the folder is left out.
        /// </summary>
        private static List<ThreadAttachment> ReadMessageAttachments(string messageRef, string folder)
        {
            var sql =
                "SELECT Stored_Name, Extension, Size_Bytes, Created_On " +
                $"FROM {ReplyAttachmentTable} WHERE Reply_ID = @replyId ORDER BY ID";

            return ReadWithDeadlockRetry(() =>
            {
                var files = new List<ThreadAttachment>();

                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@replyId", SqlDbType.VarChar, 30).Value = messageRef;

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            var storedName = ReadString(reader, "Stored_Name");

                            if (storedName.Length == 0 || !File.Exists(Path.Combine(folder, storedName)))
                            {
                                continue;
                            }

                            var extension = ReadString(reader, "Extension").ToLowerInvariant();

                            files.Add(new ThreadAttachment
                            {
                                FileName = storedName,
                                Extension = extension,
                                SizeBytes = reader["Size_Bytes"] == DBNull.Value ? 0 : Convert.ToInt64(reader["Size_Bytes"]),
                                Modified = reader["Created_On"] == DBNull.Value
                                    ? string.Empty
                                    : Convert.ToDateTime(reader["Created_On"]).ToString("s", CultureInfo.InvariantCulture),
                                IsImage = ImageExtensions.Contains(extension)
                            });
                        }
                    }
                }

                return files;
            });
        }

        /// <summary>
        /// GET api/emailautomation/attachments?threadId=THR-0a10b93d
        ///
        /// Lists what the pipeline saved for the thread, from
        /// {AttachmentsFolderPath}\{Thread ID}\. A thread with no folder is a normal
        /// outcome — it simply had no attachments — so it comes back as an empty
        /// list rather than a 404.
        /// </summary>
        [HttpGet]
        [Route("attachments")]
        public IHttpActionResult GetThreadAttachments(string threadId)
        {
            var folder = ThreadFolderOrNull(threadId);

            if (folder == null)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required and must be a plain thread id." });
            }

            var response = new ThreadAttachmentsResponse
            {
                ThreadId = threadId,
                FolderExists = Directory.Exists(folder),
                Files = new List<ThreadAttachment>()
            };

            if (!response.FolderExists)
            {
                return Ok(response);
            }

            // Anything but a POR thread lists what PRIDE_EMAIL_REPLY_ATTACHMENT
            // records against its first mail, whose Reply_ID is the folder's own
            // name: main_email_messages.ID with "-M" after it ("13-M").
            if (!threadId.Trim().StartsWith(PorThreadIdPrefix, StringComparison.OrdinalIgnoreCase))
            {
                response.Files = ReadMessageAttachments(Path.GetFileName(folder), folder);

                return Ok(response);
            }

            // EnumerateFiles rather than GetFiles + new FileInfo(path): the latter
            // asks the filesystem for each file's metadata a second time, one
            // round trip per file, which is slow on this drive. Enumerating hands
            // back FileInfo objects already filled in from the single directory
            // read, and streams them instead of building the whole array first.
            foreach (var info in new DirectoryInfo(folder).EnumerateFiles())
            {
                var extension = info.Extension.TrimStart('.').ToLowerInvariant();

                response.Files.Add(new ThreadAttachment
                {
                    FileName = info.Name,
                    Extension = extension,
                    SizeBytes = info.Length,
                    Modified = info.LastWriteTime.ToString("s", CultureInfo.InvariantCulture),
                    IsImage = ImageExtensions.Contains(extension)
                });
            }

            response.Files = response.Files.OrderBy(f => f.FileName).ToList();

            return Ok(response);
        }

        /// <summary>
        /// GET api/emailautomation/attachment?threadId=...&amp;fileName=...
        ///
        /// Streams one attachment back. Served inline where the browser can render
        /// it (images, PDFs) so the popup can preview without downloading first;
        /// everything else comes back as an attachment.
        /// </summary>
        [HttpGet]
        [Route("attachment")]
        public IHttpActionResult GetThreadAttachment(string threadId, string fileName, bool thumb = false)
        {
            var folder = ThreadFolderOrNull(threadId);

            if (folder == null)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required and must be a plain thread id." });
            }

            // Only a bare file name is accepted: Path.GetFileName strips any path the
            // caller tried to smuggle in, and the result must match what was sent.
            var name = (fileName ?? string.Empty).Trim();

            if (name.Length == 0 || !string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'fileName' must be a plain file name." });
            }

            var path = Path.Combine(folder, name);

            if (!File.Exists(path))
            {
                return Content(HttpStatusCode.NotFound, new { message = $"{name} is not saved against thread {threadId}." });
            }

            var extension = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();

            var result = new System.Net.Http.HttpResponseMessage(HttpStatusCode.OK);

            // A thumbnail request gets a resized copy rather than the original. The
            // popup draws these at ~116px, and the pipeline saves phone photos of
            // receipts that run to several MB — sending those in full made opening
            // a thread of them far slower than listing them ever was.
            if (thumb && ImageExtensions.Contains(extension))
            {
                result.Content = new System.Net.Http.ByteArrayContent(BuildThumbnail(path, ThumbnailMaxEdge));
                result.Content.Headers.ContentType =
                    new System.Net.Http.Headers.MediaTypeHeaderValue("image/jpeg");
            }
            else
            {
                result.Content = new System.Net.Http.StreamContent(
                    new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read));

                result.Content.Headers.ContentType =
                    new System.Net.Http.Headers.MediaTypeHeaderValue(ContentTypeFor(extension));

                result.Content.Headers.ContentDisposition =
                    new System.Net.Http.Headers.ContentDispositionHeaderValue(
                        IsInlineViewable(extension) ? "inline" : "attachment")
                    {
                        FileName = name
                    };
            }

            // Attachments never change once written, so the browser can keep them
            // and re-opening a thread costs nothing.
            result.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue
            {
                Private = true,
                MaxAge = TimeSpan.FromHours(12)
            };

            return ResponseMessage(result);
        }

        /// <summary>
        /// GET api/emailautomation/attachment-preview?threadId=...&amp;fileName=...&amp;sheet=...
        ///
        /// One spreadsheet attachment as rows of text, so the popup can show it
        /// in place. The browser renders images, PDFs and plain text on its own;
        /// a workbook it can only download, which had the reviewer opening Excel
        /// to read four numbers and losing the thread on the way.
        ///
        /// Reads .csv, .xlsx and .xlsm. The old binary .xls is not readable by the
        /// Open XML SDK, and says so rather than failing.
        /// </summary>
        [HttpGet]
        [Route("attachment-preview")]
        public IHttpActionResult GetAttachmentPreview(string threadId, string fileName, string sheet = null)
        {
            var folder = ThreadFolderOrNull(threadId);

            if (folder == null)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required and must be a plain thread id." });
            }

            var name = (fileName ?? string.Empty).Trim();

            if (name.Length == 0 || !string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'fileName' must be a plain file name." });
            }

            var path = Path.Combine(folder, name);

            if (!File.Exists(path))
            {
                return Content(HttpStatusCode.NotFound, new { message = $"{name} is not saved against thread {threadId}." });
            }

            var extension = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();

            if (!SpreadsheetPreview.CanRead(extension))
            {
                return Content(HttpStatusCode.BadRequest, new
                {
                    message = extension == "xls"
                        ? "This is an older .xls workbook, which cannot be read here. Open the file to read it."
                        : $".{extension} files cannot be previewed as a sheet."
                });
            }

            try
            {
                var content = SpreadsheetPreview.Read(path, extension, sheet);

                return Ok(new SheetPreviewResponse
                {
                    ThreadId = threadId,
                    FileName = name,
                    SheetNames = content.SheetNames,
                    SheetName = content.SheetName,
                    Rows = content.Rows,
                    RowCount = content.Rows.Count,
                    Truncated = content.Truncated,
                    Message = content.Truncated
                        ? $"Showing the first {content.Rows.Count} rows. Open the file to read the rest."
                        : string.Empty
                });
            }
            catch (Exception ex)
            {
                // A workbook that is corrupt, password-protected or open elsewhere
                // must not take the popup down with it.
                return Content(HttpStatusCode.BadRequest, new { message = $"{name} could not be read: {ex.Message}" });
            }
        }

        /// <summary>Longest edge, in pixels, of a generated thumbnail.</summary>
        private const int ThumbnailMaxEdge = 240;

        /// <summary>
        /// A resized JPEG copy of an image, or the original bytes when it is already
        /// smaller than the target.
        ///
        /// Read through a FileStream rather than Image.FromFile: the latter holds a
        /// lock on the file for the lifetime of the Image, which would block the
        /// ingestion pipeline from writing into the same folder.
        /// </summary>
        private static byte[] BuildThumbnail(string path, int maxEdge)
        {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var source = Image.FromStream(file))
            {
                var scale = Math.Min((double)maxEdge / source.Width, (double)maxEdge / source.Height);

                if (scale >= 1)
                {
                    return File.ReadAllBytes(path);
                }

                var width = Math.Max(1, (int)Math.Round(source.Width * scale));
                var height = Math.Max(1, (int)Math.Round(source.Height * scale));

                using (var bitmap = new Bitmap(width, height))
                using (var graphics = Graphics.FromImage(bitmap))
                using (var output = new MemoryStream())
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.SmoothingMode = SmoothingMode.HighQuality;
                    graphics.CompositingQuality = CompositingQuality.HighQuality;
                    graphics.DrawImage(source, 0, 0, width, height);

                    bitmap.Save(output, ImageFormat.Jpeg);

                    return output.ToArray();
                }
            }
        }

        /// <summary>MIME type for the attachment types the pipeline actually saves.</summary>
        private static string ContentTypeFor(string extension)
        {
            switch (extension)
            {
                case "png": return "image/png";
                case "jpg":
                case "jpeg": return "image/jpeg";
                case "gif": return "image/gif";
                case "bmp": return "image/bmp";
                case "webp": return "image/webp";
                case "pdf": return "application/pdf";
                case "txt": return "text/plain";
                case "csv": return "text/csv";
                case "htm":
                case "html": return "text/html";
                case "xls": return "application/vnd.ms-excel";
                case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
                case "doc": return "application/msword";
                case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                default: return "application/octet-stream";
            }
        }

        /// <summary>
        /// Whether the browser is asked to render the file rather than download it.
        /// HTML is deliberately excluded: an attachment is untrusted content, and
        /// rendering it inline from this origin would let it script against the app.
        /// </summary>
        private static bool IsInlineViewable(string extension)
        {
            return ImageExtensions.Contains(extension) || extension == "pdf" || extension == "txt";
        }

        // ── REVIEWER EDITS: correcting a row before a step re-runs ───

        // ── Audit log ────────────────────────────────────────────────

        /// <summary>Table every reviewer correction is journalled into.</summary>
        private const string AuditLogTable = "PRIDE_BANK_DETAILS_AUDIT_LOG";

        /// <summary>
        /// The log's Type values, which also say which table the logged row id
        /// belongs to. Spelled as the column already holds them.
        ///
        /// "which table" is no longer one table each: an Email_Details id may name
        /// a row of main_email_receipt_details or of the loan payment table, and an
        /// Email_Recipts row logged against a loan customer thread carries the
        /// shared email's [Email Receipts ID] while its change was written to that
        /// customer's payment rows. The log's ThreadId is what separates them — a
        /// [Customer Thread ID] for loan, a [Thread ID] for everything else.
        /// </summary>
        private const string AuditTypeReceipt = "Email_Recipts";
        private const string AuditTypeDetail = "Email_Details";

        /// <summary>Stands in for the editor until the app has a sign-in.</summary>
        private const string AuditDefaultUser = "CRM UI";

        /// <summary>
        /// Journals one field change.
        ///
        /// The log's EmailReceiptsDetailsId column holds whichever key the change
        /// was made against — [Email Receipts ID] for an Email_Recipts row,
        /// [Email Receipts Details ID] for an Email_Details one — so Type is what
        /// says which table to read it back against.
        ///
        /// Never throws: an audit row that cannot be written must not fail the
        /// correction the reviewer just made, and the step it unblocks.
        /// </summary>
        private static void WriteAuditLog(
            string rowId, string threadId, string fieldName,
            string oldValue, string newValue, string updatedBy, string type)
        {
            var sql =
                $"INSERT INTO {AuditLogTable} " +
                "(EmailReceiptsDetailsId, ThreadId, FieldName, OldValue, NewValue, UpdatedBy, UpdateDateTime, Type) " +
                "VALUES (@rowId, @threadId, @fieldName, @oldValue, @newValue, @updatedBy, GETDATE(), @type)";

            try
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;

                    command.Parameters.Add("@rowId", SqlDbType.VarChar).Value = rowId ?? string.Empty;
                    command.Parameters.Add("@threadId", SqlDbType.VarChar).Value = threadId ?? string.Empty;
                    command.Parameters.Add("@fieldName", SqlDbType.VarChar).Value = fieldName ?? string.Empty;
                    command.Parameters.Add("@oldValue", SqlDbType.VarChar).Value = oldValue ?? string.Empty;
                    command.Parameters.Add("@newValue", SqlDbType.VarChar).Value = newValue ?? string.Empty;
                    command.Parameters.Add("@updatedBy", SqlDbType.VarChar).Value =
                        string.IsNullOrWhiteSpace(updatedBy) ? AuditDefaultUser : updatedBy.Trim();
                    command.Parameters.Add("@type", SqlDbType.VarChar).Value = type;

                    connection.Open();
                    command.ExecuteNonQuery();
                }
            }
            catch (SqlException)
            {
                // Swallowed on purpose — see the summary above.
            }
        }

        /// <summary>
        /// Reads one editable column's current value, so the log can record what
        /// the field held before the correction.
        ///
        /// Keyed exactly as the update is — same table, same key column, same
        /// thread guard — so the "old" value is the one actually about to be
        /// overwritten. The column name is whitelist-checked before it is
        /// bracketed into the SQL, as everywhere else.
        /// </summary>
        private static string ReadEditableValue(
            string table, string keyColumn, string[] editableColumns,
            string rowId, string threadId, string columnName)
        {
            if (!editableColumns.Contains(columnName, StringComparer.OrdinalIgnoreCase))
            {
                return string.Empty;
            }

            var sql =
                $"SELECT TOP 1 [{columnName}] FROM {table} " +
                $"WHERE [{keyColumn}] = @id AND [Thread ID] = @threadId";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@id", SqlDbType.VarChar).Value = (rowId ?? string.Empty).Trim();
                command.Parameters.Add("@threadId", SqlDbType.VarChar).Value = threadId ?? string.Empty;

                connection.Open();

                var value = command.ExecuteScalar();

                return value == null || value == DBNull.Value ? string.Empty : Convert.ToString(value);
            }
        }

        /// <summary>
        /// Reads one thread-level column as it stands, for the audit log's "old"
        /// side.
        ///
        /// ReadEditableValue's sibling for a value the *thread* owns rather than
        /// one row: a classic thread keeps them on its receipts row, keyed by the
        /// row's own id, while a loan customer thread keeps a copy on each of its
        /// payment rows and any one of them answers.
        /// </summary>
        private static string ReadThreadLevelValue(
            ThreadBinding binding, string[] editableColumns, string columnName)
        {
            if (!editableColumns.Contains(columnName, StringComparer.OrdinalIgnoreCase))
            {
                return string.Empty;
            }

            var sql =
                $"SELECT TOP 1 [{columnName}] FROM {binding.ThreadColumnTable} " +
                $"WHERE [{binding.ThreadKeyColumn}] = @threadKey";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                var value = command.ExecuteScalar();

                return value == null || value == DBNull.Value ? string.Empty : Convert.ToString(value);
            }
        }

        /// <summary>
        /// True when an edit actually changes the stored value.
        ///
        /// The payment dialogs post every field of a row, changed or not, so
        /// without this the log would fill with entries recording nothing.
        /// </summary>
        private static bool IsRealChange(string oldValue, string newValue)
        {
            return !string.Equals(
                (oldValue ?? string.Empty).Trim(),
                (newValue ?? string.Empty).Trim(),
                StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Writes one editable column of a thread's own source fields —
        /// [Customer Sender], Project, [Sub Project], Unit.
        ///
        /// For a classic thread that is one receipts row, keyed on
        /// [Email Receipts ID] AND [Thread ID]: the id alone identifies the row,
        /// and the thread is carried as a guard so a stale id from the UI can
        /// never write to a different thread's row.
        ///
        /// A loan customer thread has no receipts row of its own — the one behind
        /// it is the email, shared with every other customer on it — so the write
        /// goes to the customer's payment rows instead, and the row id is
        /// deliberately not part of the key: it identifies that shared email.
        /// </summary>
        private static bool UpdateEditableReceiptColumn(
            ThreadBinding binding, string emailReceiptsId, string columnName, string value)
        {
            if (!EditableReceiptColumns.Contains(columnName, StringComparer.OrdinalIgnoreCase))
            {
                return false;
            }

            var sql = binding.IsLoan
                ? $"UPDATE {LoanReceiptDetailsTable} SET [{columnName}] = @value " +
                  $"WHERE [{CustomerThreadIdColumn}] = @threadKey"
                : $"UPDATE {ReceiptsTable} SET [{columnName}] = @value " +
                  $"WHERE [Email Receipts ID] = @id AND [{ThreadIdColumn}] = @threadKey";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.Parameters.Add("@value", SqlDbType.VarChar).Value = (value ?? string.Empty).Trim();
                command.Parameters.Add("@id", SqlDbType.VarChar).Value = (emailReceiptsId ?? string.Empty).Trim();
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                return command.ExecuteNonQuery() > 0;
            }
        }

        /// <summary>
        /// Reads the current value of several editable columns on one payment row,
        /// in one go, so the audit log can record what each field held before the
        /// correction.
        ///
        /// One statement rather than one per column: the dialog posts every field
        /// of the row, and a read per field is a round trip — and a set of locks —
        /// per field for an answer a single row already carries.
        /// </summary>
        private static Dictionary<string, string> ReadEditableDetailValues(
            ThreadBinding binding, string emailReceiptsDetailsId, ICollection<string> columnNames)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            var columns = columnNames
                .Where(c => EditableDetailColumns.Contains(c, StringComparer.OrdinalIgnoreCase))
                .ToList();

            if (columns.Count == 0)
            {
                return values;
            }

            var sql =
                $"SELECT TOP 1 {string.Join(", ", columns.Select(c => $"[{c}]"))} " +
                $"FROM {binding.DetailsTable} " +
                $"WHERE [Email Receipts Details ID] = @id AND [{binding.ThreadKeyColumn}] = @threadKey";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@id", SqlDbType.VarChar).Value = (emailReceiptsDetailsId ?? string.Empty).Trim();
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return values;
                    }

                    foreach (var column in columns)
                    {
                        values[column] = ReadString(reader, column);
                    }
                }
            }

            return values;
        }

        /// <summary>
        /// Writes several editable columns of one payment row — in a single
        /// statement.
        ///
        /// It used to be a statement per column, which is what made saving a
        /// four-payment correction deadlock: six UPDATEs per payment, four
        /// payments saved at once, each one scanning a heap and taking locks
        /// across it. One statement per row takes its locks once, and the index
        /// on [Email Receipts Details ID] means it takes them on one row.
        ///
        /// Keyed on the id AND [Thread ID]: the id alone identifies the row, and
        /// the thread is carried as a guard so a stale id from the UI can never
        /// write to another thread's payment.
        /// </summary>
        private static bool UpdateEditableDetailColumns(
            ThreadBinding binding, string emailReceiptsDetailsId, IDictionary<string, string> edits)
        {
            var columns = edits.Keys
                .Where(c => EditableDetailColumns.Contains(c, StringComparer.OrdinalIgnoreCase))
                .ToList();

            if (columns.Count == 0)
            {
                return false;
            }

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand())
            {
                command.Connection = connection;
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                var assignments = new List<string>();

                for (var i = 0; i < columns.Count; i++)
                {
                    var parameterName = "@v" + i;
                    assignments.Add($"[{columns[i]}] = {parameterName}");
                    command.Parameters.Add(parameterName, SqlDbType.VarChar).Value =
                        (edits[columns[i]] ?? string.Empty).Trim();
                }

                command.CommandText =
                    $"UPDATE {binding.DetailsTable} SET {string.Join(", ", assignments)} " +
                    $"WHERE [Email Receipts Details ID] = @id AND [{binding.ThreadKeyColumn}] = @threadKey";

                command.Parameters.Add("@id", SqlDbType.VarChar).Value = (emailReceiptsDetailsId ?? string.Empty).Trim();
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                return ExecuteWithDeadlockRetry(command) > 0;
            }
        }

        /// <summary>
        /// Runs a statement, and runs it once more if SQL Server picks it as a
        /// deadlock victim (error 1205).
        ///
        /// A deadlock victim is not a failed write — it is a write that was asked
        /// to stand aside and try again, which is what this does. The reviewer
        /// should not be shown a server exception for a save that would have
        /// succeeded a moment later.
        /// </summary>
        private static int ExecuteWithDeadlockRetry(SqlCommand command)
        {
            const int deadlockVictim = 1205;

            try
            {
                return command.ExecuteNonQuery();
            }
            catch (SqlException ex) when (ex.Number == deadlockVictim)
            {
                Thread.Sleep(120);

                return command.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// POST api/emailautomation/update-receipt
        /// Body: { "date": "2026-05-13", "threadId": "THR-411af1a7",
        ///         "emailReceiptsId": "1024", "customerSender": "a@b.com" }
        ///
        /// Applies a reviewer's correction to the source fields the pipeline reads —
        /// Customer Sender for node 2, Project / Sub Project / Unit for node 3 — so
        /// the step can be re-run immediately against the corrected row.
        ///
        /// Only the fields present in the body are written. A field left null is not
        /// touched, which is what lets the node-2 dialog send one field and the
        /// node-3 dialog send three without either clearing the other's columns.
        /// </summary>
        [HttpPost]
        [Route("update-receipt")]
        public IHttpActionResult UpdateReceipt(ReceiptUpdateRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            if (string.IsNullOrWhiteSpace(request.EmailReceiptsId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'emailReceiptsId' is required." });
            }

            var binding = ResolveBinding(request.ThreadId);

            // Null means "not part of this edit". Empty string is a real value the
            // reviewer can send, so the two are kept apart on purpose.
            var edits = new Dictionary<string, string>();

            if (request.CustomerSender != null) edits["Customer Sender"] = request.CustomerSender;
            if (request.Project != null) edits["Project"] = request.Project;
            if (request.SubProject != null) edits["Sub Project"] = request.SubProject;
            if (request.Unit != null) edits["Unit"] = request.Unit;

            if (edits.Count == 0)
            {
                return Content(HttpStatusCode.BadRequest,
                    new { message = "Send at least one of customerSender, project, subProject or unit." });
            }

            var updated = new List<string>();

            foreach (var edit in edits)
            {
                // Read what the cell holds before overwriting it, so the audit
                // row can carry both sides of the change.
                //
                // A loan customer thread's fields are read the same way they are
                // written — off its payment rows, keyed on the customer thread —
                // while a classic thread's are read off the one receipts row the
                // id names.
                var oldValue = binding.IsLoan
                    ? ReadThreadLevelValue(binding, EditableReceiptColumns, edit.Key)
                    : ReadEditableValue(
                        ReceiptsTable, "Email Receipts ID", EditableReceiptColumns,
                        request.EmailReceiptsId, request.ThreadId, edit.Key);

                if (!UpdateEditableReceiptColumn(binding, request.EmailReceiptsId, edit.Key, edit.Value))
                {
                    continue;
                }

                updated.Add(edit.Key);

                if (IsRealChange(oldValue, edit.Value))
                {
                    WriteAuditLog(
                        request.EmailReceiptsId, request.ThreadId, edit.Key,
                        oldValue, edit.Value, request.UpdatedBy, AuditTypeReceipt);
                }
            }

            if (updated.Count == 0)
            {
                return Content(HttpStatusCode.NotFound, new
                {
                    message = $"No {binding.ThreadColumnTable} row for thread {request.ThreadId}."
                });
            }

            var emailDates = ResolveEmailDateValues(request.Date);

            return Ok(new ReceiptUpdateResponse
            {
                Date = request.Date,
                ThreadId = request.ThreadId,
                UpdatedColumns = updated,
                Row = ReadThreadRow(emailDates, binding),
                Message = $"Updated {string.Join(", ", updated)} on {binding.ThreadColumnTable} for thread {request.ThreadId}."
            });
        }

        /// <summary>
        /// POST api/emailautomation/update-receipt-detail
        /// Body: { "threadId": "THR-411af1a7", "emailReceiptsDetailsId": "5567",
        ///         "instrumentNumber": "000123" }
        ///
        /// The payment-row equivalent: the instrument number node 4 could not find,
        /// or the amount / account number node 5 needs, corrected on one payment row
        /// so the step can be re-run straight away. Every payment row of the thread
        /// comes back, because the caller repaints the whole payment list.
        /// </summary>
        [HttpPost]
        [Route("update-receipt-detail")]
        public IHttpActionResult UpdateReceiptDetail(ReceiptDetailUpdateRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            if (string.IsNullOrWhiteSpace(request.EmailReceiptsDetailsId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'emailReceiptsDetailsId' is required." });
            }

            var binding = ResolveBinding(request.ThreadId);

            var edits = new Dictionary<string, string>();

            if (request.InstrumentNumber != null) edits["Instrument Number"] = request.InstrumentNumber;
            if (request.Amount != null) edits["Amount"] = request.Amount;
            if (request.CustomerAccountNumber != null) edits["Customer Account Number"] = request.CustomerAccountNumber;
            if (request.PaymentMode != null) edits["Payment Mode"] = request.PaymentMode;
            if (request.CustomerBank != null) edits["Customer Bank"] = request.CustomerBank;
            if (request.CashHeaderAccount != null) edits["CashHeaderAccount"] = request.CashHeaderAccount;

            if (edits.Count == 0)
            {
                return Content(HttpStatusCode.BadRequest, new
                {
                    message = "Send at least one of instrumentNumber, amount, paymentMode, " +
                              "customerBank, customerAccountNumber or cashHeaderAccount."
                });
            }

            // Read what the row holds now, write every field, then log the ones
            // that actually changed — two statements for the whole row rather than
            // two per field. The dialog posts several payments at once, and a
            // statement per field per payment is what used to deadlock them
            // against each other.
            var oldValues = ReadEditableDetailValues(
                binding, request.EmailReceiptsDetailsId, edits.Keys);

            var updated = UpdateEditableDetailColumns(binding, request.EmailReceiptsDetailsId, edits)
                ? edits.Keys.ToList()
                : new List<string>();

            foreach (var column in updated)
            {
                string oldValue;

                if (!oldValues.TryGetValue(column, out oldValue))
                {
                    oldValue = string.Empty;
                }

                if (IsRealChange(oldValue, edits[column]))
                {
                    WriteAuditLog(
                        request.EmailReceiptsDetailsId, request.ThreadId, column,
                        oldValue, edits[column], request.UpdatedBy, AuditTypeDetail);
                }
            }

            if (updated.Count == 0)
            {
                return Content(HttpStatusCode.NotFound, new
                {
                    message = $"No {binding.DetailsTable} row with [Email Receipts Details ID] {request.EmailReceiptsDetailsId} on thread {request.ThreadId}."
                });
            }

            RefreshInstrumentMatchAfterEdit(binding, request.EmailReceiptsDetailsId);

            return Ok(new ReceiptDetailUpdateResponse
            {
                ThreadId = request.ThreadId,
                UpdatedColumns = updated,
                Rows = ReadReceiptDetails(binding),
                Message = $"Updated {string.Join(", ", updated)} on {binding.DetailsTable} row {request.EmailReceiptsDetailsId}."
            });
        }

        // ── WORKFLOW NODE 1: Ticket Acknowledgement ──────────────────

        /// <summary>
        /// POST api/emailautomation/acknowledge-tickets
        /// Body: { "date": "2026-05-13" }
        ///
        /// Node 1 of the Workflow Pipeline, run when a date is selected. Takes every
        /// thread the grid lists for that date and makes sure it has a ticket in
        /// PRIDE_TICKET_ACJNOWLEDGEMENT:
        ///   • thread already has an Open ticket → that ticket is reused as-is.
        ///   • otherwise (never seen, or its last ticket is Closed) → a new
        ///     TKT-{year}-{000000} is raised against the thread's Email Date.
        ///
        /// "Every thread the grid lists" rather than every [Thread ID] in
        /// main_email_receipts, which is the same thing for every category but
        /// loan: a loan email is ticketed per customer, so its ticket goes to each
        /// [Customer Thread ID] and none to the email they share.
        /// </summary>
        [HttpPost]
        [Route("acknowledge-tickets")]
        public IHttpActionResult AcknowledgeTickets(TicketAcknowledgementRequest request)
        {
            DateTime reportDate;

            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out reportDate))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            var emailDates = ResolveEmailDateValues(request.Date);

            if (emailDates.Count == 0)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"No rows in {ReceiptsTable} for {request.Date}." });
            }

            // One entry per distinct thread on that date, carrying its Email Date.
            //
            // Read through the same projection the grid reads, so the rows on
            // screen and the rows that get a ticket are one population: a ticket
            // for every row listed, and none for a thread nobody can open. It is
            // also what makes the per-customer dedupe fall out for free — two
            // payment rows of one customer are one row here, so one ticket.
            var threads = ReadListedReceipts(emailDates)
                .Where(row => !string.IsNullOrWhiteSpace(row.ThreadId))
                .GroupBy(row => row.ThreadId.Trim(), StringComparer.OrdinalIgnoreCase)
                .Select(group => new TicketAcknowledgementItem
                {
                    ThreadId = group.Key,
                    EmailDate = group.First().EmailDate,
                    EmailLink = group.First().EmailLink
                })
                .ToList();

            string serverTime;
            List<TicketAcknowledgementItem> closedTickets;
            var tickets = AcknowledgeThreadTickets(
                threads, reportDate.Year, out serverTime, out closedTickets);

            // A freshly raised ticket starts owned by the CRM head from
            // Web.config; Unit Match reassigns it later through assign-thread.
            // The caller's defaultAssignee only stands in when the key is unset.
            // Every open ticket, not only new ones, so one raised while no
            // default was configured is filled too — AssignDefaultOwner only
            // ever writes a blank [Assigned To], never replaces an owner.
            var crmHead = ConfigurationManager.AppSettings["CRMHead"];

            AssignDefaultOwner(
                emailDates,
                tickets.Select(t => t.ThreadId).ToList(),
                string.IsNullOrWhiteSpace(crmHead) ? request.DefaultAssignee : crmHead);

            // A ticketed thread names the step it now waits on straight away, so
            // the grid's Pending Step reads "Customer Email Match / Pending"
            // rather than blank until someone opens the thread. Every open
            // ticket, not only new ones: one raised before this seeding existed,
            // or whose seed failed, would otherwise stay blank for good.
            // SeedPendingStep leaves any row that already has a value alone.
            SeedPendingStep(emailDates, tickets.Select(t => t.ThreadId).ToList());

            return Ok(new TicketAcknowledgementResponse
            {
                Date = request.Date,
                TotalThreads = tickets.Count,
                CreatedCount = tickets.Count(t => t.IsNew),
                ReusedCount = tickets.Count(t => !t.IsNew),
                ServerTime = serverTime,
                Tickets = tickets,
                ClosedTickets = closedTickets
            });
        }

        /// <summary>
        /// POST api/emailautomation/refresh-sla
        /// Body: { "ticketId": "TKT-2026-000001" }  — ticketId optional.
        ///
        /// Re-evaluates where a ticket's SLA stands and records a breach if one
        /// has happened. The UI calls this the moment its countdown reaches zero,
        /// which is what makes "Overdue" land in the database at the instant it
        /// becomes true rather than at the next date load: there is no scheduler
        /// here to notice on its own.
        ///
        /// Nothing is written while a clock is merely ticking — only the one
        /// transition from On Track to Overdue, so a countdown on screen costs no
        /// writes at all.
        ///
        /// Omit ticketId to sweep every open ticket.
        /// </summary>
        [HttpPost]
        [Route("refresh-sla")]
        public IHttpActionResult RefreshSla(TicketSlaRequest request)
        {
            var ticketId = request == null || string.IsNullOrWhiteSpace(request.TicketId)
                ? null
                : request.TicketId.Trim();

            var response = new TicketSlaResponse { TicketId = ticketId ?? string.Empty };

            using (var connection = new SqlConnection(PrideConnectionString))
            {
                connection.Open();

                using (var transaction = connection.BeginTransaction())
                {
                    response.MarkedOverdue = MarkOverdueTickets(connection, transaction, ticketId);

                    var serverNow = ReadServerNow(connection, transaction);
                    response.ServerTime = serverNow.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture);

                    if (ticketId != null)
                    {
                        // Read back rather than assume: the ticket may also have
                        // been closed since the browser last heard about it.
                        var item = new TicketAcknowledgementItem();
                        DateTime? createdDate;

                        if (!ReadTicketSla(connection, transaction, ticketId, item, out createdDate))
                        {
                            transaction.Commit();

                            return Content(HttpStatusCode.NotFound,
                                new { message = $"Ticket {ticketId} was not found." });
                        }

                        ApplySlaState(item, createdDate, serverNow);

                        response.CreatedDate = item.CreatedDate;
                        response.SlaDue = item.SlaDue;
                        response.SlaStatus = item.SlaStatus;
                        response.SlaRemainingSeconds = item.SlaRemainingSeconds;
                    }

                    transaction.Commit();
                }
            }

            return Ok(response);
        }

        /// <summary>
        /// Reads one ticket's SLA fields into <paramref name="item"/>.
        /// False when there is no such ticket.
        /// </summary>
        private static bool ReadTicketSla(
            SqlConnection connection, SqlTransaction transaction, string ticketId,
            TicketAcknowledgementItem item, out DateTime? createdDate)
        {
            const string sql = @"
SELECT   Thread_ID, Ticket_ID, SLA, Ticket_Status, Created_Date, SLA_Status
FROM     PRIDE_TICKET_ACJNOWLEDGEMENT
WHERE    Ticket_ID = @ticketId";

            createdDate = null;

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value = ticketId;

                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return false;
                    }

                    item.ThreadId = ReadString(reader, "Thread_ID");
                    item.TicketId = ReadString(reader, "Ticket_ID");
                    item.Sla = ReadString(reader, "SLA");
                    item.TicketStatus = ReadString(reader, "Ticket_Status");
                    item.SlaStatus = ReadString(reader, "SLA_Status");
                    createdDate = ReadNullableDateTime(reader, "Created_Date");

                    return true;
                }
            }
        }

        /// <summary>
        /// POST api/emailautomation/close-ticket
        /// Body: { "threadId": "THR-04c674f4", "ticketId": "TKT-2026-000001" }
        ///
        /// Closes a ticket the reviewer has finished with — a non-payment thread
        /// whose answer has gone out, typically. Closing is what lets the same
        /// thread raise a fresh ticket if the customer writes in again: the
        /// acknowledgement step only reuses tickets that are still Open.
        ///
        /// A ticket that is already Closed is left alone and reported as such,
        /// so a second click cannot re-close it or move its date.
        /// </summary>
        [HttpPost]
        [Route("close-ticket")]
        public IHttpActionResult CloseTicket(TicketCloseRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.TicketId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'ticketId' is required." });
            }

            // Closing settles the SLA in the same statement: whether the answer
            // went out inside the window is only knowable at this instant, and
            // nothing revisits a closed ticket afterwards. SLA_Closed_On records
            // when, so the verdict can be checked later.
            //
            // Both settled values come straight back out of the UPDATE. Reading
            // them again afterwards would be a second look at a row another
            // request may have moved on, and a second reading of the clock that
            // is not the one that was stored.
            const string sql = @"
UPDATE PRIDE_TICKET_ACJNOWLEDGEMENT
SET    Ticket_Status = @closed,
       SLA_Closed_On = GETDATE(),
       SLA_Status    = CASE
                         WHEN Created_Date IS NULL THEN SLA_Status
                         WHEN GETDATE() <= DATEADD(SECOND, @slaSeconds, Created_Date) THEN @met
                         ELSE @overdue
                       END
OUTPUT INSERTED.SLA_Status, INSERTED.SLA_Closed_On
WHERE  Ticket_ID = @ticketId AND Ticket_Status = @open";

            object settledSlaStatus = null;
            DateTime? settledClosedOn = null;

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@closed", SqlDbType.VarChar, 20).Value = TicketStatusClosed;
                command.Parameters.Add("@open", SqlDbType.VarChar, 20).Value = TicketStatusOpen;
                command.Parameters.Add("@met", SqlDbType.VarChar, 20).Value = SlaStatusMet;
                command.Parameters.Add("@overdue", SqlDbType.VarChar, 20).Value = SlaStatusOverdue;
                command.Parameters.Add("@slaSeconds", SqlDbType.Int).Value =
                    (int)Math.Round(TicketDefaultSlaHours * 3600);
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value = request.TicketId.Trim();

                connection.Open();

                // No row back when the ticket was already closed — nothing was
                // updated, so there is nothing to report as settled.
                using (var reader = command.ExecuteReader())
                {
                    if (reader.Read())
                    {
                        settledSlaStatus = reader["SLA_Status"];
                        settledClosedOn = ReadNullableDateTime(reader, "SLA_Closed_On");
                    }
                }
            }

            var closed = settledSlaStatus != null && settledSlaStatus != DBNull.Value;
            var slaStatus = closed ? settledSlaStatus.ToString() : string.Empty;

            if (closed)
            {
                WriteAuditLog(
                    null, request.ThreadId, "Ticket_Status",
                    TicketStatusOpen, TicketStatusClosed, request.UpdatedBy, AuditTypeReceipt);

                // Journalled separately so a breach can be found later without
                // recomputing it from the ticket row.
                WriteAuditLog(
                    null, request.ThreadId, "SLA_Status",
                    string.Empty, slaStatus, request.UpdatedBy, AuditTypeReceipt);
            }

            return Ok(new TicketCloseResponse
            {
                ThreadId = request.ThreadId,
                TicketId = request.TicketId,
                TicketStatus = TicketStatusClosed,
                SlaStatus = slaStatus,
                ClosedOn = settledClosedOn.HasValue
                    ? settledClosedOn.Value.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture)
                    : string.Empty,
                Message = closed
                    ? $"Ticket {request.TicketId} closed."
                    : $"Ticket {request.TicketId} was already closed."
            });
        }

        /// <summary>Ticket numbers read TKT-{year}-{6 digits}, e.g. TKT-2026-000001.</summary>
        private const string TicketIdPrefix = "TKT";
        private const int TicketSequenceDigits = 6;

        /// <summary>Written to SLA on every new ticket.</summary>
        private const string TicketDefaultSla = "24 Hours";
        private const string TicketStatusOpen = "Open";
        private const string TicketStatusClosed = "Closed";

        /// <summary>
        /// Where a ticket's SLA stands, kept in SLA_Status apart from
        /// Ticket_Status so the two facts stay independent: a ticket can be Open
        /// and already Overdue, or Closed having breached on the way.
        /// </summary>
        private const string SlaStatusOnTrack = "On Track";
        private const string SlaStatusOverdue = "Overdue";
        private const string SlaStatusMet = "Met";

        /// <summary>How Created_Date and the derived due instant go over the wire.</summary>
        private const string SlaTimestampFormat = "yyyy-MM-dd HH:mm:ss";

        /// <summary>
        /// TicketDefaultSla as a number of hours, read from the constant itself so
        /// "24" is never written twice and changing the SLA text changes the clock.
        /// </summary>
        private static readonly double TicketDefaultSlaHours = ParseSlaHours(TicketDefaultSla, 24);

        /// <summary>
        /// "24 Hours" → 24. Also understands days, minutes and seconds, the same
        /// spellings the UI's own parser takes, so a ticket carrying something
        /// other than the default still gets the right deadline.
        /// </summary>
        /// <param name="fallbackHours">Used when the text cannot be read at all.</param>
        private static double ParseSlaHours(string sla, double fallbackHours)
        {
            var match = Regex.Match((sla ?? string.Empty).Trim(), @"^(\d+(?:\.\d+)?)\s*([a-z]+)",
                RegexOptions.IgnoreCase);

            double value;

            if (!match.Success ||
                !double.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
            {
                return fallbackHours;
            }

            var unit = match.Groups[2].Value.ToLowerInvariant();

            if (unit.StartsWith("day")) return value * 24;
            if (unit.StartsWith("hour") || unit == "hr" || unit == "hrs") return value;
            if (unit.StartsWith("min")) return value / 60;
            if (unit.StartsWith("sec")) return value / 3600;

            return fallbackHours;
        }

        /// <summary>
        /// Fills in a ticket's SLA fields for the response.
        ///
        /// The deadline is worked out here rather than stored: it is the creation
        /// stamp plus whatever that row's own SLA says, so the two can never fall
        /// out of step. Both are measured against the database's clock — the same
        /// one MarkOverdueTickets compares against — so the app server's clock
        /// cannot make a ticket look overdue early.
        ///
        /// A ticket with no Created_Date (raised before the column existed, with
        /// an email date that would not parse) gets no deadline and no countdown;
        /// the next acknowledge stamps it.
        /// </summary>
        private static void ApplySlaState(
            TicketAcknowledgementItem item, DateTime? createdDate, DateTime serverNow)
        {
            item.SlaStatus = string.IsNullOrWhiteSpace(item.SlaStatus) ? SlaStatusOnTrack : item.SlaStatus;

            if (!createdDate.HasValue)
            {
                return;
            }

            var due = createdDate.Value.AddHours(ParseSlaHours(item.Sla, TicketDefaultSlaHours));

            item.CreatedDate = createdDate.Value.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture);
            item.SlaDue = due.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture);
            item.SlaRemainingSeconds = (int)Math.Round((due - serverNow).TotalSeconds);
        }

        /// <summary>
        /// Raises a ticket for every thread that does not already have an open one,
        /// and reuses the existing ticket for those that do.
        ///
        /// The whole batch runs inside one serializable transaction: the per-year
        /// high-water mark is read once under a lock and then incremented in memory,
        /// so two date selections running at the same time cannot mint the same
        /// number. Nothing is written for a reused ticket — not even its Date.
        /// </summary>
        /// <param name="fallbackYear">
        /// Year to number a ticket under when the thread's Email Date cannot be
        /// parsed — normally the year of the selected report date.
        /// </param>
        /// <param name="serverTime">
        /// The database's clock at the moment the tickets were read. Every
        /// "seconds left" handed back was measured against it.
        /// </param>
        private static List<TicketAcknowledgementItem> AcknowledgeThreadTickets(
            List<TicketAcknowledgementItem> threads, int fallbackYear, out string serverTime,
            out List<TicketAcknowledgementItem> closedTickets)
        {
            var results = new List<TicketAcknowledgementItem>();
            closedTickets = new List<TicketAcknowledgementItem>();
            serverTime = string.Empty;

            if (threads.Count == 0)
            {
                return results;
            }

            using (var connection = new SqlConnection(PrideConnectionString))
            {
                connection.Open();

                using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    // Every open ticket that has run out gets its breach recorded
                    // here, before anything is read back: loading a date is the
                    // moment those answers are about to be looked at, and there is
                    // no scheduler to do it in the background.
                    MarkOverdueTickets(connection, transaction, null);

                    var serverNow = ReadServerNow(connection, transaction);
                    serverTime = serverNow.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture);

                    var openTickets = ReadOpenTickets(connection, transaction);

                    // What these threads have already had closed. Read before any
                    // new ticket is raised, so a ticket created by this very call
                    // cannot turn up in the closed list.
                    closedTickets = ReadClosedTickets(
                        connection, transaction,
                        threads.Select(t => t.ThreadId.Trim()));

                    // Next free number per year, read once and then handed out locally.
                    var nextSequence = new Dictionary<int, int>();

                    foreach (var thread in threads)
                    {
                        var threadId = thread.ThreadId.Trim();

                        OpenTicket existing;

                        if (openTickets.TryGetValue(threadId, out existing))
                        {
                            // Tickets raised before EmailLink existed have none; fill it
                            // in now rather than leaving them blank forever.
                            if (string.IsNullOrWhiteSpace(existing.EmailLink) &&
                                !string.IsNullOrWhiteSpace(thread.EmailLink))
                            {
                                FillMissingEmailLink(connection, transaction, existing.TicketId, thread.EmailLink);
                                existing.EmailLink = thread.EmailLink;
                            }

                            // Same idea for the creation stamp: a ticket from
                            // before the column existed has no clock until one is
                            // written, and a reused ticket takes no other write.
                            if (!existing.CreatedDate.HasValue)
                            {
                                var stamped = FillMissingCreatedDate(connection, transaction, existing.TicketId);

                                if (stamped.HasValue)
                                {
                                    existing.CreatedDate = stamped;
                                    existing.SlaStatus = SlaStatusOnTrack;
                                }
                            }

                            var reused = new TicketAcknowledgementItem
                            {
                                ThreadId = threadId,
                                TicketId = existing.TicketId,
                                EmailDate = thread.EmailDate,
                                Sla = existing.Sla,
                                SlaStatus = existing.SlaStatus,
                                TicketStatus = existing.TicketStatus,
                                EmailLink = existing.EmailLink,
                                IsNew = false
                            };

                            // Its Created_Date is untouched, so the countdown
                            // picks up where it left off rather than restarting.
                            ApplySlaState(reused, existing.CreatedDate, serverNow);
                            results.Add(reused);

                            continue;
                        }

                        var year = TicketYearOf(thread.EmailDate, fallbackYear);

                        if (!nextSequence.ContainsKey(year))
                        {
                            nextSequence[year] = ReadHighestTicketSequence(connection, transaction, year) + 1;
                        }

                        var ticketId = FormatTicketId(year, nextSequence[year]);
                        nextSequence[year]++;

                        // The SLA clock starts here: the database stamps
                        // Created_Date as the ticket number and SLA go in.
                        var createdDate = InsertTicket(
                            connection, transaction, threadId, ticketId, thread.EmailDate, thread.EmailLink);

                        // Guards against the same thread appearing twice in one batch.
                        openTickets[threadId] = new OpenTicket
                        {
                            TicketId = ticketId,
                            Sla = TicketDefaultSla,
                            TicketStatus = TicketStatusOpen,
                            EmailLink = thread.EmailLink,
                            CreatedDate = createdDate,
                            SlaStatus = SlaStatusOnTrack
                        };

                        var raised = new TicketAcknowledgementItem
                        {
                            ThreadId = threadId,
                            TicketId = ticketId,
                            EmailDate = thread.EmailDate,
                            Sla = TicketDefaultSla,
                            SlaStatus = SlaStatusOnTrack,
                            TicketStatus = TicketStatusOpen,
                            EmailLink = thread.EmailLink,
                            IsNew = true
                        };

                        ApplySlaState(raised, createdDate, serverNow);
                        results.Add(raised);
                    }

                    transaction.Commit();
                }
            }

            return results;
        }

        /// <summary>
        /// The closed tickets belonging to the given threads, newest first.
        ///
        /// A thread keeps every ticket it has ever had: closing one is what frees
        /// the thread to raise another, so this is the history behind the single
        /// open ticket <see cref="ReadOpenTickets"/> returns. Read whole and
        /// filtered here rather than with an IN list — a day is a hundred-odd
        /// threads and the closed table is small.
        /// </summary>
        private static List<TicketAcknowledgementItem> ReadClosedTickets(
            SqlConnection connection, SqlTransaction transaction, IEnumerable<string> threadIds)
        {
            const string sql = @"
SELECT   Thread_ID, Ticket_ID, SLA, Ticket_Status, EmailLink, Created_Date, SLA_Status, SLA_Closed_On
FROM     PRIDE_TICKET_ACJNOWLEDGEMENT
WHERE    Ticket_Status <> 'Open'
ORDER BY Created_Date DESC";

            var wanted = new HashSet<string>(threadIds, StringComparer.OrdinalIgnoreCase);
            var closed = new List<TicketAcknowledgementItem>();

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var threadId = ReadString(reader, "Thread_ID");

                        if (threadId.Length == 0 || !wanted.Contains(threadId))
                        {
                            continue;
                        }

                        var createdDate = ReadNullableDateTime(reader, "Created_Date");
                        var closedOn = ReadNullableDateTime(reader, "SLA_Closed_On");

                        closed.Add(new TicketAcknowledgementItem
                        {
                            ThreadId = threadId,
                            TicketId = ReadString(reader, "Ticket_ID"),
                            Sla = ReadString(reader, "SLA"),
                            TicketStatus = ReadString(reader, "Ticket_Status"),
                            EmailLink = ReadString(reader, "EmailLink"),
                            SlaStatus = ReadString(reader, "SLA_Status"),
                            CreatedDate = createdDate.HasValue
                                ? createdDate.Value.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture)
                                : string.Empty,
                            // Empty rather than a guess on a ticket closed before
                            // the stamp was being written — the close time of
                            // those is genuinely not recorded anywhere.
                            ClosedOn = closedOn.HasValue
                                ? closedOn.Value.ToString(SlaTimestampFormat, CultureInfo.InvariantCulture)
                                : string.Empty,
                            IsNew = false
                        });
                    }
                }
            }

            return closed;
        }

        /// <summary>
        /// Every thread that currently holds an open ticket, keyed by Thread ID.
        /// Taken in one read rather than a query per thread — a day's file carries
        /// over a hundred threads. The lock hints hold the range for the whole
        /// transaction so the numbers handed out stay unique.
        /// </summary>
        private static Dictionary<string, OpenTicket> ReadOpenTickets(
            SqlConnection connection, SqlTransaction transaction)
        {
            const string sql = @"
SELECT   Thread_ID, Ticket_ID, SLA, Ticket_Status, EmailLink, Created_Date, SLA_Status
FROM     PRIDE_TICKET_ACJNOWLEDGEMENT WITH (UPDLOCK, HOLDLOCK)
WHERE    Ticket_Status = 'Open'";

            var tickets = new Dictionary<string, OpenTicket>(StringComparer.OrdinalIgnoreCase);

            using (var command = new SqlCommand(sql, connection, transaction))
            using (var reader = command.ExecuteReader())
            {
                while (reader.Read())
                {
                    var threadId = ReadString(reader, "Thread_ID");

                    if (threadId.Length > 0 && !tickets.ContainsKey(threadId))
                    {
                        tickets[threadId] = new OpenTicket
                        {
                            TicketId = ReadString(reader, "Ticket_ID"),
                            Sla = ReadString(reader, "SLA"),
                            TicketStatus = ReadString(reader, "Ticket_Status"),
                            EmailLink = ReadString(reader, "EmailLink"),
                            CreatedDate = ReadNullableDateTime(reader, "Created_Date"),
                            SlaStatus = ReadString(reader, "SLA_Status")
                        };
                    }
                }
            }

            return tickets;
        }

        /// <summary>An open ticket as stored, for reuse by a returning thread.</summary>
        private class OpenTicket
        {
            public string TicketId;
            public string Sla;
            public string TicketStatus;
            public string EmailLink;

            /// <summary>When the ticket was raised — what its countdown runs from.</summary>
            public DateTime? CreatedDate;
            public string SlaStatus;
        }

        /// <summary>Highest number already used in a year, or 0 when the year is unused.</summary>
        private static int ReadHighestTicketSequence(
            SqlConnection connection, SqlTransaction transaction, int year)
        {
            const string sql = @"
SELECT   MAX(CAST(RIGHT(Ticket_ID, @digits) AS INT))
FROM     PRIDE_TICKET_ACJNOWLEDGEMENT WITH (UPDLOCK, HOLDLOCK)
WHERE    Ticket_ID LIKE @pattern
     AND LEN(Ticket_ID) = @length
     AND RIGHT(Ticket_ID, @digits) NOT LIKE '%[^0-9]%'";

            var prefix = $"{TicketIdPrefix}-{year}-";

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.Parameters.Add("@digits", SqlDbType.Int).Value = TicketSequenceDigits;
                command.Parameters.Add("@pattern", SqlDbType.VarChar, 30).Value = prefix + "%";
                command.Parameters.Add("@length", SqlDbType.Int).Value = prefix.Length + TicketSequenceDigits;

                var result = command.ExecuteScalar();

                return result == null || result == DBNull.Value ? 0 : Convert.ToInt32(result);
            }
        }

        /// <summary>
        /// Writes the new ticket and returns the instant it was raised.
        ///
        /// Created_Date is stamped in the same statement that writes the Ticket ID
        /// and the SLA, with the database's own GETDATE(), because it is what the
        /// SLA countdown is anchored to: everything downstream measures against
        /// that same clock. [Date] beside it is only the email's date as text.
        /// </summary>
        private static DateTime InsertTicket(
            SqlConnection connection, SqlTransaction transaction,
            string threadId, string ticketId, string emailDate, string emailLink)
        {
            const string sql = @"
INSERT INTO PRIDE_TICKET_ACJNOWLEDGEMENT
       (Thread_ID, Ticket_ID, SLA, Ticket_Status, [Date], EmailLink, Created_Date, SLA_Status)
OUTPUT INSERTED.Created_Date
VALUES (@threadId, @ticketId, @sla, @status, @date, @emailLink, GETDATE(), @slaStatus)";

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.Parameters.Add("@threadId", SqlDbType.VarChar, 100).Value = threadId;
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value = ticketId;
                command.Parameters.Add("@sla", SqlDbType.VarChar, 50).Value = TicketDefaultSla;
                command.Parameters.Add("@status", SqlDbType.VarChar, 20).Value = TicketStatusOpen;
                command.Parameters.Add("@date", SqlDbType.VarChar, 50).Value = emailDate ?? string.Empty;
                command.Parameters.Add("@emailLink", SqlDbType.NVarChar).Value =
                    string.IsNullOrWhiteSpace(emailLink) ? (object)DBNull.Value : emailLink;
                command.Parameters.Add("@slaStatus", SqlDbType.VarChar, 20).Value = SlaStatusOnTrack;

                return Convert.ToDateTime(command.ExecuteScalar());
            }
        }

        /// <summary>
        /// The database's clock, taken inside the caller's transaction.
        ///
        /// Every "seconds left" the UI is given is measured against this rather
        /// than against the app server's own clock, so the two boxes drifting
        /// apart cannot make a ticket look overdue before the sweep agrees it is.
        /// </summary>
        private static DateTime ReadServerNow(SqlConnection connection, SqlTransaction transaction)
        {
            using (var command = new SqlCommand("SELECT GETDATE()", connection, transaction))
            {
                return Convert.ToDateTime(command.ExecuteScalar());
            }
        }

        /// <summary>
        /// Moves every open ticket that has run past its SLA to Overdue, or just
        /// the one named.
        ///
        /// This is the only thing that writes the breach, and it is set-based:
        /// one statement for the whole table rather than a row at a time. There
        /// is no scheduler in this application, so it is run wherever the answer
        /// is about to be looked at — when a date's tickets are acknowledged, and
        /// when a reviewer's countdown reaches zero (refresh-sla). Nothing is
        /// written while a clock merely ticks.
        ///
        /// The deadline is computed from Created_Date rather than read from a
        /// column, so it always agrees with what the UI was told.
        /// </summary>
        /// <param name="ticketId">One ticket to check, or null to sweep them all.</param>
        /// <returns>How many tickets this moved to Overdue.</returns>
        private static int MarkOverdueTickets(
            SqlConnection connection, SqlTransaction transaction, string ticketId)
        {
            // @slaHours is the default rather than each row's own SLA text: T-SQL
            // cannot read "24 Hours". Should tickets ever carry different SLAs,
            // this becomes a CROSS APPLY mapping the text to hours per row.
            const string sql = @"
UPDATE PRIDE_TICKET_ACJNOWLEDGEMENT
SET    SLA_Status = @overdue
WHERE  Ticket_Status = @open
   AND (SLA_Status = @onTrack OR SLA_Status IS NULL)
   AND Created_Date IS NOT NULL
   AND DATEADD(SECOND, @slaSeconds, Created_Date) <= GETDATE()
   AND (@ticketId IS NULL OR Ticket_ID = @ticketId)";

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@overdue", SqlDbType.VarChar, 20).Value = SlaStatusOverdue;
                command.Parameters.Add("@open", SqlDbType.VarChar, 20).Value = TicketStatusOpen;
                command.Parameters.Add("@onTrack", SqlDbType.VarChar, 20).Value = SlaStatusOnTrack;
                command.Parameters.Add("@slaSeconds", SqlDbType.Int).Value =
                    (int)Math.Round(TicketDefaultSlaHours * 3600);
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value =
                    string.IsNullOrWhiteSpace(ticketId) ? (object)DBNull.Value : ticketId.Trim();

                return command.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Stamps Created_Date on an open ticket that has none.
        ///
        /// Tickets raised before the column existed were backfilled from their
        /// email date; the few whose date would not parse were left blank and
        /// would otherwise never get a clock, because a reused ticket takes no
        /// other write. Only blanks are filled — a ticket that already has a
        /// creation stamp must never have it moved, or its countdown would
        /// restart, which is the whole thing this column exists to stop.
        /// </summary>
        /// <returns>The stamp written, or null when the ticket already had one.</returns>
        private static DateTime? FillMissingCreatedDate(
            SqlConnection connection, SqlTransaction transaction, string ticketId)
        {
            const string sql = @"
UPDATE PRIDE_TICKET_ACJNOWLEDGEMENT
SET    Created_Date = GETDATE(),
       SLA_Status   = @onTrack
OUTPUT INSERTED.Created_Date
WHERE  Ticket_ID = @ticketId AND Created_Date IS NULL";

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value = ticketId;
                command.Parameters.Add("@onTrack", SqlDbType.VarChar, 20).Value = SlaStatusOnTrack;

                var stamped = command.ExecuteScalar();

                return stamped == null || stamped == DBNull.Value
                    ? (DateTime?)null
                    : Convert.ToDateTime(stamped);
            }
        }

        /// <summary>
        /// Fills in the EmailLink of an existing ticket that has none.
        ///
        /// Threads already holding an open ticket never hit the insert above, so
        /// without this their EmailLink would stay empty forever. Only blank links
        /// are written — an existing one is left alone, the same way a reused
        /// ticket's Date is never overwritten.
        /// </summary>
        private static void FillMissingEmailLink(
            SqlConnection connection, SqlTransaction transaction, string ticketId, string emailLink)
        {
            const string sql = @"
UPDATE PRIDE_TICKET_ACJNOWLEDGEMENT
SET    EmailLink = @emailLink
WHERE  Ticket_ID = @ticketId
   AND (EmailLink IS NULL OR LTRIM(RTRIM(EmailLink)) = '')";

            using (var command = new SqlCommand(sql, connection, transaction))
            {
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value = ticketId;
                command.Parameters.Add("@emailLink", SqlDbType.NVarChar).Value = emailLink;

                command.ExecuteNonQuery();
            }
        }

        /// <summary>e.g. (2026, 1) → "TKT-2026-000001".</summary>
        private static string FormatTicketId(int year, int sequence)
        {
            var format = new string('0', TicketSequenceDigits);

            return $"{TicketIdPrefix}-{year}-{sequence.ToString(format, CultureInfo.InvariantCulture)}";
        }

        /// <summary>
        /// Year a ticket is numbered under, taken from the thread's Email Date
        /// ("13-May-26" → 2026). Falls back to the report date's year when the
        /// value cannot be read.
        /// </summary>
        private static int TicketYearOf(string emailDate, int fallbackYear)
        {
            var formats = new[]
            {
                "dd-MMM-yy", "dd-MMM-yyyy", "d-MMM-yy", "d-MMM-yyyy",
                "dd-MM-yyyy", "d-M-yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy"
            };

            DateTime parsed;

            if (DateTime.TryParseExact((emailDate ?? string.Empty).Trim(), formats,
                    CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed))
            {
                return parsed.Year;
            }

            return fallbackYear;
        }

        // ── WORKFLOW NODE 2: Customer Email Verification ─────────────

        /// <summary>Status parked on the row when the sender is not in the customer master.</summary>
        private const string TicketedPendingCrmHeadStatus = "";

        // Verdicts written into the per-step match columns. A row already carrying
        // one of these has had that step run, and the UI resumes rather than re-running it.
        private const string MatchedValue = "Match";
        private const string UnmatchedValue = "Unmatch";

        // Values for the receipts file's existing "Workflow Status" column: where the
        // thread currently sits in the pipeline. Spelled the way the column already
        // reads in the data ("Pending Unit Match"), so one state has one spelling.
        // Each step rewrites this for its thread — a step that failed leaves the
        // thread pending on itself, one that passed moves it on to the next step.
        private const string PendingCustomerEmailMatch = "Pending Customer Email Match";
        private const string PendingUnitMatch = "Pending Unit Match";
        private const string PendingInstrumentMatch = "Pending Instrument Match";
        private const string PendingBankReconciliation = "Pending Bank Reconciliation";

        /// <summary>
        /// Where a non-payment thread waits once its unit is matched. Those
        /// threads carry no payment to trace or reconcile, so the pipeline ends
        /// at the reply to the customer rather than at Instrument Match.
        /// </summary>
        private const string PendingEmailResponse = "Pending Email Response";

        /// <summary>Pipeline node the thread moves to once the sender is verified.</summary>
        private const string UnitMatchStep = "Unit Match";

        /// <summary>Last node of a non-payment thread: the reply to the customer.</summary>
        private const string EmailResponseStep = "Email Response";

        /// <summary>
        /// True when the thread was classified as Non-Payment — a document
        /// request, a statement ask, a query.
        ///
        /// Matched with the punctuation stripped, because the column holds
        /// display text ("Non-Payment - Customer", "Payment - Unverified")
        /// rather than a code.
        ///
        /// Both halves count. The bare "Non-Payment" this used to test for was
        /// split into "Non-Payment - Customer" and "Non-Payment - System" and is
        /// no longer written by the classifier, so the old equality matched no
        /// live row at all: a Non-Payment - Customer thread whose unit matched
        /// was being sent to Instrument Match, a step it has no payments for,
        /// and the FE had to rewrite the stored status for display. Matching the
        /// prefix instead is what makes the stored value right in the first
        /// place, and the old bare value still matches for any row that predates
        /// the split.
        /// </summary>
        private static bool IsNonPaymentCategory(string category)
        {
            var letters = LettersOnly(category);

            return letters == "nonpayment"
                || letters == "nonpaymentcustomer"
                || letters == "nonpaymentsystem";
        }

        /// <summary>
        /// True when the [Category] is specifically "Non-Payment - Customer".
        ///
        /// Narrower than <see cref="IsNonPaymentCategory"/>, which also accepts
        /// "Non-Payment - System" and the pre-split bare "Non-Payment": only the
        /// Customer half opens the agreement steps. Matched with the punctuation
        /// stripped, for the same reason as the broader test.
        /// </summary>
        private static bool IsNonPaymentCustomerCategory(string category)
        {
            return LettersOnly(category) == "nonpaymentcustomer";
        }

        /// <summary>
        /// True when the thread runs the Agreement Workflow's thirteen steps.
        ///
        /// All three conditions, and only all three: a Category of
        /// "Non-Payment - Customer", an Intent of "Agreement" and a Sub-Intent of
        /// "Agreement". Anything else — a Non-Payment - System thread, a
        /// Non-Payment thread about something other than an agreement, an
        /// agreement mentioned on a Payment thread — keeps the pipeline it has
        /// today, untouched by this.
        ///
        /// System-raised threads were included at first and the client has since
        /// scoped the thirteen steps to customer-raised ones, so a
        /// "Non-Payment - System" agreement thread now falls through to the plain
        /// non-payment route (straight to Email Response) like any other.
        ///
        /// Intent and Sub-Intent are compared as trimmed text rather than
        /// through LettersOnly: unlike Category, they are single words with no
        /// punctuation to strip, and an exact word is what the classifier writes.
        /// </summary>
        private static bool IsAgreementThread(EmailReceiptRow row)
        {
            return row != null
                && IsNonPaymentCustomerCategory(row.Category)
                && IsAgreementValue(row.Intent)
                && IsAgreementValue(row.SubIntent);
        }

        /// <summary>The one Intent/Sub-Intent value that opens the agreement steps.</summary>
        private static bool IsAgreementValue(string value)
        {
            return string.Equals(
                (value ?? string.Empty).Trim(), "Agreement", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// A [Category] with its punctuation and spacing stripped, lowercased, so
        /// display text can be compared without every caller re-deciding how the
        /// dashes and spaces in it are written.
        /// </summary>
        private static string LettersOnly(string category)
        {
            return new string((category ?? string.Empty)
                .ToLowerInvariant()
                .Where(char.IsLetter)
                .ToArray());
        }

        /// <summary>
        /// True when the thread is a bank/loan batch - one email covering many
        /// customers, whose payments and thread-level state live in
        /// LoanReceiptDetailsTable rather than on the receipts row.
        ///
        /// Both sides of the comparison are normalised, so the literal it is
        /// checked against is the category as it is actually written rather than
        /// a hand-stripped copy of it that has to be kept in step by hand.
        /// </summary>
        private static bool IsLoanCategory(string category)
        {
            return LettersOnly(category) == LettersOnly(LoanCategory);
        }

        /// <summary>
        /// POST api/emailautomation/verify-customer-email
        /// Body: { "date": "2026-05-13", "threadId": "THR-d48b00bb" }
        ///
        /// Node 2 of the Workflow Pipeline. Takes the thread's Customer Sender and
        /// asks BookedUnitsProcedure what live units that address owns — matched
        /// against EMAIL1, EMAIL2 and EMAIL3, in the booking master first and then
        /// the co-applicant table, so a co-applicant verifies on their own address
        /// rather than only the primary applicant's:
        ///   • any unit returned → verified; the pipeline moves on to Unit Match.
        ///   • none              → the thread's Status cell in
        ///     main_email_receipts_{date}.csv is set to "Ticketed Pending CRM head"
        ///     and the file is saved.
        /// </summary>
        [HttpPost]
        [Route("verify-customer-email")]
        public IHttpActionResult VerifyCustomerEmail(CustomerEmailVerificationRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var emailDates = ResolveEmailDateValues(request.Date);
            var binding = ResolveBinding(request.ThreadId);
            var row = ReadThreadRow(emailDates, binding);

            if (row == null)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"Thread {request.ThreadId} has no {ReceiptsTable} row for {request.Date}." });
            }

            var senderEmail = ExtractEmailAddress(row.CustomerSender);

            var response = new CustomerEmailVerificationResponse
            {
                Date = request.Date,
                ThreadId = row.ThreadId,
                SenderEmail = senderEmail,
                Bookings = new List<CustomerBookingMatch>()
            };

            // A blank sender can never own a unit, so it takes the same
            // "not found" path rather than hitting the database.
            if (!string.IsNullOrWhiteSpace(senderEmail))
            {
                response.Bookings = RunBookedUnitsLookup(senderEmail);
            }

            response.Matched = response.Bookings.Count > 0;

            // Narrowed by whatever the row already says about the unit, so a
            // customer holding one flat needs no choosing and one holding six is
            // cut down to the ones that fit.
            response.Candidates = NarrowBookingsToRow(response.Bookings, row);

            // Record the verdict on the row so a later visit can skip this step,
            // and move the row's Workflow Status to whatever it now waits on.
            UpdateReceiptColumn(emailDates, binding, "Customer Email Match",
                response.Matched ? MatchedValue : UnmatchedValue);

            // Same as Unit Match below: the card prints the stamp the write set,
            // and an unmatched run is not stamped and prints nothing.
            response.MatchDate = response.Matched
                ? ReadMatchStamp(emailDates, binding, "Customer Email Match")
                : string.Empty;

            response.WorkflowStatus = response.Matched ? PendingUnitMatch : PendingCustomerEmailMatch;
            UpdateReceiptColumn(emailDates, binding, "Workflow Status", response.WorkflowStatus);

            if (response.Matched)
            {
                response.NextStep = UnitMatchStep;

                // No table is named. The procedure answers from the booking master
                // or the co-applicant table without saying which, and a message
                // that guessed would send a reviewer looking for a row that may
                // not be there.
                response.Message =
                    $"Sender matched {response.Bookings.Count} booking(s). " +
                    $"Proceeding to {UnitMatchStep}.";
            }
            else
            {
                UpdateReceiptColumn(emailDates, binding, "Status", TicketedPendingCrmHeadStatus);

                response.StatusWritten = TicketedPendingCrmHeadStatus;
                response.Message = string.IsNullOrWhiteSpace(senderEmail)
                    ? $"This thread has no Customer Sender address, so it cannot be verified. Status set to \"{TicketedPendingCrmHeadStatus}\"."
                    : $"\"{senderEmail}\" owns no live booking, as either the primary applicant " +
                      $"or a co-applicant. Status set to \"{TicketedPendingCrmHeadStatus}\".";
            }

            return Ok(response);
        }

        /// <summary>
        /// Narrows the sender's bookings by what the receipt row already knows.
        ///
        /// Each of Project, Sub Project and Unit is applied only when the row
        /// carries it — these columns are extracted from an email and are often
        /// blank — and only when it leaves something behind: a filter that empties
        /// the list has told us the row disagrees with the master, and the
        /// reviewer is better served picking from the customer's real bookings
        /// than from nothing at all.
        /// </summary>
        private static List<CustomerBookingMatch> NarrowBookingsToRow(
            List<CustomerBookingMatch> bookings, EmailReceiptRow row)
        {
            var candidates = bookings ?? new List<CustomerBookingMatch>();

            candidates = NarrowBy(candidates, row.Project,
                (booking, value) => ContainsValue(booking.ProjectName, value));

            candidates = NarrowBy(candidates, row.SubProject,
                (booking, value) => ContainsValue(booking.SubProjectName, value));

            // UNIT_NO is "<block> <number>" in the master and the number alone on
            // the row, the same comparison FindBookingsByUnit makes in SQL.
            candidates = NarrowBy(candidates, row.Unit,
                (booking, value) => string.Equals(UnitNumberPart(booking.UnitNo), value,
                    StringComparison.OrdinalIgnoreCase));

            return candidates;
        }

        private static List<CustomerBookingMatch> NarrowBy(
            List<CustomerBookingMatch> candidates,
            string rowValue,
            Func<CustomerBookingMatch, string, bool> matches)
        {
            var value = (rowValue ?? string.Empty).Trim();

            if (IsBlankValue(value) || candidates.Count <= 1)
            {
                return candidates;
            }

            var narrowed = candidates.Where(booking => matches(booking, value)).ToList();

            return narrowed.Count > 0 ? narrowed : candidates;
        }

        private static bool ContainsValue(string masterValue, string rowValue)
        {
            return (masterValue ?? string.Empty).IndexOf(rowValue, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>"B 703" → "703"; a UNIT_NO with no space has no number part.</summary>
        private static string UnitNumberPart(string unitNo)
        {
            var value = (unitNo ?? string.Empty).Trim();
            var space = value.IndexOf(' ');

            return space < 0 ? string.Empty : value.Substring(space + 1).Trim();
        }

        /// <summary>
        /// True for a cell that holds nothing usable. The extractor writes "N/A"
        /// (and friends) where it found nothing, which is a value as far as a
        /// blank check is concerned but means the same as empty.
        /// </summary>
        private static bool IsBlankValue(string value)
        {
            var trimmed = (value ?? string.Empty).Trim();

            if (trimmed.Length == 0)
            {
                return true;
            }

            var placeholders = new[] { "n/a", "na", "none", "null", "-", "--" };

            return placeholders.Contains(trimmed.ToLowerInvariant());
        }

        /// <summary>
        /// POST api/emailautomation/apply-booking
        /// Body: { "date": "2026-05-13", "threadId": "THR-411af1a7",
        ///         "emailReceiptsId": "1024", "project": "SOHO", "subProject": "B", "unit": "703" }
        ///
        /// Writes the booking the reviewer picked (or the only one the customer
        /// had) onto the thread's receipt row, ready for Unit Match to run
        /// against it.
        ///
        /// Only columns that are currently blank are written. What the email
        /// actually said is evidence, and a booking chosen in the UI does not
        /// overwrite it — if the row says Unit 703 and the reviewer picks 705,
        /// the disagreement is left for Unit Match to report rather than papered
        /// over here.
        /// </summary>
        [HttpPost]
        [Route("apply-booking")]
        public IHttpActionResult ApplyBooking(BookingSelectionRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            if (string.IsNullOrWhiteSpace(request.EmailReceiptsId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'emailReceiptsId' is required." });
            }

            var emailDates = ResolveEmailDateValues(request.Date);
            var binding = ResolveBinding(request.ThreadId);
            var row = ReadThreadRow(emailDates, binding);

            if (row == null)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"Thread {request.ThreadId} has no {ReceiptsTable} row for {request.Date}." });
            }

            var fills = new Dictionary<string, string>
            {
                { "Project", request.Project },
                { "Sub Project", request.SubProject },
                { "Unit", request.Unit },
            };

            var current = new Dictionary<string, string>
            {
                { "Project", row.Project },
                { "Sub Project", row.SubProject },
                { "Unit", row.Unit },
            };

            var updated = new List<string>();

            foreach (var fill in fills)
            {
                // Blank on the row and something to write: those are the only
                // cells this endpoint touches.
                if (IsBlankValue(fill.Value) || !IsBlankValue(current[fill.Key]))
                {
                    continue;
                }

                if (!UpdateEditableReceiptColumn(binding, request.EmailReceiptsId, fill.Key, fill.Value))
                {
                    continue;
                }

                updated.Add(fill.Key);

                WriteAuditLog(
                    request.EmailReceiptsId, request.ThreadId, fill.Key,
                    current[fill.Key], fill.Value, request.UpdatedBy, AuditTypeReceipt);
            }

            return Ok(new ReceiptUpdateResponse
            {
                Date = request.Date,
                ThreadId = request.ThreadId,
                UpdatedColumns = updated,
                Row = ReadThreadRow(emailDates, binding),
                Message = updated.Count > 0
                    ? $"Filled {string.Join(", ", updated)} from the selected booking."
                    : "The row already carried its project, sub project and unit; nothing was overwritten."
            });
        }

        /// <summary>
        /// The booking lookup, which lives in the database rather than here.
        ///
        /// Takes the address and returns the live units it owns: the booking
        /// master first, and — only if the sender is on no booking there — the
        /// co-applicant table joined back to the master, so a co-applicant
        /// verifies on their own address rather than only the primary
        /// applicant's. That fallback, and the list of statuses that count as
        /// dead, are the procedure's own.
        ///
        /// The customer portal answers the same question from the same procedure.
        /// It used to be duplicated here as inline SQL, which meant the rule
        /// existed twice and only one copy would be updated: change the dead
        /// status list for the portal and email automation would quietly keep
        /// parking those customers at CRM head. One definition, one answer.
        ///
        /// The procedure is only as quick as the indexes underneath it — see
        /// App_Data/Scripts/SALES_BOOKING_DETAILS_email_indexes.sql.
        /// </summary>
        private const string BookedUnitsProcedure = "dbo.PRIDE_CUSTOMER_PORTAL_BOOKED_UNITS";

        /// <summary>
        /// The sender's live booked units, as primary applicant or co-applicant.
        ///
        /// Both steps that ask "what does this address own" come through here, so
        /// the connection, the timeout and the parameter binding are written once.
        /// Which of the two tables answered is the procedure's business, not this
        /// method's; see BookedUnitsProcedure. A sender who owns nothing comes
        /// back empty, which is node 2's "not verified" case and not an error.
        ///
        /// The only call in this solution that uses CommandType.StoredProcedure:
        /// everything else is inline SQL against a table.
        /// </summary>
        private static List<CustomerBookingMatch> RunBookedUnitsLookup(string senderEmail)
        {
            var bookings = new List<CustomerBookingMatch>();

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(BookedUnitsProcedure, connection))
            {
                command.CommandType = CommandType.StoredProcedure;
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@email", SqlDbType.NVarChar, 256).Value = senderEmail;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        bookings.Add(ReadBooking(reader));
                    }
                }
            }

            return bookings;
        }

        /// <summary>
        /// Maps the current booked-units row onto the booking DTO.
        ///
        /// The procedure matches on EMAIL1, EMAIL2 and EMAIL3 but does not return
        /// them, so which of the three produced the hit cannot be reported. It was
        /// shown in the Step Inspector back when the lookup was inline here.
        /// </summary>
        private static CustomerBookingMatch ReadBooking(IDataRecord reader)
        {
            return new CustomerBookingMatch
            {
                AccountItemNo = ReadString(reader, "ACCOUNT_ITEM_NO"),
                BookingStatusName = ReadString(reader, "BOOKING_STATUS_NAME"),
                ProjectId = ReadString(reader, "PROJECT_ID"),
                ProjectName = ReadString(reader, "PROJECT_NAME"),
                SubProjectId = ReadString(reader, "SUBPROJECT_ID"),
                SubProjectName = ReadString(reader, "SUBPROJECT_NAME"),
                UnitId = ReadString(reader, "UNIT_ID"),
                UnitNo = ReadString(reader, "UNIT_NO"),
                FloorNo = ReadString(reader, "FLOOR_NO"),
                UnitTypeName = ReadString(reader, "UNIT_TYPE_NAME"),
                CustomerId = ReadString(reader, "CUSTOMER_ID"),
                CustomerName = string.Join(" ", new[]
                {
                    ReadString(reader, "CUST_TITLE"),
                    ReadString(reader, "CUST_FNAME"),
                    ReadString(reader, "LAST_NAME")
                }.Where(part => !string.IsNullOrWhiteSpace(part)))
            };
        }

        private static string ReadString(IDataRecord reader, string columnName)
        {
            var value = reader[columnName];

            return value == null || value == DBNull.Value ? string.Empty : value.ToString().Trim();
        }

        /// <summary>
        /// Reads a real `datetime` column, e.g. Created_Date. Null for NULL —
        /// unlike the report's date columns, which are text and read as strings.
        /// </summary>
        private static DateTime? ReadNullableDateTime(IDataRecord reader, string columnName)
        {
            var value = reader[columnName];

            return value == null || value == DBNull.Value ? (DateTime?)null : Convert.ToDateTime(value);
        }

        /// <summary>
        /// Reads a `datetime` column as an ISO 8601 string, or "" for NULL.
        ///
        /// Round-trip format ("o"), invariant, exactly as the reply list already
        /// sends Created_On: the browser parses it unambiguously and the Angular
        /// side decides how it should read. Formatting it here would bake one
        /// locale into the API.
        /// </summary>
        private static string ReadIsoDateTime(IDataRecord reader, string columnName)
        {
            var value = reader[columnName];

            return value == null || value == DBNull.Value
                ? string.Empty
                : Convert.ToDateTime(value).ToString("o", CultureInfo.InvariantCulture);
        }

        /// <summary>Reads a `bit` column, e.g. [Alert Received]. False for NULL.</summary>
        private static bool ReadBool(IDataRecord reader, string columnName)
        {
            var value = reader[columnName];

            if (value == null || value == DBNull.Value)
            {
                return false;
            }

            if (value is bool flag)
            {
                return flag;
            }

            var text = value.ToString().Trim();

            return string.Equals(text, "true", StringComparison.OrdinalIgnoreCase) || text == "1";
        }

        /// <summary>
        /// Pulls the bare address out of a Customer Sender value. Most rows already
        /// hold a plain address, but "Name &lt;a@b.com&gt;" shows up too and would
        /// never match the master if it were passed through as-is.
        /// </summary>
        private static string ExtractEmailAddress(string customerSender)
        {
            var value = (customerSender ?? string.Empty).Trim();

            if (value.Length == 0)
            {
                return string.Empty;
            }

            var match = Regex.Match(value, @"[^\s<>""']+@[^\s<>""']+");

            return match.Success ? match.Value.Trim() : value;
        }

        // ── WORKFLOW NODE 3: Unit Match ──────────────────────────────

        /// <summary>Remark parked on the row when no booking matches unit + email + project.</summary>
        private const string UnitNotMatchedRemark = "AI pipline recorde not match";

        /// <summary>Pipeline node the thread moves to once the unit is matched.</summary>
        private const string InstrumentMatchStep = "Instrument Match";

        /// <summary>
        /// POST api/emailautomation/match-unit
        /// Body: { "date": "2026-05-13", "threadId": "THR-d48b00bb" }
        ///
        /// Node 3 of the Workflow Pipeline, run after Customer Email Verification
        /// passes. Looks for one of the sender's booked units — as primary
        /// applicant or co-applicant — that matches all three of the thread's
        /// Unit, Customer Sender and Project at once:
        ///   • match    → the pipeline moves on to Instrument Match.
        ///   • no match → the thread's Remark cell in main_email_receipts_{date}.csv
        ///     is set to "AI pipline recorde not match" and the file is saved.
        /// </summary>
        [HttpPost]
        [Route("match-unit")]
        public IHttpActionResult MatchUnit(UnitMatchRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var emailDates = ResolveEmailDateValues(request.Date);
            var binding = ResolveBinding(request.ThreadId);
            var row = ReadThreadRow(emailDates, binding);

            if (row == null)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"Thread {request.ThreadId} has no {ReceiptsTable} row for {request.Date}." });
            }

            var senderEmail = ExtractEmailAddress(row.CustomerSender);
            var unit = (row.Unit ?? string.Empty).Trim();
            var project = (row.Project ?? string.Empty).Trim();

            var response = new UnitMatchResponse
            {
                Date = request.Date,
                ThreadId = row.ThreadId,
                Unit = unit,
                SenderEmail = senderEmail,
                Project = project,
                Bookings = new List<CustomerBookingMatch>()
            };

            // All three are required by the lookup, so a blank one can only ever
            // take the no-match path — no point querying for it.
            if (unit.Length > 0 && senderEmail.Length > 0 && project.Length > 0)
            {
                response.Bookings = FindBookingsByUnit(unit, senderEmail, project);
            }

            response.Matched = response.Bookings.Count > 0;

            // Where a matched unit sends the thread next, which is the one thing
            // the three routes disagree about:
            //
            //   • an agreement thread has thirteen back-office stages to run
            //     before anyone replies, so it goes to the first of them;
            //   • any other non-payment thread carries no money to trace, so it
            //     goes straight to the reply;
            //   • a payment thread goes to Instrument Match, as it always has.
            var isNonPayment = IsNonPaymentCategory(row.Category);
            var isAgreement = IsAgreementThread(row);

            var nextStep = isAgreement
                ? AgreementSteps[0].Title
                : (isNonPayment ? EmailResponseStep : InstrumentMatchStep);

            var matchedStatus = isAgreement
                ? AgreementSteps[0].PendingStatus
                : (isNonPayment ? PendingEmailResponse : PendingInstrumentMatch);

            response.WorkflowStatus = response.Matched ? matchedStatus : PendingUnitMatch;

            if (response.Matched)
            {
                var booking = response.Bookings[0];

                response.NextStep = nextStep;
                response.Message =
                    $"Unit {unit} matched booking {booking.AccountItemNo} (UNIT_NO {booking.UnitNo}) " +
                    $"on {booking.ProjectName}. Proceeding to {nextStep}.";
            }
            else
            {
                response.RemarkWritten = UnitNotMatchedRemark;
                response.Message =
                    $"No booking matches Unit \"{unit}\", sender \"{senderEmail}\" and project \"{project}\" together. " +
                    $"Remark set to \"{UnitNotMatchedRemark}\".";
            }

            // Record the verdict on the row so a later visit can skip this step,
            // move Workflow Status to whatever it now waits on, and — on a
            // no-match — park the thread with its Remark. Settled first and
            // written together: three separate UPDATEs here each took their own
            // locks across the table, and that is what another request's read
            // kept deadlocking against.
            var writes = new List<KeyValuePair<string, string>>
            {
                new KeyValuePair<string, string>("Unit Match", response.Matched ? MatchedValue : UnmatchedValue),
                new KeyValuePair<string, string>("Workflow Status", response.WorkflowStatus)
            };

            if (!response.Matched)
            {
                writes.Add(new KeyValuePair<string, string>("Remark", UnitNotMatchedRemark));
            }

            UpdateReceiptColumns(emailDates, binding, writes);

            // The stamp the write just set, so the pipeline card can print the
            // time without waiting for the row to be read again. Only a match is
            // stamped, so an unmatched run returns "" and the card prints nothing.
            response.MatchDate = response.Matched
                ? ReadMatchStamp(emailDates, binding, "Unit Match")
                : string.Empty;

            return Ok(response);

        }

        // ── WORKFLOW NODES A1-A13: the Agreement Workflow ────────────

        /// <summary>
        /// POST api/emailautomation/verify-agreement-step
        /// Body: { "date": "2026-09-18", "threadId": "THR-d48b00bb",
        ///         "stepKey": "agreement-drafting" }
        ///
        /// One endpoint for all thirteen stages of the Agreement Workflow, which
        /// a "Non-Payment - Customer" thread runs when its Intent and Sub-Intent
        /// are both "Agreement" — see IsAgreementThread.
        ///
        /// One rather than thirteen because the stages differ only in which
        /// column they write. None of them has a master-data lookup of its own:
        /// they are back-office stages a reviewer works through and confirms, so
        /// verifying one records that confirmation ("Match", stamped by the same
        /// UPDATE) and moves [Workflow Status] on to the stage after it. A stage
        /// that later grows a real check gets a branch here and nothing else
        /// changes. The thirteenth hands the thread to the reply.
        ///
        /// The order is enforced here, not only in the UI: a stage whose
        /// predecessor has not passed is refused, so a request made out of turn
        /// cannot leave the row claiming an agreement is further along than it is.
        /// </summary>
        [HttpPost]
        [Route("verify-agreement-step")]
        public IHttpActionResult VerifyAgreementStep(AgreementStepRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            // Resolved against the table, never taken from the request. This is
            // the same guard the writable whitelists give every other step: the
            // column name that reaches the SQL is one of ours by construction.
            var index = IndexOfAgreementStep(request.StepKey);

            if (index < 0)
            {
                return Content(HttpStatusCode.BadRequest, new
                {
                    message = $"Unknown 'stepKey' \"{request.StepKey}\".",
                    stepKeys = AgreementSteps.Select(known => known.StepKey).ToArray()
                });
            }

            var step = AgreementSteps[index];
            var emailDates = ResolveEmailDateValues(request.Date);
            var binding = ResolveBinding(request.ThreadId);
            var row = ReadThreadRow(emailDates, binding);

            if (row == null)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"Thread {request.ThreadId} has no {ReceiptsTable} row for {request.Date}." });
            }

            if (!IsAgreementThread(row))
            {
                // Not a refusal of this step so much as of the whole workflow:
                // the thread's category, intent or sub-intent says it does not
                // run these stages at all, and its own pipeline is unaffected.
                return Content(HttpStatusCode.BadRequest, new
                {
                    message =
                        $"Thread {row.ThreadId} does not run the Agreement Workflow. It needs a " +
                        "\"Non-Payment - Customer\" category with Intent and Sub-Intent both \"Agreement\"; this one is " +
                        $"Category \"{row.Category}\", Intent \"{row.Intent}\", Sub-Intent \"{row.SubIntent}\".",
                    category = row.Category,
                    intent = row.Intent,
                    subIntent = row.SubIntent
                });
            }

            // Strictly in order. The stage before this one has to have passed,
            // and only the stage immediately before it — an earlier gap is
            // impossible, because that stage could not have passed either.
            if (index > 0 && !IsMatchedVerdict(ReadAgreementVerdict(row, AgreementSteps[index - 1])))
            {
                var blocker = AgreementSteps[index - 1];

                return Content(HttpStatusCode.Conflict, new
                {
                    message = $"{step.Title} cannot be verified until {blocker.Title} has passed.",
                    blockedBy = blocker.Title,
                    blockedByStepKey = blocker.StepKey
                });
            }

            var next = index + 1 < AgreementSteps.Length ? AgreementSteps[index + 1] : null;

            var response = new AgreementStepResponse
            {
                Date = request.Date,
                ThreadId = row.ThreadId,
                StepKey = step.StepKey,
                StepTitle = step.Title,
                Matched = true,
                // After the last stage there is nothing left but the reply.
                NextStep = next != null ? next.Title : EmailResponseStep,
                WorkflowStatus = next != null ? next.PendingStatus : PendingEmailResponse
            };

            response.Message = $"{step.Title} verified. Proceeding to {response.NextStep}.";

            // One statement for the verdict and the status, as Unit Match does
            // above and for the same reason: separate UPDATEs each took their own
            // locks across the table, and that is what reads kept deadlocking
            // against. The stamp rides along on this one — MatchStampColumns
            // knows this column, so nothing here has to name its date column.
            UpdateReceiptColumns(emailDates, binding, new List<KeyValuePair<string, string>>
            {
                new KeyValuePair<string, string>(step.Column, MatchedValue),
                new KeyValuePair<string, string>("Workflow Status", response.WorkflowStatus)
            });

            // The stamp the write just set, so the card can print the time
            // without waiting for the row to be read again.
            response.MatchDate = ReadMatchStamp(emailDates, binding, step.Column);

            return Ok(response);
        }

        /// <summary>
        /// Where a step key sits in AgreementSteps, or -1 when it names none.
        /// Case-insensitive, since the key travels through JSON and a URL.
        /// </summary>
        private static int IndexOfAgreementStep(string stepKey)
        {
            var wanted = (stepKey ?? string.Empty).Trim();

            if (wanted.Length == 0)
            {
                return -1;
            }

            for (var index = 0; index < AgreementSteps.Length; index++)
            {
                if (string.Equals(AgreementSteps[index].StepKey, wanted, StringComparison.OrdinalIgnoreCase))
                {
                    return index;
                }
            }

            return -1;
        }

        /// <summary>
        /// One agreement step's stored verdict on a row, or "" when it has not
        /// run. Reads the map ReadAgreementSteps filled rather than the column,
        /// so there is no second round trip to decide whether the step before
        /// this one passed.
        /// </summary>
        private static string ReadAgreementVerdict(EmailReceiptRow row, AgreementStepDefinition step)
        {
            string verdict;

            return row.AgreementSteps != null &&
                   row.AgreementSteps.TryGetValue(step.StepKey, out verdict)
                ? verdict
                : string.Empty;
        }

        /// <summary>
        /// Unit + email + project lookup for node 3.
        ///
        /// The customer's booked units come from the procedure, then the unit and
        /// project tests are applied here rather than in SQL. They used to be a
        /// CTE wrapped round the inline query, which a procedure cannot enter;
        /// doing it in memory costs nothing, because a customer holds a handful of
        /// units and this filters that handful.
        ///
        /// Both tests are the ones NarrowBookingsToRow already applies, reused so
        /// node 2 and node 3 cannot disagree about what "same unit" means.
        /// A plain Where, though, not NarrowBy: NarrowBy keeps the whole list when
        /// a filter would empty it, which is right when offering a reviewer
        /// something to choose from and wrong here, where an empty result is the
        /// honest answer and the SQL this replaces had no such fallback.
        /// </summary>
        private static List<CustomerBookingMatch> FindBookingsByUnit(string unit, string senderEmail, string project)
        {
            return RunBookedUnitsLookup(senderEmail)
                .Where(booking =>
                    string.Equals(UnitNumberPart(booking.UnitNo), unit, StringComparison.OrdinalIgnoreCase)
                    && ContainsValue(booking.ProjectName, project))
                .ToList();
        }

        // ── Thread ownership ─────────────────────────────────────────

        /// <summary>
        /// POST api/emailautomation/assign-thread
        /// Body: { "date": "2026-05-09", "threadId": "THR-6319cc24", "assignedTo": "RITA" }
        ///
        /// Writes the CRM executive who owns the thread into
        /// main_email_receipts.[Assigned To].
        ///
        /// The name is resolved by the caller rather than here, and deliberately
        /// so: the project → users mapping, its wing parsing ("WELLINGTON - E-H-J-K"
        /// against Project "Wellington" + Sub Project "E") and its CRM-head fallback
        /// all live in config.json, which the UI reads. The one exception is the
        /// hourly auto-check, which has no UI to ask: it runs a mirror of the same
        /// rule (AssignAutoCheckOwner) and must be kept in step with it.
        ///
        /// Called when Unit Match settles: the first mapped user on a match, the
        /// configured fallback user when the unit did not match.
        /// </summary>
        [HttpPost]
        [Route("assign-thread")]
        public IHttpActionResult AssignThread(ThreadAssignmentRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            if (string.IsNullOrWhiteSpace(request.AssignedTo))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'assignedTo' is required." });
            }

            var assignedTo = request.AssignedTo.Trim();
            var emailDates = ResolveEmailDateValues(request.Date);
            var binding = ResolveBinding(request.ThreadId);

            if (!UpdateReceiptColumn(emailDates, binding, "Assigned To", assignedTo))
            {
                return Content(HttpStatusCode.NotFound, new
                {
                    message = $"Thread {request.ThreadId} has no row in {ReceiptsTable} for {request.Date}."
                });
            }

            return Ok(new ThreadAssignmentResponse
            {
                Date = request.Date,
                ThreadId = request.ThreadId,
                AssignedTo = assignedTo,
                Message = $"Thread assigned to {assignedTo}."
            });
        }

        /// <summary>
        /// Writes the default owner into [Assigned To] of threads that were just
        /// ticketed — only where it is still blank, so an owner already chosen
        /// (by Unit Match or a reviewer) is never overwritten.
        ///
        /// Set-based, one UPDATE per table, rather than a ResolveBinding and a
        /// write per thread: a date carries a hundred-odd threads. A classic
        /// thread's key only ever matches main_email_receipts.[Thread ID] and a
        /// loan customer's only the loan table's [Customer Thread ID], so both
        /// statements can take the whole list.
        /// </summary>
        private static void AssignDefaultOwner(
            List<string> emailDates, List<string> threadKeys, string assignee)
        {
            assignee = (assignee ?? string.Empty).Trim();

            if (assignee.Length == 0 || threadKeys.Count == 0)
            {
                return;
            }

            const string blank = "([Assigned To] IS NULL OR LTRIM(RTRIM([Assigned To])) = '')";

            // Stays well under SQL Server's 2100-parameter limit per statement.
            const int chunkSize = 500;

            using (var connection = new SqlConnection(PrideConnectionString))
            {
                connection.Open();

                for (var start = 0; start < threadKeys.Count; start += chunkSize)
                {
                    var chunk = threadKeys.Skip(start).Take(chunkSize).ToList();

                    if (emailDates.Count > 0)
                    {
                        using (var command = new SqlCommand())
                        {
                            command.Connection = connection;
                            command.CommandTimeout = SqlCommandTimeoutSeconds;

                            var threadIn = AddThreadKeyParameters(command, chunk);
                            var dateIn = AddEmailDateParameters(command, emailDates);

                            command.CommandText =
                                $"UPDATE {ReceiptsTable} SET [Assigned To] = @assignee " +
                                $"WHERE [{ThreadIdColumn}] IN ({threadIn}) AND [Email Date] IN ({dateIn}) AND {blank}";
                            command.Parameters.Add("@assignee", SqlDbType.VarChar).Value = assignee;

                            ExecuteWithDeadlockRetry(command);
                        }
                    }

                    using (var command = new SqlCommand())
                    {
                        command.Connection = connection;
                        command.CommandTimeout = SqlCommandTimeoutSeconds;

                        var threadIn = AddThreadKeyParameters(command, chunk);

                        command.CommandText =
                            $"UPDATE {LoanReceiptDetailsTable} SET [Assigned To] = @assignee " +
                            $"WHERE [{CustomerThreadIdColumn}] IN ({threadIn}) AND {blank}";
                        command.Parameters.Add("@assignee", SqlDbType.VarChar).Value = assignee;

                        ExecuteWithDeadlockRetry(command);
                    }
                }
            }
        }

        // ── Thread action status ──────────────────────────────────────

        /// <summary>
        /// The only values main_email_receipts.[Action Status] is ever written as.
        /// Mirrors statusLabel() in the FE's workflow-visualizer exactly — that is
        /// where this value is computed — so the grid's filter list can never drift
        /// from the words the pipeline panel itself shows.
        /// </summary>
        private static readonly string[] ValidActionStatuses =
        {
            "Done", "Pending", "User Verification Required", "User Intervention"
        };

        /// <summary>
        /// Retired wording, per the client: a step whose check came back incomplete
        /// or unmatched now reads "User Intervention". Still accepted on write (an
        /// open browser tab may be running the older FE) and mapped on read, so a
        /// row written before the change never shows the old words.
        /// </summary>
        private const string LegacyUserEditRequired = "User Edit Required";

        private static string NormalizeActionStatus(string status)
        {
            return string.Equals((status ?? string.Empty).Trim(), LegacyUserEditRequired, StringComparison.OrdinalIgnoreCase)
                ? "User Intervention"
                : status;
        }

        /// <summary>
        /// POST api/emailautomation/update-action-status
        /// Body: { "date": "2026-05-09", "threadId": "THR-6319cc24",
        ///         "action": "Instrument Match", "actionStatus": "User Intervention" }
        ///
        /// Writes which pipeline step is currently stopped on a thread, and why,
        /// into main_email_receipts.[Action] / [Action Status].
        ///
        /// The FE computes both values itself — the pipeline panel already derives
        /// them per node from waitingReason/pillStatus (see statusLabel() in
        /// workflow-visualizer.ts) — and calls this endpoint once it has settled on
        /// the thread's current node, so the grid can show and filter on the same
        /// answer without recomputing the whole pipeline for every row. A thread
        /// nobody has opened yet simply has no value here.
        /// </summary>
        [HttpPost]
        [Route("update-action-status")]
        public IHttpActionResult UpdateActionStatus(ThreadActionStatusRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            request.ActionStatus = NormalizeActionStatus(request.ActionStatus);

            if (string.IsNullOrWhiteSpace(request.ActionStatus) ||
                !ValidActionStatuses.Contains(request.ActionStatus.Trim(), StringComparer.OrdinalIgnoreCase))
            {
                return Content(HttpStatusCode.BadRequest, new
                {
                    message = $"'actionStatus' must be one of: {string.Join(", ", ValidActionStatuses)}."
                });
            }

            var action = (request.Action ?? string.Empty).Trim();
            var actionStatus = request.ActionStatus.Trim();
            var emailDates = ResolveEmailDateValues(request.Date);
            var binding = ResolveBinding(request.ThreadId);

            UpdateReceiptColumn(emailDates, binding, "Action", action);

            if (!UpdateReceiptColumn(emailDates, binding, "Action Status", actionStatus))
            {
                return Content(HttpStatusCode.NotFound, new
                {
                    message = $"Thread {request.ThreadId} has no row in {ReceiptsTable} for {request.Date}."
                });
            }

            return Ok(new ThreadActionStatusResponse
            {
                Date = request.Date,
                ThreadId = request.ThreadId,
                Action = action,
                ActionStatus = actionStatus
            });
        }

        // ── WORKFLOW NODE 4: Instrument Match ────────────────────────

        /// <summary>Values written into the details file's "Instrument Match" column.</summary>
        private const string InstrumentMatchedValue = "Match";
        private const string InstrumentUnmatchedValue = "Unmatch";

        /// <summary>Pipeline node the thread moves to once every instrument is found.</summary>
        private const string BankReconciliationStep = "Bank Reconciliation";

        /// <summary>The "myConnection" connection string from Web.config.</summary>
        private static string PrideConnectionString
        {
            get
            {
                var setting = ConfigurationManager.ConnectionStrings["myConnection"];

                if (setting == null || string.IsNullOrWhiteSpace(setting.ConnectionString))
                {
                    throw new ConfigurationErrorsException(
                        "Web.config is missing the 'myConnection' connection string.");
                }

                return setting.ConnectionString;
            }
        }

        /// <summary>
        /// How long a query against the booking master may run, in seconds.
        ///
        /// ADO.NET defaults to 30, which the booking-master lookups can exceed on a
        /// cold cache even with a sargable predicate — SALES_BOOKING_DETAILS is
        /// large and shared with the rest of the CRM. Raised here so a slow moment
        /// on the server reports a verdict late instead of failing the step, and
        /// overridable in Web.config without a rebuild.
        /// </summary>
        private static int SqlCommandTimeoutSeconds
        {
            get
            {
                int configured;

                return int.TryParse(ConfigurationManager.AppSettings["SqlCommandTimeoutSeconds"], out configured)
                       && configured > 0
                    ? configured
                    : 120;
            }
        }

        /// <summary>Receipt status that undoes a receipt: the money was not taken.</summary>
        private const string CancelledReceiptStatus = "Cancelled";

        /// <summary>[Dublicate Match] in the words the payment card shows.</summary>
        private const string NewEntryStatus = "New Entry";
        private const string DuplicateEntryStatus = "Duplicate Entry";

        /// <summary>
        /// EditType — who last settled a payment's duplicate verdict, and so
        /// whether the reviewer may still move its toggle.
        ///
        /// The pipeline's own verdicts are "Automate": one it read from
        /// SALES_RECEIPT, or one Bank Reconciliation confirmed against the bank
        /// statement. A verdict the reviewer set by hand is "Manual" and stays
        /// theirs to undo, until reconciliation settles the payment for good.
        /// </summary>
        private const string EditTypeAutomate = "Automate";
        private const string EditTypeManual = "Manual";

        /// <summary>Two amounts are the same payment if they agree to the paisa.</summary>
        private const decimal ReceiptAmountTolerance = 0.01m;

        /// <summary>
        /// Sets one column on a single payment row, keyed by its own id.
        ///
        /// UpdateDetailColumn keys on the instrument number, which is right for
        /// the steps that look a payment up by it, but wrong here: the rows this
        /// touches may be missing the instrument number, and two payments on a
        /// thread can carry the same one.
        /// </summary>
        private static bool UpdateDetailColumnById(
            ThreadBinding binding, string emailReceiptsDetailsId, string columnName, string value)
        {
            if (!WritableDetailColumns.Contains(columnName, StringComparer.OrdinalIgnoreCase))
            {
                return false;
            }

            var sql =
                $"UPDATE {binding.DetailsTable} SET {StampedAssignment(columnName, value)} " +
                $"WHERE [Email Receipts Details ID] = @id AND [{binding.ThreadKeyColumn}] = @threadKey";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@value", SqlDbType.NVarChar).Value = (value ?? string.Empty).Trim();
                command.Parameters.Add("@id", SqlDbType.VarChar).Value = (emailReceiptsDetailsId ?? string.Empty).Trim();
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                return command.ExecuteNonQuery() > 0;
            }
        }

        /// <summary>Root folder holding the monthly bank statement workbooks.</summary>
        private static string BankStatementFolderPath
        {
            get
            {
                var configuredPath = ConfigurationManager.AppSettings["BankStatementFolderPath"];

                if (string.IsNullOrWhiteSpace(configuredPath))
                {
                    throw new ConfigurationErrorsException(
                        "Web.config is missing the 'BankStatementFolderPath' appSetting.");
                }

                return configuredPath.StartsWith("~")
                    ? HostingEnvironment.MapPath(configuredPath)
                    : configuredPath;
            }
        }

        /// <summary>
        /// POST api/emailautomation/match-instrument
        /// Body: { "date": "2026-05-13", "threadId": "THR-d48b00bb" }
        ///
        /// Node 4 of the Workflow Pipeline. Walks the thread's payments one by one:
        /// takes the last 4 digits of each payment's account number, opens the
        /// statement workbook whose file name carries those digits (under the month
        /// folder taken from the thread's Email Date, e.g. "MAY_2026"), and looks
        /// for the payment's Instrument Number inside the Description column.
        ///   • found     → the Description cell is filled green and the payment's
        ///     "Instrument Match" cell is set to "Match".
        ///   • not found → "Unmatch".
        /// </summary>
        [HttpPost]
        [Route("match-instrument")]
        public IHttpActionResult MatchInstrument(InstrumentMatchRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var binding = ResolveBinding(request.ThreadId);
            var payments = ReadReceiptDetails(binding);

            if (payments.Count == 0)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"Thread {request.ThreadId} has no payment rows in {binding.DetailsTable}." });
            }

            var emailDates = ResolveEmailDateValues(request.Date);

            var response = new InstrumentMatchResponse
            {
                Date = request.Date,
                ThreadId = request.ThreadId,
                Payments = new List<InstrumentMatchPayment>()
            };

            foreach (var row in payments)
            {
                // Before anything is judged: a row that does not say how the
                // money came in is taken to be an online payment, and the
                // customer details it never carried say so outright rather than
                // sitting blank. Done here so both paths below — and the
                // completeness check inside each — see the filled-in values
                // rather than the blanks.
                ApplyDefaultPaymentMode(binding, row);

                row.CustomerAccountNumber = ApplyNotSuppliedDefault(
                    binding, row.EmailReceiptsDetailsId,
                    "Customer Account Number", row.CustomerAccountNumber);

                row.CustomerBank = ApplyNotSuppliedDefault(
                    binding, row.EmailReceiptsDetailsId,
                    "Customer Bank", row.CustomerBank);

                // A payment whose duplicate verdict is already settled is not
                // asked of SALES_RECEIPT again — not on the first run, where no
                // row is settled and every one is checked, but on every re-run
                // after it. Re-checking one the reviewer turned off by hand would
                // overwrite their reason with the master's answer; re-checking one
                // already found on a receipt asks a question that has been
                // answered. Its row is still checked for completeness.
                response.Payments.Add(
                    IsSettledDuplicate(row)
                        ? KeepStoredDuplicateVerdict(binding, row)
                        : CheckPaymentAgainstReceipts(binding, row));
            }

            response.TotalCount = response.Payments.Count;
            response.MatchedCount = response.Payments.Count(p => p.Matched);
            response.DuplicateCount = response.Payments.Count(
                p => string.Equals(p.DublicateMatch, InstrumentMatchedValue, StringComparison.OrdinalIgnoreCase));
            response.AccountsFilledCount = response.Payments.Count(p => p.CashHeaderAccountFilled);
            response.AllMatched = response.MatchedCount == response.TotalCount;

            // Every payment already on the books leaves the whole money side of
            // the pipeline with nothing to do: Bank Reconciliation only looks at
            // rows whose [Dublicate Match] is "Unmatch", no receipt is raised for
            // a payment that already has one, and there is no receipt number for
            // the bot to confirm. The thread goes to the reply instead.
            response.AllDuplicates = response.TotalCount > 0 && response.DuplicateCount == response.TotalCount;

            // Workflow Status lives on the receipts row, not the payment rows, so
            // this step reaches across to move the thread on. A row still missing
            // a field leaves the thread pending on Instrument Match.
            response.WorkflowStatus = !response.AllMatched
                ? PendingInstrumentMatch
                : (response.AllDuplicates ? PendingEmailResponse : PendingBankReconciliation);

            UpdateReceiptColumn(emailDates, binding, "Workflow Status", response.WorkflowStatus);

            // The payment rows carry a stamp each; the card names one step, so it
            // gets the last of them — see ReadLatestDetailMatchStamp.
            response.MatchDate = ReadLatestDetailMatchStamp(binding, "Instrument Match");

            var filled = response.AccountsFilledCount > 0
                ? $" {response.AccountsFilledCount} Pride account(s) filled in from the receipt."
                : string.Empty;

            if (response.AllMatched && response.AllDuplicates)
            {
                response.NextStep = EmailResponseStep;
                response.Message =
                    $"All {response.TotalCount} payment(s) are already on the books" +
                    $".{filled} Nothing to reconcile and no receipt to raise — " +
                    $"proceeding to {EmailResponseStep} to tell the customer.";
            }
            else if (response.AllMatched)
            {
                response.NextStep = BankReconciliationStep;
                response.Message =
                    $"All {response.TotalCount} payment(s) carry every field a receipt needs" +
                    (response.DuplicateCount > 0 ? $"; {response.DuplicateCount} already on the books" : string.Empty) +
                    $".{filled} Proceeding to {BankReconciliationStep}.";
            }
            else
            {
                response.Message =
                    $"{response.MatchedCount} of {response.TotalCount} payment(s) are complete. " +
                    "The rest are missing a field a receipt needs." + filled;
            }

            return Ok(response);
        }

        /// <summary>
        /// One payment, against SALES_RECEIPT and against itself.
        ///
        /// Two separate questions, and the answers are written to two columns:
        ///
        ///   • Is it already receipted? Looked up by instrument number and amount,
        ///     narrowed by the Pride account when the row carries one. A hit means
        ///     [Dublicate Match] = "Match" — the payment is a duplicate entry — with
        ///     one exception: a Cancelled receipt does not count, since the money
        ///     was never taken.
        ///
        ///   • Is the row complete? Every field a receipt needs has to be there and
        ///     be real, which is what [Instrument Match] now records.
        ///
        /// The lookup also backfills the Pride account: a row that had none, whose
        /// instrument and amount are on a receipt, takes that receipt's BANKHEADER.
        /// </summary>
        private static InstrumentMatchPayment CheckPaymentAgainstReceipts(
            ThreadBinding binding, EmailReceiptDetailRow row)
        {
            var payment = new InstrumentMatchPayment
            {
                EmailReceiptsDetailsId = row.EmailReceiptsDetailsId,
                PaymentNo = row.PaymentNo,
                InstrumentNumber = row.InstrumentNumber,
                Amount = row.Amount,
                CashHeaderAccount = row.CashHeaderAccount,
                MissingFields = new List<string>(),
                Reason = string.Empty,
                ReceiptId = string.Empty,
                ReceiptStatus = string.Empty
            };

            var instrument = (row.InstrumentNumber ?? string.Empty).Trim();
            var bankHeader = (row.CashHeaderAccount ?? string.Empty).Trim();

            decimal amount;
            var hasAmount = BankStatementMatcher.TryParseAmount(row.Amount, out amount);

            // Both keys are needed to ask the question at all. Without them the
            // payment cannot be called a duplicate, so it stays a new entry.
            SalesReceiptHit hit = null;

            if (instrument.Length > 0 && hasAmount)
            {
                hit = FindSalesReceipt(instrument, amount, bankHeader);
            }

            if (hit != null)
            {
                payment.ReceiptId = hit.ReceiptId;
                payment.ReceiptStatus = hit.ReceiptStatus;

                // A row with no Pride account takes the one the receipt settled to.
                if (bankHeader.Length == 0 && hit.BankHeader.Length > 0)
                {
                    payment.CashHeaderAccount = hit.BankHeader;
                    payment.CashHeaderAccountFilled = true;

                    UpdateDetailColumnById(
                        binding, row.EmailReceiptsDetailsId, "CashHeaderAccount", hit.BankHeader);
                }
            }

            // Cancelled means the receipt was undone, so the payment is not on the
            // books after all and has to be treated as new.
            var isDuplicate = hit != null && !hit.IsCancelled;

            payment.DublicateMatch = isDuplicate ? InstrumentMatchedValue : InstrumentUnmatchedValue;
            payment.EntryStatus = isDuplicate ? DuplicateEntryStatus : NewEntryStatus;

            if (hit != null && hit.IsCancelled)
            {
                payment.Reason = $"Receipt {hit.ReceiptId} carries this payment but is Cancelled, so it counts as new.";
            }

            // The completeness check reads the row as it now stands — including a
            // Pride account this call has just filled in. Unless the payment just
            // turned out to be a duplicate: it is already settled and nothing
            // further is ever done with it, so see IsDuplicateEntry for why it is
            // exempt from carrying every field a *new* receipt would need.
            payment.MissingFields = IsDuplicateEntry(payment.DublicateMatch, payment.EntryStatus)
                ? new List<string>()
                : MissingReceiptFields(row, payment.CashHeaderAccount);
            payment.Matched = payment.MissingFields.Count == 0;
            payment.InstrumentMatch = payment.Matched ? InstrumentMatchedValue : InstrumentUnmatchedValue;

            if (!payment.Matched)
            {
                payment.Reason = "Missing or unusable: " + string.Join(", ", payment.MissingFields);
            }

            UpdateDetailColumnById(binding, row.EmailReceiptsDetailsId, "Instrument Match", payment.InstrumentMatch);
            UpdateDetailColumnById(binding, row.EmailReceiptsDetailsId, "Dublicate Match", payment.DublicateMatch);
            UpdateDetailColumnById(binding, row.EmailReceiptsDetailsId, "EntryStatus", payment.EntryStatus);

            // This verdict came from the master, not from a person — which is what
            // locks the toggle on a duplicate the step found for itself.
            payment.EditType = EditTypeAutomate;
            UpdateDetailColumnById(binding, row.EmailReceiptsDetailsId, "EditType", EditTypeAutomate);

            return payment;
        }

        /// <summary>
        /// A payment whose duplicate verdict is left exactly as it stands, with
        /// only the completeness check re-run.
        ///
        /// The counterpart to CheckPaymentAgainstReceipts, for the rows that must
        /// not go back to SALES_RECEIPT: [Dublicate Match] and EntryStatus are
        /// reported as stored and neither is rewritten, so a reviewer's own reason
        /// survives every re-run of the step. [Instrument Match] is still written,
        /// because whether the row carries the fields a receipt needs is a
        /// question about the row itself and can change between runs — that is
        /// what the reviewer is correcting when they use Edit & Save.
        /// </summary>
        private static InstrumentMatchPayment KeepStoredDuplicateVerdict(
            ThreadBinding binding, EmailReceiptDetailRow row)
        {
            var entryStatus = (row.EntryStatus ?? string.Empty).Trim();

            var payment = new InstrumentMatchPayment
            {
                EmailReceiptsDetailsId = row.EmailReceiptsDetailsId,
                PaymentNo = row.PaymentNo,
                InstrumentNumber = row.InstrumentNumber,
                Amount = row.Amount,
                CashHeaderAccount = row.CashHeaderAccount,
                DublicateMatch = (row.DublicateMatch ?? string.Empty).Trim(),
                EntryStatus = entryStatus,
                // Left exactly as stored: a verdict the reviewer set by hand stays
                // "Manual", and so stays theirs to undo.
                EditType = (row.EditType ?? string.Empty).Trim(),
                MissingFields = new List<string>(),
                ReceiptId = string.Empty,
                ReceiptStatus = string.Empty,
                Reason = $"Already settled as \"{entryStatus}\" — not checked against SALES_RECEIPT again."
            };

            // A duplicate entry — found by the system or marked by a reviewer,
            // either way — carries nothing further to check. See IsDuplicateEntry.
            payment.MissingFields = IsDuplicateEntry(payment.DublicateMatch, payment.EntryStatus)
                ? new List<string>()
                : MissingReceiptFields(row, payment.CashHeaderAccount);
            payment.Matched = payment.MissingFields.Count == 0;
            payment.InstrumentMatch = payment.Matched ? InstrumentMatchedValue : InstrumentUnmatchedValue;

            if (!payment.Matched)
            {
                payment.Reason = "Missing or unusable: " + string.Join(", ", payment.MissingFields);
            }

            UpdateDetailColumnById(binding, row.EmailReceiptsDetailsId, "Instrument Match", payment.InstrumentMatch);

            return payment;
        }

        /// <summary>
        /// Re-checks one payment's completeness after a field of it was edited,
        /// and rewrites [Instrument Match] to match.
        ///
        /// The verdict is about the row's own fields, so it goes stale the moment
        /// one of them changes — and the fields are editable from two places: the
        /// correction dialog, and the Pride account dropdown on the card, whose
        /// "Select Pride account" option writes the column empty again. A payment
        /// could therefore read "Match" with no account on it, and the pipeline
        /// would offer to move a thread on that could not be receipted.
        ///
        /// Only rewritten for rows the step has already judged: a blank column
        /// means Instrument Match has never run, and this is not the place to
        /// decide it has.
        /// </summary>
        private static void RefreshInstrumentMatchAfterEdit(ThreadBinding binding, string emailReceiptsDetailsId)
        {
            var row = ReadReceiptDetails(binding)
                .FirstOrDefault(r => string.Equals(
                    (r.EmailReceiptsDetailsId ?? string.Empty).Trim(),
                    (emailReceiptsDetailsId ?? string.Empty).Trim(),
                    StringComparison.OrdinalIgnoreCase));

            if (row == null || (row.InstrumentMatch ?? string.Empty).Trim().Length == 0)
            {
                return;
            }

            // A duplicate entry is exempt from the field check here too — see
            // IsDuplicateEntry — so editing, say, the Pride account dropdown
            // elsewhere on the thread cannot flip this payment's own verdict back
            // to Incomplete.
            var verdict = IsDuplicateEntry(row.DublicateMatch, row.EntryStatus) ||
                          MissingReceiptFields(row, row.CashHeaderAccount).Count == 0
                ? InstrumentMatchedValue
                : InstrumentUnmatchedValue;

            if (!string.Equals((row.InstrumentMatch ?? string.Empty).Trim(), verdict, StringComparison.OrdinalIgnoreCase))
            {
                UpdateDetailColumnById(binding, emailReceiptsDetailsId, "Instrument Match", verdict);
            }
        }

        /// <summary>
        /// The fields a payment must carry before it can be receipted: what the
        /// money was (Amount), how to trace it (Instrument Number) and which
        /// Pride account it settles to.
        ///
        /// The customer's own details — Payment Mode, Customer Bank, Customer
        /// Account Number — are deliberately not among them. They describe where
        /// the money came from rather than what the receipt needs, and none is
        /// worth holding a receipt up for; the three ApplyDefault* helpers
        /// settle them before this check ever runs.
        /// </summary>
        private static List<string> MissingReceiptFields(EmailReceiptDetailRow row, string cashHeaderAccount)
        {
            var missing = new List<string>();

            if (!IsUsableValue(row.InstrumentNumber)) missing.Add("Instrument Number");
            if (!IsUsableValue(row.Amount)) missing.Add("Amount");
            if (!IsUsableValue(cashHeaderAccount)) missing.Add("Pride Account No");

            return missing;
        }

        /// <summary>Written into [Payment Mode] where the extractor found nothing.</summary>
        private const string DefaultPaymentMode = "Online Payment";

        /// <summary>
        /// Written into [Customer Account Number] and [Customer Bank] where the
        /// extractor found nothing — the row says plainly that it was never
        /// supplied, rather than leaving an empty cell that reads as "not looked
        /// at yet".
        /// </summary>
        private const string NotSuppliedValue = "N/A";

        /// <summary>
        /// Fills a blank [Payment Mode] in with the default and writes it back.
        ///
        /// "Blank" is IsBlankValue's definition, so the extractor's stand-ins —
        /// "N/A", "None", "null", "-" — count as nothing said, the same as an
        /// empty cell. Persisted rather than defaulted on read so the card, the
        /// receipt template and every later step all see one value, and the row
        /// stops reading "N/A" the moment Instrument Match has run.
        ///
        /// Mutates the row it is handed as well, so the completeness check and
        /// the response built from it read the value just written rather than
        /// the blank it replaced.
        /// </summary>
        private static void ApplyDefaultPaymentMode(ThreadBinding binding, EmailReceiptDetailRow row)
        {
            if (row == null || !IsBlankValue(row.PaymentMode))
            {
                return;
            }

            row.PaymentMode = DefaultPaymentMode;
            UpdateDetailColumnById(binding, row.EmailReceiptsDetailsId, "Payment Mode", DefaultPaymentMode);
        }

        /// <summary>
        /// Stamps "N/A" onto a customer-supplied cell the extractor never filled
        /// in, so the row states outright that it was not supplied.
        ///
        /// Only genuinely empty cells and the extractor's other stand-ins for
        /// nothing ("None", "null", "-") are rewritten. Anything the customer
        /// actually wrote is left exactly as it came — a masked account number
        /// ("XXXX0852") included: it is partial but real, and now that a receipt
        /// is no longer held up for these fields there is nothing to gain by
        /// throwing it away.
        ///
        /// Returns the value the row should now carry, so the caller can assign
        /// it back — the completeness check and the response built from it then
        /// read the value just written rather than the blank it replaced.
        /// </summary>
        private static string ApplyNotSuppliedDefault(
            ThreadBinding binding, string emailReceiptsDetailsId, string columnName, string current)
        {
            if (!IsBlankValue(current))
            {
                return current;
            }

            // Already the placeholder: re-writing it every run would be an
            // UPDATE that changes nothing.
            if (string.Equals((current ?? string.Empty).Trim(), NotSuppliedValue, StringComparison.OrdinalIgnoreCase))
            {
                return current;
            }

            UpdateDetailColumnById(binding, emailReceiptsDetailsId, columnName, NotSuppliedValue);

            return NotSuppliedValue;
        }

        /// <summary>
        /// A cell that actually says something: not blank, and not one of the
        /// stand-ins the extractor writes where it found nothing.
        /// </summary>
        private static bool IsUsableValue(string value)
        {
            return !IsBlankValue(value);
        }

        /// <summary>One SALES_RECEIPT row that carries a payment.</summary>
        private class SalesReceiptHit
        {
            public string ReceiptId;
            public string ReceiptStatus;
            public string BankHeader;

            public bool IsCancelled
            {
                get
                {
                    return string.Equals(
                        (ReceiptStatus ?? string.Empty).Trim(), CancelledReceiptStatus,
                        StringComparison.OrdinalIgnoreCase);
                }
            }
        }

        /// <summary>
        /// Looks a payment up in SALES_RECEIPT by instrument number and amount,
        /// and by the Pride account too when the row already carries one.
        ///
        /// A live receipt is preferred over a Cancelled one: the same instrument
        /// can appear twice when a receipt was cancelled and raised again, and the
        /// live row is the one that says the payment is on the books.
        /// </summary>
        private static SalesReceiptHit FindSalesReceipt(string instrumentNo, decimal amount, string bankHeader)
        {
            var sql = @"
SELECT TOP 1 RECEIPT_ID, RECEIPT_STATUS, BANKHEADER
FROM   SALES_RECEIPT
WHERE  INSTRUMENT_NO = @instrument
   AND INSTRUMENT_AMOUNT BETWEEN @amountLow AND @amountHigh" +
                (bankHeader.Length > 0 ? " AND BANKHEADER = @bankHeader" : string.Empty) + @"
ORDER BY CASE WHEN RECEIPT_STATUS = @cancelled THEN 1 ELSE 0 END, RECEIPT_ID DESC";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@instrument", SqlDbType.NVarChar, 200).Value = instrumentNo;
                command.Parameters.Add("@amountLow", SqlDbType.Money).Value = amount - ReceiptAmountTolerance;
                command.Parameters.Add("@amountHigh", SqlDbType.Money).Value = amount + ReceiptAmountTolerance;
                command.Parameters.Add("@cancelled", SqlDbType.NVarChar, 500).Value = CancelledReceiptStatus;

                if (bankHeader.Length > 0)
                {
                    command.Parameters.Add("@bankHeader", SqlDbType.NVarChar, 240).Value = bankHeader;
                }

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return null;
                    }

                    return new SalesReceiptHit
                    {
                        ReceiptId = ReadString(reader, "RECEIPT_ID"),
                        ReceiptStatus = ReadString(reader, "RECEIPT_STATUS"),
                        BankHeader = ReadString(reader, "BANKHEADER")
                    };
                }
            }
        }

        /// <summary>
        /// POST api/emailautomation/set-entry-status
        /// Body: { "threadId": "THR-…", "emailReceiptsDetailsId": "5567", "isNewEntry": true }
        ///
        /// The reviewer's own verdict on a payment, from the toggle on its card:
        /// on means a new entry, off means it is already receipted. Writes the two
        /// columns Instrument Match keeps in step — [Dublicate Match] and
        /// EntryStatus — so a hand-set answer reads exactly like a looked-up one,
        /// and Bank Reconciliation picks the payment up or leaves it alone
        /// accordingly.
        /// </summary>
        [HttpPost]
        [Route("set-entry-status")]
        public IHttpActionResult SetEntryStatus(EntryStatusRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            if (string.IsNullOrWhiteSpace(request.EmailReceiptsDetailsId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'emailReceiptsDetailsId' is required." });
            }

            var reason = (request.EntryStatus ?? string.Empty).Trim();

            // Turning a payment ON is not a judgement — it is the reviewer saying
            // the master is wrong and this money still has to be receipted, which
            // is exactly what the step's own "new entry" verdict says. Turning one
            // OFF is a judgement, and the reason they gave is stored in its place.
            var duplicateMatch = request.IsNewEntry ? InstrumentUnmatchedValue : InstrumentMatchedValue;
            var entryStatus = request.IsNewEntry
                ? NewEntryStatus
                : (reason.Length > 0 ? reason : DuplicateEntryStatus);

            var binding = ResolveBinding(request.ThreadId);

            // Read before writing, so the log records what the row actually held
            // rather than what the toggle is assumed to have been showing.
            var previous = ReadDetailVerdict(binding, request.EmailReceiptsDetailsId);

            var written = UpdateDetailColumnById(
                binding, request.EmailReceiptsDetailsId, "Dublicate Match", duplicateMatch);

            UpdateDetailColumnById(
                binding, request.EmailReceiptsDetailsId, "EntryStatus", entryStatus);

            // A person set this, so it is theirs to change back — see EditType.
            UpdateDetailColumnById(
                binding, request.EmailReceiptsDetailsId, "EditType", EditTypeManual);

            if (!written)
            {
                return Content(HttpStatusCode.NotFound, new
                {
                    message = $"No {binding.DetailsTable} row with [Email Receipts Details ID] {request.EmailReceiptsDetailsId} on thread {request.ThreadId}."
                });
            }

            WriteAuditLog(
                request.EmailReceiptsDetailsId, request.ThreadId, "Dublicate Match",
                previous.Key, duplicateMatch, request.UpdatedBy, AuditTypeDetail);

            // The reason the reviewer typed is the new EntryStatus, so logging the
            // column logs the reason — the only place it is kept, and the answer to
            // "why is this payment marked as a duplicate?" months from now.
            if (!string.Equals(previous.Value, entryStatus, StringComparison.OrdinalIgnoreCase))
            {
                WriteAuditLog(
                    request.EmailReceiptsDetailsId, request.ThreadId, "EntryStatus",
                    previous.Value, entryStatus, request.UpdatedBy, AuditTypeDetail);
            }

            return Ok(new EntryStatusResponse
            {
                ThreadId = request.ThreadId,
                EmailReceiptsDetailsId = request.EmailReceiptsDetailsId,
                DublicateMatch = duplicateMatch,
                EntryStatus = entryStatus,
                EditType = EditTypeManual,
                Message = request.IsNewEntry
                    ? "Payment marked as a new entry."
                    : $"Payment marked as a duplicate entry: {entryStatus}"
            });
        }

        /// <summary>
        /// The two verdict columns of one payment row, as they stand:
        /// [Dublicate Match] as the key, EntryStatus as the value.
        ///
        /// Read straight before the toggle rewrites them, so the audit log records
        /// what was actually replaced. Neither column is in EditableDetailColumns —
        /// they are the pipeline's own — so ReadEditableDetailValues cannot serve
        /// this, and widening that whitelist would let a correction dialog write a
        /// verdict.
        /// </summary>
        private static KeyValuePair<string, string> ReadDetailVerdict(
            ThreadBinding binding, string emailReceiptsDetailsId)
        {
            var sql =
                $"SELECT TOP 1 [Dublicate Match], EntryStatus FROM {binding.DetailsTable} " +
                $"WHERE [Email Receipts Details ID] = @id AND [{binding.ThreadKeyColumn}] = @threadKey";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@id", SqlDbType.VarChar).Value = (emailReceiptsDetailsId ?? string.Empty).Trim();
                command.Parameters.Add("@threadKey", SqlDbType.VarChar).Value =
                    binding.ThreadKey ?? string.Empty;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return new KeyValuePair<string, string>(string.Empty, string.Empty);
                    }

                    return new KeyValuePair<string, string>(
                        ReadString(reader, "Dublicate Match"),
                        ReadString(reader, "EntryStatus"));
                }
            }
        }

        // ── WORKFLOW NODE 5: Bank Reconciliation ─────────────────────

        private const string PendingBankReco = "Pending Bank Reconciliation";

        /// <summary>
        /// POST api/emailautomation/reconcile-bank
        /// Body: { "date": "2026-05-13", "threadId": "THR-d48b00bb" }
        ///
        /// Node 5 of the Workflow Pipeline, run after Instrument Match passes. Uses
        /// the same workbook the instrument search used — picked by the last 4 digits
        /// of the payment's account number — but now requires the statement row to
        /// carry the instrument number AND the same amount:
        ///   • found      → the amount cell is filled yellow (the Description cell
        ///     keeps the green from Instrument Match) and "Bank Reco Match" is "Match".
        ///   • found more than once → "Dublicate Match" is "Match", i.e. a duplicate
        ///     entry exists for that instrument and amount.
        /// </summary>
        [HttpPost]
        [Route("reconcile-bank")]
        public IHttpActionResult ReconcileBank(BankReconciliationRequest request)
        {
            if (request == null ||
                !DateTime.TryParseExact(request.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'date' must be in yyyy-MM-dd format." });
            }

            if (string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var binding = ResolveBinding(request.ThreadId);
            var payments = ReadReceiptDetails(binding);

            if (payments.Count == 0)
            {
                return Content(HttpStatusCode.NotFound, new { message = $"Thread {request.ThreadId} has no payment rows in {binding.DetailsTable}." });
            }

            var emailDates = ResolveEmailDateValues(request.Date);

            // The email's own row, read on the parent thread: which month's
            // statement workbook to open comes from the email's [Email Date], and
            // a loan customer thread has no date of its own.
            var receiptRow = ReadReceiptForThread(emailDates, binding.ParentThreadId);
            var emailDate = receiptRow == null ? string.Empty : receiptRow.EmailDate;

            var monthFolderName = BankStatementMatcher.ResolveMonthFolder(BankStatementFolderPath, emailDate);
            var monthFolder = monthFolderName.Length == 0
                ? string.Empty
                : Path.Combine(BankStatementFolderPath, monthFolderName);

            var response = new BankReconciliationResponse
            {
                Date = request.Date,
                ThreadId = request.ThreadId,
                MonthFolder = monthFolderName,
                // Only the payments Instrument Match left as new entries. One
                // already on the books is not reconciled again — its money was
                // matched to a receipt the first time round.
                Payments = payments
                    .Where(IsNewEntry)
                    .Select(p => new BankReconciliationPayment
                    {
                        PaymentNo = p.PaymentNo,
                        InstrumentNumber = p.InstrumentNumber,
                        Amount = p.Amount,
                        CustomerAccountNumber = p.CustomerAccountNumber,
                        // The workbook is picked by the Pride account the payment
                        // settles to, not by the customer's own account: it is the
                        // Pride side of the transfer that the statement is of.
                        AccountLastFour = BankStatementMatcher.LastFourDigits(p.CashHeaderAccount),
                        CashHeaderAccount = p.CashHeaderAccount,
                        MatchedCells = new List<string>(),
                        BankRecoMatch = InstrumentUnmatchedValue,
                        DublicateMatch = (p.DublicateMatch ?? string.Empty).Trim(),
                        StatementFile = string.Empty,
                        SheetName = string.Empty,
                        Reason = string.Empty,
                        BankRecoNote = string.Empty
                    })
                    .ToList()
            };

            if (response.Payments.Count == 0)
            {
                return Content(HttpStatusCode.BadRequest, new
                {
                    message = "Every payment on this thread is already on the books, so there is nothing to reconcile."
                });
            }

            if (monthFolderName.Length == 0)
            {
                foreach (var payment in response.Payments)
                {
                    payment.Reason = $"Email Date \"{emailDate}\" could not be read, so no month folder could be picked.";
                }
            }
            else if (!Directory.Exists(monthFolder))
            {
                foreach (var payment in response.Payments)
                {
                    payment.Reason = $"Statement folder {monthFolderName} does not exist.";
                }
            }
            else
            {
                ReconcilePaymentsAgainstStatements(response.Payments, monthFolder);
            }

            // A payment the search never produced a note for — no folder, no
            // workbook, one that could not be opened — still says why on its card,
            // rather than leaving the reviewer with a bare "not found" and no way
            // to tell whether any statement was looked at at all.
            foreach (var payment in response.Payments)
            {
                if (!payment.Matched && string.IsNullOrEmpty(payment.BankRecoNote))
                {
                    payment.BankRecoNote = BuildBankRecoNote(payment.StatementFile, string.Empty, payment.Reason);
                }
            }

            WriteBankReconciliationResults(binding, response.Payments);

            response.TotalCount = response.Payments.Count;
            response.MatchedCount = response.Payments.Count(p => p.Matched);
            response.DuplicateCount = response.Payments.Count(p => p.DuplicateFound);
            response.AllMatched = response.MatchedCount == response.TotalCount;

            response.WorkflowStatus = response.AllMatched ? PendingEmailResponse : PendingBankReco;

            UpdateReceiptColumn(emailDates, binding, "Workflow Status", response.WorkflowStatus);

            // The latest stamp across the payment rows this run reconciled — the
            // same read Instrument Match makes, see ReadLatestDetailMatchStamp.
            response.MatchDate = ReadLatestDetailMatchStamp(binding, "Bank Reco Match");

            if (response.AllMatched)
            {
                response.NextStep = EmailResponseStep;
                response.Message =
                    $"All {response.TotalCount} payment(s) reconciled against the {monthFolderName} statements" +
                    (response.DuplicateCount > 0 ? $", {response.DuplicateCount} with a duplicate entry" : string.Empty) +
                    $". Proceeding to {EmailResponseStep}.";
            }
            else
            {
                response.Message =
                    $"{response.MatchedCount} of {response.TotalCount} payment(s) reconciled against the " +
                    $"{monthFolderName} statements. The rest are marked Unmatch.";
            }

            return Ok(response);
        }

        /// <summary>
        /// Runs the reconciliation for every payment, grouped by the workbook their
        /// account number points at so each file is opened and saved once.
        /// </summary>
        private static void ReconcilePaymentsAgainstStatements(
            List<BankReconciliationPayment> payments, string monthFolder)
        {
            var searchable = new List<BankReconciliationPayment>();

            foreach (var payment in payments)
            {
                if (string.IsNullOrWhiteSpace(payment.InstrumentNumber))
                {
                    payment.Reason = "This payment has no instrument number.";
                    continue;
                }

                decimal amount;

                if (!BankStatementMatcher.TryParseAmount(payment.Amount, out amount))
                {
                    payment.Reason = $"Amount \"{payment.Amount}\" could not be read.";
                    continue;
                }

                if (payment.AccountLastFour.Length == 0)
                {
                    payment.Reason = $"Pride account \"{payment.CashHeaderAccount}\" has fewer than 4 digits.";
                    continue;
                }

                var statementPaths = BankStatementMatcher.FindStatementFiles(monthFolder, payment.AccountLastFour);

                if (statementPaths.Count == 0)
                {
                    payment.Reason = $"No statement workbook in {Path.GetFileName(monthFolder)} carries \"{payment.AccountLastFour}\".";
                    continue;
                }

                payment.StatementPaths = statementPaths;
                searchable.Add(payment);
            }

            // Grouped by the whole set of workbooks a payment has to be searched
            // against, so payments on the same account are still opened once per
            // file rather than once per payment.
            foreach (var group in searchable.GroupBy(
                p => string.Join("|", p.StatementPaths), StringComparer.OrdinalIgnoreCase))
            {
                var paths = group.First().StatementPaths;
                var pending = group.ToList();

                // Every workbook whose name carries the account's last four, in
                // turn, until each payment is found. Two accounts in a month folder
                // can end in the same four digits, and the row is in exactly one of
                // them — stopping at the first file called a payment Unmatch while
                // its row sat unopened in the second.
                foreach (var path in paths)
                {
                    if (pending.Count == 0)
                    {
                        break;
                    }

                    var fileName = Path.GetFileName(path);

                    Dictionary<string, BankStatementMatcher.ReconcileResult> found;

                    var inputs = pending.Select(p =>
                    {
                        decimal amount;
                        BankStatementMatcher.TryParseAmount(p.Amount, out amount);

                        return new BankStatementMatcher.PaymentToReconcile
                        {
                            InstrumentNumber = p.InstrumentNumber,
                            Amount = amount
                        };
                    });

                    try
                    {
                        found = BankStatementMatcher.ReconcileAndHighlight(
                            path, inputs, group.First().AccountLastFour);
                    }
                    catch (Exception ex)
                    {
                        // A locked or corrupt workbook must not fail the whole
                        // thread — nor the other workbooks this payment could still
                        // be found in, so the rest of the list is still walked.
                        foreach (var payment in pending)
                        {
                            payment.StatementFile = fileName;
                            payment.Reason = $"Could not read {fileName}: {ex.Message}";
                        }

                        continue;
                    }

                    foreach (var payment in pending.ToList())
                    {
                        BankStatementMatcher.ReconcileResult result;

                        if (!found.TryGetValue(payment.InstrumentNumber.Trim(), out result))
                        {
                            continue;
                        }

                        // An Unmatch here is not the answer yet — a workbook further
                        // down the list may still hold the row. What it does settle
                        // is the note: the reviewer is told about the file with the
                        // most recent data, which is the one worth looking at.
                        var better =
                            payment.BankRecoNote.Length == 0 ||
                            IsLaterStatementDate(result.LastValueDate, payment.LastStatementDate);

                        if (better)
                        {
                            payment.StatementFile = fileName;
                            payment.LastStatementDate = result.LastValueDate;
                            payment.SheetName = result.SheetName;

                            if (result.Reason.Length > 0)
                            {
                                payment.Reason = result.Reason;
                            }

                            payment.BankRecoNote =
                                BuildBankRecoNote(fileName, result.LastValueDate, payment.Reason);
                        }

                        if (!result.Matched)
                        {
                            continue; // try the next workbook
                        }

                        payment.Matched = true;
                        payment.DuplicateFound = result.DuplicateFound;
                        payment.MatchCount = result.MatchCount;
                        payment.SheetName = result.SheetName;
                        payment.MatchedCells = result.MatchedCells;
                        payment.StatementFile = fileName;
                        payment.BankRecoMatch = InstrumentMatchedValue;

                        // [Dublicate Match] is Instrument Match's verdict now —
                        // whether SALES_RECEIPT already holds the payment — so this
                        // step reads it and never writes it. Two statement rows
                        // carrying the same instrument and amount are still
                        // reported, as MatchCount.

                        // The note answered "why not found?", which stops being a
                        // question the moment it is found.
                        payment.BankRecoNote = string.Empty;
                        payment.Reason = string.Empty;
                        pending.Remove(payment);
                    }
                }

                // Whatever is still pending was in none of them.
                foreach (var payment in pending)
                {
                    payment.BankRecoMatch = InstrumentUnmatchedValue;
                }
            }

            // A payment that never made it into `searchable` above (no instrument
            // number, no workbook found, one locked or corrupt when opened, ...)
            // gets its note from ReconcileBank's fallback pass, which carries the
            // Reason in the note's third part rather than in place of the file
            // and date.
        }

        /// <summary>
        /// Whether <paramref name="candidate"/> is a later statement date than
        /// <paramref name="current"/>, both as ReadValueDateDisplayText writes them
        /// ("dd-MM-yyyy", or whatever text the cell held).
        ///
        /// Used only to pick which workbook an Unmatch note should name when a
        /// payment was searched in more than one: the one with the most recent data
        /// is the one a reviewer would go and look at. Anything unparseable loses to
        /// anything parseable, and a blank loses to everything.
        /// </summary>
        private static bool IsLaterStatementDate(string candidate, string current)
        {
            DateTime candidateDate;
            DateTime currentDate;

            // The same parser that wrote them, so every layout the statements are
            // exported in reads back here as a date rather than as unparseable
            // text that loses to a blank.
            var candidateParsed = BankStatementMatcher.TryParseStatementDate(candidate, out candidateDate);
            var currentParsed = BankStatementMatcher.TryParseStatementDate(current, out currentDate);

            if (candidateParsed && currentParsed)
            {
                return candidateDate > currentDate;
            }

            return candidateParsed && !currentParsed;
        }

        /// <summary>[Bank Reco Note] is varchar(300); the reason is trimmed to fit.</summary>
        private const int BankRecoNoteMaxLength = 300;

        /// <summary>
        /// Raw facts for an Unmatch payment, not a finished sentence: which workbook
        /// the search looked in, its last record's Value Date, and — only when the
        /// search could not run properly — why. Stored as "file|date" or
        /// "file|date|reason"; the FE owns the wording and layout, so a phrasing
        /// change never needs this side redeployed. Each part is kept free of the
        /// "|" separator so the split on the other side is unambiguous.
        /// </summary>
        private static string BuildBankRecoNote(string statementFile, string lastValueDate, string reason)
        {
            var file = NotePart(statementFile);
            var date = NotePart(lastValueDate);
            var why = NotePart(reason);

            if (file.Length == 0 && why.Length == 0)
            {
                return string.Empty;
            }

            var note = $"{file}|{date}";

            if (why.Length == 0)
            {
                return note;
            }

            var room = BankRecoNoteMaxLength - note.Length - 1;

            if (room <= 0)
            {
                return note;
            }

            return note + "|" + (why.Length > room ? why.Substring(0, room) : why);
        }

        private static string NotePart(string value)
        {
            return (value ?? string.Empty).Replace("|", "/").Replace("\r", " ").Replace("\n", " ").Trim();
        }

        /// <summary>
        /// Writes each payment's reconciliation verdict into the details table's
        /// "Bank Reco Match" column, located by Thread ID + Instrument Number.
        ///
        /// [Dublicate Match] is deliberately not written here any more: whether a
        /// payment is already on the books is Instrument Match's verdict, taken
        /// from SALES_RECEIPT and overridable by the reviewer's own toggle.
        /// </summary>
        private static void WriteBankReconciliationResults(
            ThreadBinding binding, List<BankReconciliationPayment> payments)
        {
            foreach (var payment in payments)
            {
                if (string.IsNullOrWhiteSpace(payment.InstrumentNumber))
                {
                    continue;
                }

                UpdateDetailColumn(binding, payment.InstrumentNumber, "Bank Reco Match", payment.BankRecoMatch);

                // Persisted so the payment card can show it without re-running the
                // step: empty on a match (nothing left to explain), otherwise which
                // workbook came up empty and how current it is — see BankRecoNote.
                UpdateDetailColumn(binding, payment.InstrumentNumber, "Bank Reco Note", payment.BankRecoNote ?? string.Empty);

                // A payment found in the bank statement is settled by the system,
                // however it got here: the reviewer may have marked it a new entry
                // by hand, but the statement has now confirmed it, so the verdict
                // stops being theirs to undo.
                if (payment.Matched)
                {
                    UpdateDetailColumn(binding, payment.InstrumentNumber, "EditType", EditTypeAutomate);
                }
            }
        }

        /// <summary>
        /// Whether a payment is a new entry — one still to be receipted.
        ///
        /// Both columns have to agree: [Dublicate Match] = "Unmatch" AND
        /// EntryStatus = "New Entry". The single definition Bank Reconciliation
        /// reads to decide what it reconciles, so nothing downstream can
        /// disagree about which payments are in play.
        ///
        /// Requiring both is what keeps a reviewer's own verdict out of the rest
        /// of the pipeline: turning a payment off writes "Match" with the reason
        /// they gave in EntryStatus, and from that moment nothing downstream
        /// treats it as a payment still to be receipted.
        /// </summary>
        private static bool IsNewEntry(EmailReceiptDetailRow row)
        {
            return string.Equals(
                       (row.DublicateMatch ?? string.Empty).Trim(),
                       InstrumentUnmatchedValue,
                       StringComparison.OrdinalIgnoreCase)
                   && string.Equals(
                       (row.EntryStatus ?? string.Empty).Trim(),
                       NewEntryStatus,
                       StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// A payment whose duplicate verdict is settled and must not be looked up
        /// in SALES_RECEIPT again: [Dublicate Match] = "Match" with an EntryStatus
        /// that is anything other than "New Entry".
        ///
        /// Two kinds of row land here, and neither has a question left to ask of
        /// the master:
        ///   • one Instrument Match already found on a receipt ("Duplicate Entry"),
        ///   • one the reviewer turned off by hand, whose EntryStatus holds the
        ///     reason they typed.
        ///
        /// A row the step has never seen carries neither column, so it is not
        /// settled and is checked — which is what makes the first run check
        /// everything and a re-run check only what is still open.
        /// </summary>
        private static bool IsSettledDuplicate(EmailReceiptDetailRow row)
        {
            return string.Equals(
                       (row.DublicateMatch ?? string.Empty).Trim(),
                       InstrumentMatchedValue,
                       StringComparison.OrdinalIgnoreCase)
                   && !string.Equals(
                       (row.EntryStatus ?? string.Empty).Trim(),
                       NewEntryStatus,
                       StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// A payment marked "Duplicate Entry": [Dublicate Match] = "Match" and
        /// EntryStatus = "Duplicate Entry" — whether the system found it on a
        /// receipt for itself (EditType = "Automate") or a reviewer marked it that
        /// way by hand (EditType = "Manual"). Either way it is already receipted
        /// and nothing further is ever done with it — it does not go to Bank
        /// Reconciliation, and no Pride account of its own is chosen for it on this
        /// thread. Requiring it to carry every field a *new* receipt would need
        /// (Pride AC No, Payment Mode, Amount, the Instrument Number, Customer
        /// Bank, a full Customer Account Number) therefore checks something nobody
        /// downstream reads, and blocked the pipeline over fields the source data
        /// was never going to have — a masked account number on an old receipt,
        /// say.
        ///
        /// A reviewer's own custom reason — anything other than the literal
        /// "Duplicate Entry" text, e.g. one they typed explaining a refund — is a
        /// different call about the row and still gets the full check.
        /// </summary>
        private static bool IsDuplicateEntry(string dublicateMatch, string entryStatus)
        {
            return string.Equals((dublicateMatch ?? string.Empty).Trim(), InstrumentMatchedValue, StringComparison.OrdinalIgnoreCase)
                   && string.Equals((entryStatus ?? string.Empty).Trim(), DuplicateEntryStatus, StringComparison.OrdinalIgnoreCase);
        }

        // -- Thread replies: what the reviewer wrote back --------------

        /// <summary>The two tables a reply lives in.</summary>
        private const string ReplyTable = "PRIDE_EMAIL_REPLY";
        private const string ReplyAttachmentTable = "PRIDE_EMAIL_REPLY_ATTACHMENT";

        /// <summary>Every reply starts here. See PRIDE_EMAIL_REPLY.sql on why the column exists at all.</summary>
        private const string ReplyStatusSaved = "Saved";

        /// <summary>
        /// Caps on what one reply may carry, enforced here and mirrored in the
        /// compose so the reviewer is told before uploading rather than after.
        ///
        /// The bytes arrive base64 inside the JSON body, so an unbounded request
        /// is an unbounded string in memory -- Web.config's maxRequestLength is
        /// ~2 GB and would not stop it.
        /// </summary>
        private const int ReplyMaxFileBytes = 10 * 1024 * 1024;
        private const int ReplyMaxTotalBytes = 25 * 1024 * 1024;
        private const int ReplyMaxFileCount = 10;

        /// <summary>Matches PRIDE_EMAIL_REPLY.Subject's NVARCHAR(500).</summary>
        private const int ReplyMaxSubjectLength = 500;

        /// <summary>
        /// Root folder replies' attachments are written under, from Web.config.
        ///
        /// Its own setting rather than a corner of AttachmentsFolderPath: that
        /// one is the ingestion pipeline's to write and this one is ours, and a
        /// thread's inbound files should not be mixed in with what was sent back.
        /// </summary>
        private static string ReplyAttachmentsFolderPath
        {
            get
            {
                var configuredPath = ConfigurationManager.AppSettings["ReplyAttachmentsFolderPath"];

                if (string.IsNullOrWhiteSpace(configuredPath))
                {
                    throw new ConfigurationErrorsException(
                        "Web.config is missing the 'ReplyAttachmentsFolderPath' appSetting.");
                }

                return configuredPath.StartsWith("~")
                    ? HostingEnvironment.MapPath(configuredPath)
                    : configuredPath;
            }
        }

        /// <summary>
        /// GET api/emailautomation/thread-replies?threadId=...
        ///
        /// Every reply written on a thread, oldest first, with the files each one
        /// carried. Read when the Alert Response popup opens, so a reviewer can
        /// see what has already been said before saying it again.
        ///
        /// A thread nobody has answered comes back as an empty list rather than a
        /// 404 -- not having replied yet is the normal case, not an error.
        /// </summary>
        [HttpGet]
        [Route("thread-replies")]
        public IHttpActionResult GetThreadReplies(string threadId)
        {
            var thread = (threadId ?? string.Empty).Trim();

            if (thread.Length == 0)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var replies = ReadThreadReplies(thread);

            return Ok(new ThreadRepliesResponse
            {
                ThreadId = thread,
                Replies = replies,
                Message = replies.Count == 0
                    ? $"No replies have been saved against thread {thread}."
                    : $"{replies.Count} repl{(replies.Count == 1 ? "y" : "ies")} saved against thread {thread}."
            });
        }

        /// <summary>
        /// GET api/emailautomation/thread-messages?threadId=...
        ///
        /// Every mail that came in on a thread, from main_email_messages, oldest
        /// first. The Alert Response popup interleaves these with the thread's
        /// replies (thread-replies) by time, so the two directions read as one
        /// conversation: the customer's first mail, our answer, their next mail.
        ///
        /// A thread with no rows comes back as an empty list rather than a 404:
        /// threads ingested before the table existed have none.
        /// </summary>
        [HttpGet]
        [Route("thread-messages")]
        public IHttpActionResult GetThreadMessages(string threadId)
        {
            var thread = (threadId ?? string.Empty).Trim();

            if (thread.Length == 0)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var messages = ReadThreadMessages(thread);

            return Ok(new ThreadMessagesResponse
            {
                ThreadId = thread,
                Messages = messages,
                Message = messages.Count == 0
                    ? $"No messages are recorded against thread {thread}."
                    : $"{messages.Count} message{(messages.Count == 1 ? "" : "s")} recorded against thread {thread}."
            });
        }

        /// <summary>
        /// A thread's incoming mail, oldest first.
        ///
        /// [Received Time] is NVARCHAR, so it is ordered here after parsing rather
        /// than by ORDER BY, which would compare it as text. A value that will not
        /// parse keeps its read order and goes after the ones that did.
        /// </summary>
        private static List<ThreadMessageRow> ReadThreadMessages(string threadId)
        {
            const string sql = @"
SELECT   [ID], [Message Key], [Thread ID], [Received Time], Subject, [Message Text]
FROM     main_email_messages
WHERE    [Thread ID] = @threadId";

            var read = ReadWithDeadlockRetry(() =>
            {
                var rows = new List<KeyValuePair<DateTime?, ThreadMessageRow>>();

                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.NVarChar, 128).Value = threadId;

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            var rawTime = ReadString(reader, "Received Time");
                            DateTime parsed;
                            var hasTime = DateTime.TryParse(rawTime, CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed);

                            rows.Add(new KeyValuePair<DateTime?, ThreadMessageRow>(
                                hasTime ? parsed : (DateTime?)null,
                                new ThreadMessageRow
                                {
                                    Id = ReadString(reader, "ID") + MessageRefSuffix,
                                    Attachments = new List<ThreadReplyAttachmentRow>(),
                                    MessageKey = ReadString(reader, "Message Key"),
                                    ThreadId = ReadString(reader, "Thread ID"),
                                    // "o", as ReadThreadReplies sends Created_On, so both
                                    // sides of the conversation parse the same way.
                                    ReceivedTime = hasTime
                                        ? parsed.ToString("o", CultureInfo.InvariantCulture)
                                        : rawTime,
                                    Subject = ReadString(reader, "Subject"),
                                    MessageText = ReadString(reader, "Message Text")
                                }));
                        }
                    }
                }

                return rows;
            });

            // OrderBy is stable, so unparseable times keep their read order.
            var messages = read
                .OrderBy(r => r.Key.HasValue ? 0 : 1)
                .ThenBy(r => r.Key ?? DateTime.MaxValue)
                .Select(r => r.Value)
                .ToList();

            if (messages.Count > 0)
            {
                AttachMessageFiles(messages);
            }

            return messages;
        }

        /// <summary>
        /// Fills in the Attachments list of every mail in one read: the rows of
        /// PRIDE_EMAIL_REPLY_ATTACHMENT whose Reply_ID is the mail's reference
        /// ("13-M"). The files themselves are under
        /// {ReplyAttachmentsFolderPath}\{Thread ID}\{reference}\.
        /// </summary>
        private static void AttachMessageFiles(List<ThreadMessageRow> messages)
        {
            var byRef = new Dictionary<string, ThreadMessageRow>(StringComparer.OrdinalIgnoreCase);

            foreach (var message in messages)
            {
                byRef[message.Id] = message;
            }

            var names = new List<string>();

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand())
            {
                command.Connection = connection;
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                var i = 0;

                foreach (var reference in byRef.Keys)
                {
                    var name = "@r" + i++;
                    command.Parameters.Add(name, SqlDbType.VarChar, 30).Value = reference;
                    names.Add(name);
                }

                command.CommandText =
                    "SELECT ID, Reply_ID, File_Name, Stored_Name, Extension, Size_Bytes " +
                    $"FROM {ReplyAttachmentTable} WHERE Reply_ID IN ({string.Join(", ", names)}) ORDER BY ID";

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        ThreadMessageRow message;

                        if (!byRef.TryGetValue(ReadString(reader, "Reply_ID"), out message))
                        {
                            continue;
                        }

                        var extension = ReadString(reader, "Extension").ToLowerInvariant();

                        message.Attachments.Add(new ThreadReplyAttachmentRow
                        {
                            Id = Convert.ToInt32(reader["ID"]),
                            FileName = ReadString(reader, "File_Name"),
                            StoredName = ReadString(reader, "Stored_Name"),
                            Extension = extension,
                            SizeBytes = reader["Size_Bytes"] == DBNull.Value ? 0 : Convert.ToInt64(reader["Size_Bytes"]),
                            IsImage = ImageExtensions.Contains(extension)
                        });
                    }
                }
            }
        }

        /// <summary>
        /// POST api/emailautomation/save-thread-reply
        /// Body: { "threadId": "THR-c512a5c5", "ticketId": "TKT-2026-000377",
        ///         "to": ["a@b.com"], "cc": [], "bcc": [], "subject": "Re: ...",
        ///         "body": "...", "attachments": [{ "fileName": "x.pdf", "contentBase64": "..." }] }
        ///
        /// Keeps a reply the reviewer wrote back to the customer, so it can be
        /// shown again the next time the thread is opened.
        ///
        /// Both composes land here, and both write the same two tables. The Alert
        /// Response popup sends a reply typed from scratch, with no subject and no
        /// ticket -- the thread's own subject and its open ticket are read here.
        /// The Email Response popup sends one drafted from a step's template, and
        /// carries both: what it shows in its Subject box is what the customer
        /// reads, and the ticket it was drafted against is the one it must be
        /// filed under even when the same click just closed that ticket.
        ///
        /// It does not send anything. There is no mail transport in this backend,
        /// and inventing one behind a Send button that says nothing about it would
        /// be worse than the button plainly saving. Status carries the lifecycle a
        /// transport would need; every row written here is 'Saved'.
        ///
        /// Returns the thread's whole reply list rather than just the new row, so
        /// the popup repaints from this one call.
        /// </summary>
        [HttpPost]
        [Route("save-thread-reply")]
        public IHttpActionResult SaveThreadReply(ThreadReplyRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.ThreadId))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' is required." });
            }

            var thread = request.ThreadId.Trim();
            var to = CleanAddresses(request.To);

            if (to.Count == 0)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'to' must contain at least one address." });
            }

            if (string.IsNullOrWhiteSpace(request.Body))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'body' is required." });
            }

            var subject = (request.Subject ?? string.Empty).Trim();

            // Refused rather than truncated: Subject is NVARCHAR(500), and a
            // parameter of that size silently drops whatever runs past it -- the
            // reviewer would be shown a saved reply whose subject is not the one
            // they sent under.
            if (subject.Length > ReplyMaxSubjectLength)
            {
                return Content(HttpStatusCode.BadRequest,
                    new { message = $"'subject' must be {ReplyMaxSubjectLength} characters or fewer." });
            }

            List<DecodedReplyAttachment> files;
            string uploadError;

            if (!TryDecodeReplyAttachments(request.Attachments, out files, out uploadError))
            {
                return Content(HttpStatusCode.BadRequest, new { message = uploadError });
            }

            // Only checked when there is something to write. The folder name is
            // the thread id, so it has to pass the same gate a thread's inbound
            // attachments do — but a text-only reply needs no folder at all, and
            // should not be refused because the folder setting is missing.
            if (files.Count > 0 && ReplyThreadFolderOrNull(thread) == null)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'threadId' must be a plain thread id to attach files to." });
            }

            // The receipts row this reply answers. A loan customer thread has none
            // of its own, so both the subject and the link come off its parent.
            var parentThread = ResolveBinding(thread).ParentThreadId;

            var replyId = InsertThreadReply(
                thread,
                // The caller's ticket where it sent one, since it knows which
                // ticket the reply answers; the thread's open one otherwise.
                string.IsNullOrWhiteSpace(request.TicketId) ? ReadOpenTicketId(thread) : request.TicketId.Trim(),
                string.Join("; ", to),
                string.Join("; ", CleanAddresses(request.Cc)),
                string.Join("; ", CleanAddresses(request.Bcc)),
                // Derived from the email, not the row: a loan customer thread has
                // no receipts row of its own to carry a subject, and every
                // customer on one email answers under the same one.
                subject.Length == 0
                    ? DeriveReplySubject(parentThread)
                    : subject,
                request.Body,
                string.IsNullOrWhiteSpace(request.UpdatedBy) ? AuditDefaultUser : request.UpdatedBy.Trim(),
                // Read off the same row the subject comes from, and for the same
                // reason: a loan customer thread has no receipts row of its own,
                // so the link is the parent email's.
                DeriveThreadUrl(parentThread),
                // The compose's From box. Blank from the Alert Response popup,
                // which has no such box -- the column is then left alone.
                request.From);

            if (replyId <= 0)
            {
                return Content(HttpStatusCode.InternalServerError,
                    new { message = "The reply could not be saved. Nothing was written." });
            }

            if (files.Count > 0 && !TrySaveReplyAttachments(thread, replyId, files))
            {
                // A reply that claims files it has not got is worse than no reply:
                // the reviewer would believe the customer had been sent them.
                DeleteThreadReply(replyId);

                return Content(HttpStatusCode.InternalServerError,
                    new { message = "The attachments could not be saved, so the reply was not kept either. Please try again." });
            }

            // The customer's reply has now been answered, so the bell stops
            // asking for attention. Set back to 1 by ingestion when they write again.
            ClearAlertReceived(parentThread);

            return Ok(new ThreadRepliesResponse
            {
                ThreadId = thread,
                Replies = ReadThreadReplies(thread),
                Message = files.Count == 0
                    ? $"Reply saved against thread {thread}."
                    : $"Reply saved against thread {thread} with {files.Count} file{(files.Count == 1 ? "" : "s")}."
            });
        }

        /// <summary>
        /// Sets main_email_receipts.[Alert Received] back to NULL for a thread
        /// once a reply has been saved on it.
        ///
        /// Keyed on the email's thread, not the reply's: a loan customer thread
        /// has no receipts row of its own, and the alert belongs to the email the
        /// customer replied to.
        ///
        /// Best-effort. The reply is already saved by the time this runs, and
        /// failing the whole request over the flag would tell the reviewer their
        /// reply was lost when it was not. A failure is traced instead.
        /// </summary>
        private static void ClearAlertReceived(string threadId)
        {
            if (string.IsNullOrWhiteSpace(threadId))
            {
                return;
            }

            var sql =
                $"UPDATE {ReceiptsTable} SET [Alert Received] = NULL " +
                $"WHERE [{ThreadIdColumn}] = @threadId AND [Alert Received] IS NOT NULL";

            try
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.VarChar, 100).Value = threadId.Trim();

                    connection.Open();
                    command.ExecuteNonQuery();
                }
            }
            catch (SqlException ex)
            {
                System.Diagnostics.Trace.TraceError(
                    $"Could not clear [Alert Received] for thread {threadId}: {ex.Message}");
            }
        }

        /// <summary>
        /// GET api/emailautomation/reply-attachment?replyId=...&amp;fileName=...
        ///
        /// One file back off a saved reply. The same shape as GetThreadAttachment
        /// -- a bare file name only, inline for what a browser can render and a
        /// download for what it cannot, cached because a saved file never changes.
        /// </summary>
        [HttpGet]
        [Route("reply-attachment")]
        public IHttpActionResult GetReplyAttachment(string replyId, string fileName)
        {
            // A reply's own id ("18"), or the reference of a mail that came in ("13-M").
            var reference = (replyId ?? string.Empty).Trim();

            if (reference.Length == 0)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'replyId' is required." });
            }

            var name = (fileName ?? string.Empty).Trim();

            // Path.GetFileName strips any path a caller tried to smuggle in, and
            // the result has to match what was asked for.
            if (name.Length == 0 || !string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'fileName' must be a plain file name." });
            }

            var folder = ReplyReferenceFolderOrNull(reference);
            var path = folder == null ? null : Path.Combine(folder, name);

            if (path == null || !File.Exists(path))
            {
                return Content(HttpStatusCode.NotFound, new { message = $"{name} is not saved against reply {replyId}." });
            }

            var extension = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();

            var result = new System.Net.Http.HttpResponseMessage(HttpStatusCode.OK);

            result.Content = new System.Net.Http.StreamContent(
                new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read));

            result.Content.Headers.ContentType =
                new System.Net.Http.Headers.MediaTypeHeaderValue(ContentTypeFor(extension));

            result.Content.Headers.ContentDisposition =
                new System.Net.Http.Headers.ContentDispositionHeaderValue(
                    IsInlineViewable(extension) ? "inline" : "attachment")
                {
                    FileName = name
                };

            result.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue
            {
                Private = true,
                MaxAge = TimeSpan.FromHours(12)
            };

            return ResponseMessage(result);
        }

        // -- Thread replies: the work behind the three endpoints -------

        /// <summary>One attachment with its bytes already off the wire and checked.</summary>
        private class DecodedReplyAttachment
        {
            public string FileName;
            public byte[] Content;
        }

        /// <summary>Trims, drops blanks and de-duplicates one address row.</summary>
        private static List<string> CleanAddresses(List<string> addresses)
        {
            var cleaned = new List<string>();

            if (addresses == null)
            {
                return cleaned;
            }

            foreach (var address in addresses)
            {
                var trimmed = (address ?? string.Empty).Trim();

                if (trimmed.Length == 0)
                {
                    continue;
                }

                // Case-insensitively, since a mailbox is. The compose de-duplicates
                // too, but a caller is not the compose.
                if (!cleaned.Any(a => string.Equals(a, trimmed, StringComparison.OrdinalIgnoreCase)))
                {
                    cleaned.Add(trimmed);
                }
            }

            return cleaned;
        }

        /// <summary>
        /// The subject a reply goes out under: "Re: " and the thread's own.
        ///
        /// Keyed on Thread ID alone, with no date: the same thread carries the
        /// same subject on every day it appears, so asking the caller for a date
        /// would be asking for something that cannot change the answer.
        /// </summary>
        private static string DeriveReplySubject(string threadId)
        {
            var sql = $"SELECT TOP 1 [Email Subject] FROM {ReceiptsTable} WITH (READUNCOMMITTED) WHERE [Thread ID] = @threadId";

            var subject = ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.VarChar).Value = threadId;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value
                        ? string.Empty
                        : value.ToString().Trim();
                }
            });

            if (subject.Length == 0)
            {
                return string.Empty;
            }

            return subject.StartsWith("Re:", StringComparison.OrdinalIgnoreCase)
                ? subject
                : "Re: " + subject;
        }

        /// <summary>
        /// main_email_receipts.[Email Link] for the thread -- the web address of
        /// the mail being answered -- or '' when the row has none.
        ///
        /// Keyed on Thread ID alone for the same reason the subject is: one
        /// thread is one mail, and it carries the same link on every day it
        /// appears in the table.
        /// </summary>
        private static string DeriveThreadUrl(string threadId)
        {
            if (string.IsNullOrWhiteSpace(threadId))
            {
                return string.Empty;
            }

            var sql = $"SELECT TOP 1 [Email Link] FROM {ReceiptsTable} WITH (READUNCOMMITTED) WHERE [Thread ID] = @threadId";

            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.VarChar).Value = threadId;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value
                        ? string.Empty
                        : value.ToString().Trim();
                }
            });
        }

        /// <summary>
        /// The thread's open ticket, or '' when it has none. Context on the reply
        /// only -- nothing ever finds a reply by it.
        /// </summary>
        private static string ReadOpenTicketId(string threadId)
        {
            const string sql = @"
SELECT TOP 1 Ticket_ID
FROM   PRIDE_TICKET_ACJNOWLEDGEMENT
WHERE  Thread_ID = @threadId
   AND Ticket_Status = 'Open'
ORDER BY ID DESC";

            return ReadWithDeadlockRetry(() =>
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.VarChar, 100).Value = threadId;

                    connection.Open();

                    var value = command.ExecuteScalar();

                    return value == null || value == DBNull.Value
                        ? string.Empty
                        : value.ToString().Trim();
                }
            });
        }

        /// <summary>
        /// Writes the reply row and hands back its id.
        ///
        /// The only place in this controller that reads an identity value back:
        /// the reply id keys both its attachment rows and the folder they are
        /// written to, so unlike the ticket table's it cannot stay write-only.
        /// Created_On is left to the column default, so the timestamp is the
        /// server's -- the same call WriteAuditLog makes with GETDATE().
        ///
        /// Thread_Url is the receipts row's [Email Link] -- the mail this reply
        /// answers, copied onto the reply so a sender reading this table alone
        /// can open the original without joining back to main_email_receipts.
        ///
        /// Sent_From is the mailbox picked in the compose's From box, written
        /// only when there is one: see the statement below on why a blank one is
        /// left out of the INSERT rather than written as NULL.
        /// </summary>
        private static int InsertThreadReply(
            string threadId, string ticketId, string to, string cc, string bcc,
            string subject, string body, string createdBy, string threadUrl, string sentFrom)
        {
            var hasSender = !string.IsNullOrWhiteSpace(sentFrom);

            // Sent_From is named in the statement only when the reviewer chose a
            // mailbox. Naming it with a NULL would suppress whatever default the
            // column carries -- a reply typed after Respond has no From box at
            // all, and must be left as the sender has always written it.
            var sql = $@"
INSERT INTO PRIDE_EMAIL_REPLY (Thread_ID, Ticket_ID, Reply_To, Reply_Cc, Reply_Bcc, Subject, Body, Status, Created_By, Thread_Url{(hasSender ? ", Sent_From" : string.Empty)})
VALUES (@threadId, @ticketId, @to, @cc, @bcc, @subject, @body, @status, @createdBy, @threadUrl{(hasSender ? ", @sentFrom" : string.Empty)});
SELECT CAST(SCOPE_IDENTITY() AS INT);";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                command.Parameters.Add("@threadId", SqlDbType.VarChar, 100).Value = threadId;
                command.Parameters.Add("@ticketId", SqlDbType.VarChar, 30).Value =
                    string.IsNullOrWhiteSpace(ticketId) ? (object)DBNull.Value : ticketId;
                command.Parameters.Add("@to", SqlDbType.NVarChar).Value = to;
                command.Parameters.Add("@cc", SqlDbType.NVarChar).Value =
                    string.IsNullOrWhiteSpace(cc) ? (object)DBNull.Value : cc;
                command.Parameters.Add("@bcc", SqlDbType.NVarChar).Value =
                    string.IsNullOrWhiteSpace(bcc) ? (object)DBNull.Value : bcc;
                command.Parameters.Add("@subject", SqlDbType.NVarChar, 500).Value =
                    string.IsNullOrWhiteSpace(subject) ? (object)DBNull.Value : subject;
                command.Parameters.Add("@body", SqlDbType.NVarChar).Value = body;
                command.Parameters.Add("@status", SqlDbType.VarChar, 20).Value = ReplyStatusSaved;
                command.Parameters.Add("@createdBy", SqlDbType.VarChar, 120).Value = createdBy;
                // NULL rather than '' when the thread has no link: the column then
                // says "this thread has none" instead of "this is its address".
                command.Parameters.Add("@threadUrl", SqlDbType.NVarChar).Value =
                    string.IsNullOrWhiteSpace(threadUrl) ? (object)DBNull.Value : threadUrl;

                if (hasSender)
                {
                    command.Parameters.Add("@sentFrom", SqlDbType.NVarChar, 200).Value = sentFrom.Trim();
                }

                connection.Open();

                var id = command.ExecuteScalar();

                return id == null || id == DBNull.Value ? 0 : Convert.ToInt32(id);
            }
        }

        /// <summary>
        /// Removes a reply and, by the cascade on the attachment table, its file
        /// rows. Only ever called to undo a save whose files would not write.
        /// </summary>
        private static void DeleteThreadReply(int replyId)
        {
            try
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand("DELETE FROM PRIDE_EMAIL_REPLY WHERE ID = @id", connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@id", SqlDbType.Int).Value = replyId;

                    connection.Open();
                    command.ExecuteNonQuery();
                }
            }
            catch (SqlException)
            {
                // The caller is already reporting a failure; a failure to tidy up
                // after it is not something the reviewer can act on.
            }
        }

        /// <summary>
        /// A thread's replies, oldest first, each with its files.
        ///
        /// Two queries rather than a join: a join repeats the whole body -- which
        /// is NVARCHAR(MAX) -- once per attachment, and the second query is a
        /// single indexed read.
        /// </summary>
        private static List<ThreadReplyRow> ReadThreadReplies(string threadId)
        {
            const string sql = @"
SELECT   ID, Thread_ID, Ticket_ID, Reply_To, Reply_Cc, Reply_Bcc, Subject, Body, Status, Created_By, Created_On
FROM     PRIDE_EMAIL_REPLY
WHERE    Thread_ID = @threadId
ORDER BY Created_On ASC, ID ASC";

            var replies = ReadWithDeadlockRetry(() =>
            {
                var rows = new List<ThreadReplyRow>();

                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@threadId", SqlDbType.VarChar, 100).Value = threadId;

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(new ThreadReplyRow
                            {
                                Id = Convert.ToInt32(reader["ID"]),
                                ThreadId = ReadString(reader, "Thread_ID"),
                                TicketId = ReadString(reader, "Ticket_ID"),
                                To = ReadString(reader, "Reply_To"),
                                Cc = ReadString(reader, "Reply_Cc"),
                                Bcc = ReadString(reader, "Reply_Bcc"),
                                Subject = ReadString(reader, "Subject"),
                                Body = ReadString(reader, "Body"),
                                Status = ReadString(reader, "Status"),
                                CreatedBy = ReadString(reader, "Created_By"),
                                CreatedOn = reader["Created_On"] == DBNull.Value
                                    ? string.Empty
                                    : Convert.ToDateTime(reader["Created_On"]).ToString("o", CultureInfo.InvariantCulture),
                                Attachments = new List<ThreadReplyAttachmentRow>()
                            });
                        }
                    }
                }

                return rows;
            });

            if (replies.Count > 0)
            {
                AttachReplyFiles(replies);
            }

            return replies;
        }

        /// <summary>Fills in the Attachments list of every reply in one read.</summary>
        private static void AttachReplyFiles(List<ThreadReplyRow> replies)
        {
            var byId = replies.ToDictionary(r => r.Id);

            var names = new List<string>();

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand())
            {
                command.Connection = connection;
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                var i = 0;

                foreach (var reply in replies)
                {
                    var name = "@r" + i++;
                    command.Parameters.Add(name, SqlDbType.VarChar, 30).Value =
                        reply.Id.ToString(CultureInfo.InvariantCulture);
                    names.Add(name);
                }

                command.CommandText =
                    "SELECT ID, Reply_ID, File_Name, Stored_Name, Extension, Size_Bytes " +
                    $"FROM {ReplyAttachmentTable} WHERE Reply_ID IN ({string.Join(", ", names)}) ORDER BY ID";

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        int replyId;

                        ThreadReplyRow reply;

                        if (!int.TryParse(ReadString(reader, "Reply_ID").Trim(), NumberStyles.Integer,
                                CultureInfo.InvariantCulture, out replyId)
                            || !byId.TryGetValue(replyId, out reply))
                        {
                            continue;
                        }

                        var extension = ReadString(reader, "Extension").ToLowerInvariant();

                        reply.Attachments.Add(new ThreadReplyAttachmentRow
                        {
                            Id = Convert.ToInt32(reader["ID"]),
                            FileName = ReadString(reader, "File_Name"),
                            StoredName = ReadString(reader, "Stored_Name"),
                            Extension = extension,
                            SizeBytes = reader["Size_Bytes"] == DBNull.Value ? 0 : Convert.ToInt64(reader["Size_Bytes"]),
                            IsImage = ImageExtensions.Contains(extension)
                        });
                    }
                }
            }
        }

        /// <summary>
        /// Turns the uploads off the wire into bytes, refusing anything past the
        /// caps.
        ///
        /// Checked before a single row is written: a reply saved and then rejected
        /// for its third file would leave the reviewer to work out which half
        /// happened.
        /// </summary>
        private static bool TryDecodeReplyAttachments(
            List<ThreadReplyAttachmentUpload> uploads,
            out List<DecodedReplyAttachment> decoded,
            out string error)
        {
            decoded = new List<DecodedReplyAttachment>();
            error = null;

            if (uploads == null || uploads.Count == 0)
            {
                return true;
            }

            if (uploads.Count > ReplyMaxFileCount)
            {
                error = $"A reply may carry at most {ReplyMaxFileCount} files.";
                return false;
            }

            long total = 0;

            foreach (var upload in uploads)
            {
                var name = Path.GetFileName((upload?.FileName ?? string.Empty).Trim());

                if (name.Length == 0)
                {
                    error = "Every attachment needs a 'fileName'.";
                    return false;
                }

                var payload = (upload.ContentBase64 ?? string.Empty).Trim();

                // A browser FileReader hands back "data:<type>;base64,<payload>";
                // accepted as-is rather than making the caller strip it.
                var comma = payload.IndexOf(",", StringComparison.Ordinal);

                if (payload.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma > -1)
                {
                    payload = payload.Substring(comma + 1);
                }

                byte[] bytes;

                try
                {
                    bytes = Convert.FromBase64String(payload);
                }
                catch (FormatException)
                {
                    error = $"{name} did not arrive as valid base64.";
                    return false;
                }

                if (bytes.Length == 0)
                {
                    error = $"{name} is empty.";
                    return false;
                }

                if (bytes.Length > ReplyMaxFileBytes)
                {
                    error = $"{name} is larger than the {ReplyMaxFileBytes / (1024 * 1024)} MB limit for one file.";
                    return false;
                }

                total += bytes.Length;

                if (total > ReplyMaxTotalBytes)
                {
                    error = $"The attachments come to more than the {ReplyMaxTotalBytes / (1024 * 1024)} MB limit for one reply.";
                    return false;
                }

                decoded.Add(new DecodedReplyAttachment { FileName = name, Content = bytes });
            }

            return true;
        }

        /// <summary>
        /// Writes the files under the reply's folder and records a row for each.
        ///
        /// False on any failure, and the caller then removes the reply -- half a
        /// reply is not a state worth keeping.
        /// </summary>
        private static bool TrySaveReplyAttachments(
            string threadId, int replyId, List<DecodedReplyAttachment> files)
        {
            var folder = ReplyFolderOrNull(replyId, threadId);

            if (folder == null)
            {
                return false;
            }

            try
            {
                Directory.CreateDirectory(folder);

                var used = new List<string>();

                foreach (var file in files)
                {
                    var storedName = UniqueStoredName(SanitiseFileName(file.FileName), used);
                    used.Add(storedName);

                    File.WriteAllBytes(Path.Combine(folder, storedName), file.Content);

                    InsertReplyAttachment(replyId, file.FileName, storedName, file.Content.Length);
                }

                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (SqlException)
            {
                return false;
            }
        }

        private static void InsertReplyAttachment(
            int replyId, string fileName, string storedName, long sizeBytes)
        {
            const string sql = @"
INSERT INTO PRIDE_EMAIL_REPLY_ATTACHMENT (Reply_ID, File_Name, Stored_Name, Extension, Size_Bytes)
VALUES (@replyId, @fileName, @storedName, @extension, @sizeBytes)";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;

                command.Parameters.Add("@replyId", SqlDbType.VarChar, 30).Value =
                    replyId.ToString(CultureInfo.InvariantCulture);
                command.Parameters.Add("@fileName", SqlDbType.NVarChar, 260).Value = fileName;
                command.Parameters.Add("@storedName", SqlDbType.NVarChar, 260).Value = storedName;
                command.Parameters.Add("@extension", SqlDbType.VarChar, 20).Value =
                    Path.GetExtension(storedName).TrimStart('.').ToLowerInvariant();
                command.Parameters.Add("@sizeBytes", SqlDbType.BigInt).Value = sizeBytes;

                connection.Open();

                ExecuteWithDeadlockRetry(command);
            }
        }

        /// <summary>
        /// The folder one reply's files live in, or null when the thread id will
        /// not make a safe folder name.
        ///
        /// Reads the thread off the reply row when the caller has not got it,
        /// which is what the download endpoint does -- it is given a reply id and
        /// nothing else.
        /// </summary>
        private static string ReplyFolderOrNull(int replyId, string threadId = null)
        {
            var thread = threadId ?? ReadReplyThreadId(replyId);
            var threadFolder = ReplyThreadFolderOrNull(thread);

            if (threadFolder == null || replyId <= 0)
            {
                return null;
            }

            return Path.Combine(threadFolder, replyId.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// The reply-attachments folder for one thread, gated exactly as
        /// ThreadFolderOrNull gates the inbound one: a thread id that is not a
        /// plain name cannot become a path, and even one that passes must still
        /// resolve inside the root.
        /// </summary>
        private static string ReplyThreadFolderOrNull(string threadId)
        {
            var name = (threadId ?? string.Empty).Trim();

            if (name.Length == 0 || !Regex.IsMatch(name, @"^[A-Za-z0-9._-]+$"))
            {
                return null;
            }

            var root = Path.GetFullPath(ReplyAttachmentsFolderPath);
            var folder = Path.GetFullPath(Path.Combine(root, name));

            return folder.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? folder : null;
        }

        /// <summary>
        /// The folder a Reply_ID names, or null when it names none.
        ///
        /// A bare number is a reply written in the app, filed under the thread on
        /// its PRIDE_EMAIL_REPLY row. A number with "-M" after it is a mail that
        /// came in, filed under the thread on its main_email_messages row.
        /// </summary>
        private static string ReplyReferenceFolderOrNull(string reference)
        {
            int id;

            if (!reference.EndsWith(MessageRefSuffix, StringComparison.OrdinalIgnoreCase))
            {
                return int.TryParse(reference, NumberStyles.None, CultureInfo.InvariantCulture, out id)
                    ? ReplyFolderOrNull(id)
                    : null;
            }

            var number = reference.Substring(0, reference.Length - MessageRefSuffix.Length);

            if (!int.TryParse(number, NumberStyles.None, CultureInfo.InvariantCulture, out id) || id <= 0)
            {
                return null;
            }

            var threadFolder = ReplyThreadFolderOrNull(ReadMessageThreadId(id));

            return threadFolder == null
                ? null
                : Path.Combine(threadFolder, id.ToString(CultureInfo.InvariantCulture) + MessageRefSuffix);
        }

        private static string ReadMessageThreadId(int messageId)
        {
            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand("SELECT [Thread ID] FROM main_email_messages WHERE [ID] = @id", connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@id", SqlDbType.Int).Value = messageId;

                connection.Open();

                var value = command.ExecuteScalar();

                return value == null || value == DBNull.Value ? string.Empty : value.ToString().Trim();
            }
        }

        private static string ReadReplyThreadId(int replyId)
        {
            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand("SELECT Thread_ID FROM PRIDE_EMAIL_REPLY WHERE ID = @id", connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@id", SqlDbType.Int).Value = replyId;

                connection.Open();

                var value = command.ExecuteScalar();

                return value == null || value == DBNull.Value ? string.Empty : value.ToString().Trim();
            }
        }

        /// <summary>
        /// Makes a file name safe to write, keeping it recognisable.
        ///
        /// Only the characters a path cannot carry are replaced -- the reviewer
        /// should still see the name they picked in the history, and File_Name
        /// keeps the original in any case.
        /// </summary>
        private static string SanitiseFileName(string fileName)
        {
            var name = Path.GetFileName((fileName ?? string.Empty).Trim());

            foreach (var invalid in Path.GetInvalidFileNameChars())
            {
                name = name.Replace(invalid, '_');
            }

            if (name.Length == 0)
            {
                name = "attachment";
            }

            // Leaves room for the " (2)" a duplicate name picks up below.
            return name.Length > 200 ? name.Substring(name.Length - 200) : name;
        }

        /// <summary>Turns a second "receipt.pdf" on the same reply into "receipt (2).pdf".</summary>
        private static string UniqueStoredName(string storedName, List<string> used)
        {
            if (!used.Any(n => string.Equals(n, storedName, StringComparison.OrdinalIgnoreCase)))
            {
                return storedName;
            }

            var stem = Path.GetFileNameWithoutExtension(storedName);
            var extension = Path.GetExtension(storedName);

            for (var i = 2; i < 1000; i++)
            {
                var candidate = $"{stem} ({i}){extension}";

                if (!used.Any(n => string.Equals(n, candidate, StringComparison.OrdinalIgnoreCase)))
                {
                    return candidate;
                }
            }

            return $"{stem} ({Guid.NewGuid():N}){extension}";
        }

        // ── AUTO-CHECK: the hourly unattended pipeline run ───────────

        /// <summary>
        /// Writes the first step a freshly ticketed thread waits on into
        /// [Workflow Status], [Action] and [Action Status].
        ///
        /// Only a thread whose [Workflow Status] is blank: one that already
        /// progressed under an earlier ticket keeps its place. A system-raised
        /// thread has no Customer Email Match on its pipeline, so it starts at
        /// Email Response. Best-effort per thread — a failed write here must not
        /// fail the ticket acknowledgement it rides on.
        /// </summary>
        private static void SeedPendingStep(List<string> emailDates, List<string> threadIds)
        {
            foreach (var threadId in threadIds)
            {
                try
                {
                    var binding = ResolveBinding(threadId);
                    var row = ReadThreadRow(emailDates, binding);

                    if (row == null || !IsBlankValue(row.WorkflowStatus))
                    {
                        continue;
                    }

                    var firstStatus = LettersOnly(row.Category) == "nonpaymentsystem"
                        ? PendingEmailResponse
                        : PendingCustomerEmailMatch;

                    UpdateReceiptColumns(emailDates, binding, new List<KeyValuePair<string, string>>
                    {
                        new KeyValuePair<string, string>("Workflow Status", firstStatus),
                        new KeyValuePair<string, string>("Action", StepNameOf(firstStatus)),
                        new KeyValuePair<string, string>("Action Status", ActionStatusPending)
                    });
                }
                catch (Exception)
                {
                    // Left blank; the backfill script or the next run fills it.
                }
            }
        }

        /// <summary>The queue: open tickets still waiting on one of the four automatic steps.</summary>
        private const string AutoCheckQueueProcedure = "dbo.usp_GetAutoCheckQueue";

        /// <summary>Written to [Action Status] when a step stops a thread for a reviewer.</summary>
        private const string ActionStatusUserIntervention = "User Intervention";

        /// <summary>Written to [Action Status] when the thread is simply waiting on its next step.</summary>
        private const string ActionStatusPending = "Pending";

        /// <summary>Who ApplyBooking's audit log names when the run fills a row.</summary>
        private const string AutoCheckUser = "Auto Check";

        /// <summary>
        /// How long one call keeps picking threads up. Instrument Match and Bank
        /// Reconciliation open workbooks, so a thread can take several seconds;
        /// stopping here keeps each call well inside IIS's request timeout and
        /// lets the caller loop on "remaining" instead.
        /// </summary>
        private static readonly TimeSpan AutoCheckTimeBudget = TimeSpan.FromSeconds(90);

        /// <summary>1 while a run is in progress, so two schedulers never work the same threads.</summary>
        private static int _autoCheckRunning;

        /// <summary>One row of usp_GetAutoCheckQueue.</summary>
        private sealed class AutoCheckQueueItem
        {
            public string ThreadId { get; set; }
            public string TicketId { get; set; }
            public string EmailDate { get; set; }
        }

        /// <summary>
        /// POST api/emailautomation/auto-check
        /// Body: { "apiKey": "…", "maxThreads": 10, "skipThreadIds": [] }
        ///
        /// Runs the Workflow Pipeline's four automatic checks — Customer Email
        /// Match, Unit Match, Instrument Match, Bank Reconciliation — for every
        /// thread with an Open ticket, the way a reviewer pressing "Move to …"
        /// would, and with the same endpoints: each step below is the action
        /// method the UI calls, so the Match/Unmatch verdicts, their stamps,
        /// [Workflow Status], Status and Remark are written exactly as they are
        /// from the screen. Nothing about a check is decided twice.
        ///
        /// A thread is resumed from its [Workflow Status] and taken as far as it
        /// goes. The first step that needs a reviewer — an unknown sender, more
        /// than one booking to choose from, an unmatched unit, an incomplete or
        /// unreconciled payment — parks it: [Action] names that step and
        /// [Action Status] reads "User Intervention", which also takes it out of
        /// the queue until a reviewer resolves it in the UI. The run then moves
        /// on to the next thread.
        ///
        /// Called every hour by App_Data/Scripts/run_auto_check.ps1 (Windows Task
        /// Scheduler), in batches while "remaining" is above zero.
        /// </summary>
        [HttpPost]
        [Route("auto-check")]
        public IHttpActionResult AutoCheck(AutoCheckRequest request)
        {
            var expectedKey = ConfigurationManager.AppSettings["AutoCheckApiKey"];

            if (string.IsNullOrWhiteSpace(expectedKey) ||
                request == null ||
                !string.Equals((request.ApiKey ?? string.Empty).Trim(), expectedKey.Trim(), StringComparison.Ordinal))
            {
                return Content(HttpStatusCode.Unauthorized, new { message = "Invalid apiKey." });
            }

            if (Interlocked.CompareExchange(ref _autoCheckRunning, 1, 0) != 0)
            {
                return Content(HttpStatusCode.Conflict, new { message = "An auto-check run is already in progress." });
            }

            try
            {
                var maxThreads = request.MaxThreads <= 0 ? 10 : Math.Min(request.MaxThreads, 100);
                var skip = new HashSet<string>(
                    (request.SkipThreadIds ?? new List<string>()).Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()),
                    StringComparer.OrdinalIgnoreCase);

                var queue = ReadAutoCheckQueue()
                    .Where(item => !skip.Contains(item.ThreadId))
                    .ToList();

                var response = new AutoCheckResponse
                {
                    FailedThreadIds = new List<string>(),
                    Results = new List<AutoCheckThreadResult>()
                };

                var started = DateTime.UtcNow;

                foreach (var item in queue)
                {
                    if (response.Processed >= maxThreads || DateTime.UtcNow - started > AutoCheckTimeBudget)
                    {
                        break;
                    }

                    var result = RunAutoCheckForThread(item);

                    response.Processed++;
                    response.Results.Add(result);

                    if (result.ActionStatus == ActionStatusUserIntervention)
                    {
                        response.Parked++;
                    }
                    else if (result.ActionStatus == ActionStatusPending)
                    {
                        response.Advanced++;
                    }
                    else
                    {
                        response.Errors++;
                        response.FailedThreadIds.Add(item.ThreadId);
                    }
                }

                response.Remaining = queue.Count - response.Processed;

                return Ok(response);
            }
            finally
            {
                Interlocked.Exchange(ref _autoCheckRunning, 0);
            }
        }

        /// <summary>
        /// Open tickets whose thread still waits on one of the four automatic
        /// steps and has not been parked for a reviewer — see
        /// App_Data/Scripts/auto_check_queue.sql. Oldest ticket first.
        /// </summary>
        private static List<AutoCheckQueueItem> ReadAutoCheckQueue()
        {
            return ReadWithDeadlockRetry(() =>
            {
                var items = new List<AutoCheckQueueItem>();

                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(AutoCheckQueueProcedure, connection))
                {
                    command.CommandType = CommandType.StoredProcedure;
                    command.CommandTimeout = SqlCommandTimeoutSeconds;

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            items.Add(new AutoCheckQueueItem
                            {
                                ThreadId = ReadString(reader, "Thread_ID").Trim(),
                                TicketId = ReadString(reader, "Ticket_ID").Trim(),
                                EmailDate = ReadString(reader, "EmailDate").Trim()
                            });
                        }
                    }
                }

                return items;
            });
        }

        /// <summary>
        /// Takes one thread as far as the four automatic steps allow and records
        /// where it stopped. Never throws: an error is reported on the result and
        /// nothing is written, so the next hourly run tries the thread again.
        /// </summary>
        private AutoCheckThreadResult RunAutoCheckForThread(AutoCheckQueueItem item)
        {
            var result = new AutoCheckThreadResult
            {
                ThreadId = item.ThreadId,
                TicketId = item.TicketId,
                StepsPassed = new List<string>(),
                ActionStatus = "Error"
            };

            try
            {
                DateTime emailDate;

                if (!TryParseEmailDate(item.EmailDate, out emailDate))
                {
                    result.Message = $"Ticket date \"{item.EmailDate}\" could not be read.";
                    return result;
                }

                var date = emailDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                var emailDates = ResolveEmailDateValues(date);
                var binding = ResolveBinding(item.ThreadId);
                var row = ReadThreadRow(emailDates, binding);

                if (row == null)
                {
                    result.Message = $"No {ReceiptsTable} row for {date}.";
                    return result;
                }

                var status = (row.WorkflowStatus ?? string.Empty).Trim();

                // A system-raised thread has no Customer Email Match on its
                // pipeline — the reply is its only step — so it is pointed there
                // rather than checked against the booking master.
                if (IsBlankValue(status) && LettersOnly(row.Category) == "nonpaymentsystem")
                {
                    status = PendingEmailResponse;
                    UpdateReceiptColumn(emailDates, binding, "Workflow Status", status);
                }

                var step = AutoCheckStepOf(status);
                result.FromStep = step ?? StepNameOf(status);

                string parkedMessage = null;
                string parkedStep = null;

                // Four steps at most; the guard only stops a status that failed
                // to move from looping.
                for (var guard = 0; step != null && guard < 4; guard++)
                {
                    string nextStatus;
                    string message;

                    var passed = RunAutoCheckStep(step, date, emailDates, binding, row, out nextStatus, out message);

                    if (!passed)
                    {
                        // Usually the step itself, but a matched sender with
                        // several bookings waits on Unit Match, where the UI
                        // asks which one.
                        parkedStep = AutoCheckStepOf(nextStatus) ?? step;
                        parkedMessage = message;
                        break;
                    }

                    result.StepsPassed.Add(step);
                    result.Message = message;

                    var nextStep = AutoCheckStepOf(nextStatus);

                    status = nextStatus;

                    if (nextStep == step)
                    {
                        parkedStep = step;
                        parkedMessage = message;
                        break;
                    }

                    step = nextStep;

                    // The next step reads the row as the last one left it.
                    row = ReadThreadRow(emailDates, binding) ?? row;
                }

                var parked = parkedStep != null;
                var stoppedAt = parked ? parkedStep : StepNameOf(status);

                result.StoppedAt = stoppedAt;
                result.ActionStatus = parked ? ActionStatusUserIntervention : ActionStatusPending;
                result.WorkflowStatus = parked ? $"Pending {parkedStep}" : status;

                if (parked)
                {
                    result.Message = parkedMessage;
                }

                UpdateReceiptColumns(emailDates, binding, new List<KeyValuePair<string, string>>
                {
                    new KeyValuePair<string, string>("Action", stoppedAt),
                    new KeyValuePair<string, string>("Action Status", result.ActionStatus)
                });

                return result;
            }
            catch (Exception ex)
            {
                result.ActionStatus = "Error";
                result.Message = ex.Message;
                return result;
            }
        }

        /// <summary>
        /// Runs one step through the same action the UI calls and says whether
        /// the thread may carry on without a reviewer.
        /// </summary>
        /// <param name="nextStatus">[Workflow Status] as the step left it.</param>
        /// <param name="message">The step's own message — why it passed or stopped.</param>
        private bool RunAutoCheckStep(
            string step,
            string date,
            List<string> emailDates,
            ThreadBinding binding,
            EmailReceiptRow row,
            out string nextStatus,
            out string message)
        {
            nextStatus = $"Pending {step}";
            string error;

            switch (step)
            {
                case CustomerEmailMatchStep:
                {
                    var verified = OkContent<CustomerEmailVerificationResponse>(
                        VerifyCustomerEmail(new CustomerEmailVerificationRequest { Date = date, ThreadId = row.ThreadId }),
                        out error);

                    if (verified == null)
                    {
                        message = error;
                        return false;
                    }

                    message = verified.Message;

                    if (!verified.Matched)
                    {
                        return false;
                    }

                    nextStatus = verified.WorkflowStatus;

                    // The UI's rule, made here instead of on screen: one booking
                    // that fits is written onto a row missing its project or unit;
                    // more than one needs a reviewer to say which. Parked on Unit
                    // Match, which is where the UI asks the question.
                    var candidates = verified.Candidates ?? new List<CustomerBookingMatch>();

                    if (candidates.Count > 1)
                    {
                        nextStatus = PendingUnitMatch;
                        message = $"This customer has {candidates.Count} bookings that fit. " +
                                  "Choose the one this payment is for in the Project & Unit card.";
                        return false;
                    }

                    if (candidates.Count == 1 && (IsBlankValue(row.Project) || IsBlankValue(row.Unit)))
                    {
                        ApplyBooking(new BookingSelectionRequest
                        {
                            Date = date,
                            ThreadId = row.ThreadId,
                            EmailReceiptsId = row.EmailReceiptsId,
                            Project = candidates[0].ProjectName ?? string.Empty,
                            SubProject = AutoCheckWingOf(candidates[0]),
                            Unit = AutoCheckUnitNumberOf(candidates[0].UnitNo),
                            UpdatedBy = AutoCheckUser
                        });
                    }

                    return true;
                }

                case UnitMatchStep:
                {
                    var matched = OkContent<UnitMatchResponse>(
                        MatchUnit(new UnitMatchRequest { Date = date, ThreadId = row.ThreadId }),
                        out error);

                    if (matched == null)
                    {
                        message = error;
                        return false;
                    }

                    message = matched.Message;
                    nextStatus = matched.WorkflowStatus;

                    if (!matched.Matched)
                    {
                        return false;
                    }

                    // What the UI's assignOwner() does after a matched unit: the
                    // booking's stage picks the owner, who is written into
                    // [Assigned To] before the thread moves on. Without it an
                    // auto-checked thread would carry no owner at all.
                    string ownerError;
                    var ownerReason = AssignAutoCheckOwner(
                        emailDates, binding, row, matched.Bookings?.FirstOrDefault(), out ownerError);

                    if (ownerReason == null)
                    {
                        // Unit Match is not finished until the thread has an
                        // owner, so it is put back to wait on that step. A
                        // reviewer's Verify re-runs it and assignOwner() settles
                        // the owner on screen.
                        nextStatus = PendingUnitMatch;
                        message = $"Unit matched, but the owner could not be assigned: {ownerError} " +
                                  "Press Verify on Unit Match to assign it.";

                        try
                        {
                            UpdateReceiptColumn(emailDates, binding, "Workflow Status", PendingUnitMatch);
                        }
                        catch (Exception)
                        {
                            // Parked either way; [Action Status] keeps it out of the queue.
                        }

                        return false;
                    }

                    message = $"{matched.Message} {ownerReason}";

                    return true;
                }

                case InstrumentMatchStep:
                {
                    var matched = OkContent<InstrumentMatchResponse>(
                        MatchInstrument(new InstrumentMatchRequest { Date = date, ThreadId = row.ThreadId }),
                        out error);

                    if (matched == null)
                    {
                        message = error;
                        return false;
                    }

                    message = matched.Message;
                    nextStatus = matched.WorkflowStatus;

                    return matched.AllMatched;
                }

                case BankReconciliationStep:
                {
                    var reconciled = OkContent<BankReconciliationResponse>(
                        ReconcileBank(new BankReconciliationRequest { Date = date, ThreadId = row.ThreadId }),
                        out error);

                    if (reconciled == null)
                    {
                        message = error;
                        return false;
                    }

                    message = reconciled.Message;
                    nextStatus = reconciled.WorkflowStatus;

                    return reconciled.AllMatched;
                }

                default:
                    message = $"\"{step}\" is not an automatic step.";
                    return false;
            }
        }

        /// <summary>Pipeline node name for Customer Email Verification, as [Action] spells it.</summary>
        private const string CustomerEmailMatchStep = "Customer Email Match";

        /// <summary>
        /// The automatic step a [Workflow Status] waits on, or null when it waits
        /// on something the run does not do (Email Response, an agreement stage).
        /// A blank status is a thread no step has touched yet.
        /// </summary>
        private static string AutoCheckStepOf(string workflowStatus)
        {
            var status = (workflowStatus ?? string.Empty).Trim();

            if (IsBlankValue(status) || string.Equals(status, PendingCustomerEmailMatch, StringComparison.OrdinalIgnoreCase))
            {
                return CustomerEmailMatchStep;
            }

            if (string.Equals(status, PendingUnitMatch, StringComparison.OrdinalIgnoreCase))
            {
                return UnitMatchStep;
            }

            if (string.Equals(status, PendingInstrumentMatch, StringComparison.OrdinalIgnoreCase))
            {
                return InstrumentMatchStep;
            }

            if (string.Equals(status, PendingBankReconciliation, StringComparison.OrdinalIgnoreCase))
            {
                return BankReconciliationStep;
            }

            return null;
        }

        /// <summary>"Pending Email Response" → "Email Response"; anything else as it stands.</summary>
        private static string StepNameOf(string workflowStatus)
        {
            var status = (workflowStatus ?? string.Empty).Trim();

            return status.StartsWith("Pending ", StringComparison.OrdinalIgnoreCase)
                ? status.Substring("Pending ".Length).Trim()
                : status;
        }

        /// <summary>
        /// The payload of an action's 200, or null with the action's own error
        /// message when it answered anything else — a 404 for a thread with no
        /// payment rows is a reason to park, not an exception.
        /// </summary>
        private static T OkContent<T>(IHttpActionResult actionResult, out string error) where T : class
        {
            error = null;

            var ok = actionResult as System.Web.Http.Results.OkNegotiatedContentResult<T>;

            if (ok != null)
            {
                return ok.Content;
            }

            // Content(status, new { message }) is a NegotiatedContentResult of an
            // anonymous type, so its message is read by name.
            var content = actionResult?.GetType().GetProperty("Content")?.GetValue(actionResult);
            var message = content?.GetType().GetProperty("message")?.GetValue(content) as string;

            error = string.IsNullOrWhiteSpace(message) ? "The step did not return a result." : message;

            return null;
        }

        /// <summary>"A 1603" → "A", else the first word of the sub project — the wing the UI writes.</summary>
        private static string AutoCheckWingOf(CustomerBookingMatch booking)
        {
            var unitNo = (booking.UnitNo ?? string.Empty).Trim();
            var space = unitNo.IndexOf(' ');

            if (space > 0)
            {
                return unitNo.Substring(0, space).Trim();
            }

            return (booking.SubProjectName ?? string.Empty).Trim()
                .Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault() ?? string.Empty;
        }

        /// <summary>"A 1603" → "1603"; a UNIT_NO with no space is written as it stands, as the UI does.</summary>
        private static string AutoCheckUnitNumberOf(string unitNo)
        {
            var value = (unitNo ?? string.Empty).Trim();
            var space = value.IndexOf(' ');

            return space < 0 ? value : value.Substring(space + 1).Trim();
        }

        // ── AUTO-CHECK: thread owner after a matched unit ────────────
        //
        // The same rule the UI runs in assignOwner() → SlotAssignmentService →
        // ProjectAssignmentService, read from the same config.json, so a thread
        // the hourly run matches ends up with the owner a reviewer's Verify
        // would have given it. Each method below names the FE method it mirrors;
        // a change to the rule has to be made on both sides.

        /// <summary>The three slots, in journey order — CRM_SLOTS in app-config.model.ts.</summary>
        private static readonly string[] AutoCheckCrmSlots = { "Pre-Agreement", "Post-Agreement", "Post-Possession" };

        /// <summary>The parts of the UI's config.json the owner rule reads.</summary>
        private sealed class UiOwnerConfig
        {
            public List<UiConfigUser> Users { get; set; }
            public List<UiConfigProjectMapping> ProjectMappings { get; set; }
            public Dictionary<string, List<string>> BookingStatusSlots { get; set; }
            public UiConfigUser FallbackUser { get; set; }
        }

        private sealed class UiConfigUser
        {
            public string Name { get; set; }
            public string EmailId { get; set; }

            /// <summary>"Slot" in the file; Json.NET's case-insensitive match also takes "slot".</summary>
            public string Slot { get; set; }
        }

        private sealed class UiConfigProjectMapping
        {
            public string Company { get; set; }
            public string ProjectName { get; set; }
            public List<string> Users { get; set; }
        }

        /// <summary>One owner decision — SlotAssignmentDecision.</summary>
        private sealed class AutoCheckOwnerDecision
        {
            public string UserName { get; set; }
            public string Slot { get; set; }
            public string Reason { get; set; }
            public List<string> Pool { get; set; }
        }

        /// <summary>
        /// Settles the owner of a matched thread and writes it into [Assigned To].
        /// Returns the line the pipeline card prints for it, or null — with the
        /// reason in <paramref name="error"/> — when the owner could not be settled
        /// or stored.
        /// </summary>
        private static string AssignAutoCheckOwner(
            List<string> emailDates, ThreadBinding binding, EmailReceiptRow row,
            CustomerBookingMatch booking, out string error)
        {
            error = null;

            try
            {
                var config = LoadUiOwnerConfig();
                var decision = ResolveAutoCheckOwner(config, true, booking?.BookingStatusName, row.Project, row.SubProject);
                var name = (decision.UserName ?? string.Empty).Trim();

                if (name.Length == 0)
                {
                    error = "config.json names no owner and no fallbackUser.";
                    return null;
                }

                if (!UpdateReceiptColumn(emailDates, binding, "Assigned To", name))
                {
                    error = $"Thread {row.ThreadId} has no {ReceiptsTable} row to write [Assigned To] on.";
                    return null;
                }

                return AutoCheckAssignmentReason(config, decision);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        /// <summary>
        /// Reads the UI's config.json from the UiConfigJsonPath appSetting. Read on
        /// every call, not cached: the CRM team edits that file on the server, and
        /// an edit should reach the next run the way a browser refresh reaches the UI.
        /// </summary>
        private static UiOwnerConfig LoadUiOwnerConfig()
        {
            var configuredPath = ConfigurationManager.AppSettings["UiConfigJsonPath"];

            if (string.IsNullOrWhiteSpace(configuredPath))
            {
                throw new ConfigurationErrorsException("Web.config is missing the 'UiConfigJsonPath' appSetting.");
            }

            var path = configuredPath.StartsWith("~")
                ? HostingEnvironment.MapPath(configuredPath)
                : configuredPath;

            if (!File.Exists(path))
            {
                throw new FileNotFoundException($"config.json was not found at \"{path}\" (UiConfigJsonPath).");
            }

            var config = Newtonsoft.Json.JsonConvert.DeserializeObject<UiOwnerConfig>(File.ReadAllText(path))
                         ?? new UiOwnerConfig();

            config.Users = config.Users ?? new List<UiConfigUser>();
            config.ProjectMappings = config.ProjectMappings ?? new List<UiConfigProjectMapping>();
            config.BookingStatusSlots = config.BookingStatusSlots ?? new Dictionary<string, List<string>>();

            // ConfigService.fallbackUser's built-in default, for a file without the section.
            config.FallbackUser = config.FallbackUser ?? new UiConfigUser { Name = "CRM_Head" };

            return config;
        }

        /// <summary>SlotAssignmentService.resolve.</summary>
        private static AutoCheckOwnerDecision ResolveAutoCheckOwner(
            UiOwnerConfig config, bool unitMatched, string bookingStatusName, string project, string subProject)
        {
            if (!unitMatched)
            {
                return AutoCheckHeadOwner(config, "unit-unmatched", null, new List<string>());
            }

            var slot = AutoCheckSlotForBookingStatus(config, bookingStatusName);

            if (slot == null)
            {
                return AutoCheckHeadOwner(config, "unknown-status", null, new List<string>());
            }

            // SlotAssignmentService.byMapping
            bool fallback;
            var mapped = AutoCheckProjectUsers(project, subProject, config, out fallback);

            if (fallback)
            {
                return AutoCheckHeadOwner(config, "no-slot-user", slot, new List<string>());
            }

            var inSlot = config.Users
                .Where(user => AutoCheckSlotOf(user) == slot)
                .Select(user => AutoCheckNameKey(user.Name))
                .ToList();

            var eligible = mapped.Where(name => inSlot.Contains(AutoCheckNameKey(name))).ToList();

            if (eligible.Count == 0)
            {
                return AutoCheckHeadOwner(config, "no-slot-user", slot, mapped);
            }

            return new AutoCheckOwnerDecision { UserName = eligible[0], Slot = slot, Reason = "slot-mapping", Pool = mapped };
        }

        /// <summary>SlotAssignmentService.head.</summary>
        private static AutoCheckOwnerDecision AutoCheckHeadOwner(
            UiOwnerConfig config, string reason, string slot, List<string> pool)
        {
            return new AutoCheckOwnerDecision { UserName = config.FallbackUser.Name, Slot = slot, Reason = reason, Pool = pool };
        }

        /// <summary>
        /// ProjectAssignmentService.getAssignment: the users of every mapping whose
        /// project matches and whose wings cover the sub-project (or that lists no
        /// wings), in config.json order and deduped. <paramref name="fallback"/> is
        /// its 'fallback' match level, where the users are the CRM head.
        /// </summary>
        private static List<string> AutoCheckProjectUsers(
            string project, string subProject, UiOwnerConfig config, out bool fallback)
        {
            fallback = true;

            var head = new List<string> { config.FallbackUser.Name };
            var projectKey = AutoCheckNameKey(project);
            var wingKey = AutoCheckNameKey(subProject);

            if (projectKey.Length == 0)
            {
                return head;
            }

            var exact = new List<UiConfigProjectMapping>();

            foreach (var mapping in config.ProjectMappings)
            {
                // ProjectAssignmentService.parsedMappings: walk back over short
                // codes (A, D, A1, B2) as wings; stop at the first real word.
                var tokens = Regex.Split((mapping.ProjectName ?? string.Empty).ToUpperInvariant(), @"[-\s]+")
                    .Where(t => t.Length > 0)
                    .ToList();

                var end = tokens.Count;
                var wings = new List<string>();

                while (end > 1 && Regex.IsMatch(tokens[end - 1], @"^[A-Z]\d?$"))
                {
                    wings.Insert(0, tokens[end - 1]);
                    end--;
                }

                var baseName = string.Join(" ", tokens.Take(end));

                if (baseName == projectKey &&
                    (wings.Count == 0 || (wingKey.Length > 0 && wings.Contains(wingKey))))
                {
                    exact.Add(mapping);
                }
            }

            if (exact.Count == 0)
            {
                return head;
            }

            fallback = false;

            // ProjectAssignmentService.toUsers
            var seen = new HashSet<string>();
            var users = new List<string>();

            foreach (var name in exact.SelectMany(m => m.Users ?? new List<string>()))
            {
                var key = AutoCheckNameKey(name);

                if (key.Length > 0 && seen.Add(key))
                {
                    users.Add(name.Trim());
                }
            }

            return users;
        }

        /// <summary>
        /// ConfigService.slotForBookingStatus: a status line spelt with a spaced
        /// slash ("ALLOTMENT LETTER / LOI") also matches each side of it.
        /// </summary>
        private static string AutoCheckSlotForBookingStatus(UiOwnerConfig config, string status)
        {
            var key = AutoCheckStatusKey(status);

            if (key.Length == 0)
            {
                return null;
            }

            foreach (var slot in AutoCheckCrmSlots)
            {
                List<string> statuses;

                if (!config.BookingStatusSlots.TryGetValue(slot, out statuses) || statuses == null)
                {
                    continue;
                }

                foreach (var line in statuses)
                {
                    var names = new[] { line }.Concat((line ?? string.Empty).Split(new[] { " / " }, StringSplitOptions.None));

                    if (names.Any(name => AutoCheckStatusKey(name) == key))
                    {
                        return slot;
                    }
                }
            }

            return null;
        }

        /// <summary>ConfigService.slotOf.</summary>
        private static string AutoCheckSlotOf(UiConfigUser user)
        {
            var written = AutoCheckStatusKey(user?.Slot);

            return written.Length == 0
                ? null
                : AutoCheckCrmSlots.FirstOrDefault(slot => AutoCheckStatusKey(slot) == written);
        }

        /// <summary>ConfigService.statusKey: upper case, every run of punctuation or space as one space.</summary>
        private static string AutoCheckStatusKey(string value)
        {
            return Regex.Replace((value ?? string.Empty).ToUpperInvariant(), "[^A-Z0-9]+", " ").Trim();
        }

        /// <summary>Names and project keys are compared trimmed and upper-cased, as on the UI side.</summary>
        private static string AutoCheckNameKey(string value)
        {
            return (value ?? string.Empty).Trim().ToUpperInvariant();
        }

        /// <summary>workflow-visualizer.ts assignmentReason, for a run that had the booking.</summary>
        private static string AutoCheckAssignmentReason(UiOwnerConfig config, AutoCheckOwnerDecision decision)
        {
            var head = config.FallbackUser.Name;

            switch (decision.Reason)
            {
                case "unit-unmatched":
                    return $"Unit did not match, so {head} owns this thread.";

                case "slot-mapping":
                    return $"{decision.UserName} is the first {decision.Slot} owner this project maps to.";

                case "no-slot-user":
                    return decision.Pool.Count > 0
                        ? $"None of this project's owners ({string.Join(", ", decision.Pool)}) works the {decision.Slot} stage, so {head} has it."
                        : $"Nobody is set up for the {decision.Slot} stage, so {head} has it.";

                default:
                    return $"User intervention required — the booking status is blank or is not one config.json stages, so {head} holds it. Use Edit & Save to pick the owner.";
            }
        }
    }
}
