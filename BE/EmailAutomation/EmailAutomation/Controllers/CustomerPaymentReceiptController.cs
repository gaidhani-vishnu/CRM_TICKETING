using EmailAutomation.Models;
using EmailAutomation.Services;
using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data;
using System.Data.SqlClient;
using System.Net;
using System.Web.Http;
using System.Web.Http.Cors;

namespace EmailAutomation.Controllers
{
    /// <summary>
    /// The Customer Payment Receipt tab: cascading Project → Sub Project → Unit →
    /// Customer lists, all read from the live rows of
    /// SALES_BOOKING_DETAILS, and the hand-off that opens the Customer Payment
    /// Portal on one booking with email verification skipped.
    ///
    /// The hand-off is a short-lived PortalHandoffToken plus a PRIDE_PORTAL_HANDOFF
    /// row (App_Data\Scripts\PRIDE_PORTAL_HANDOFF.sql). The portal backend moves
    /// that row on as the session progresses, and handoff-status reads it back so
    /// the ticketing tab learns the outcome even when the browser has cut the
    /// link between the two tabs.
    /// </summary>
    [EnableCors(origins: "*", headers: "Content-Type, Authorization", methods: "GET, POST, PUT, DELETE")]
    [RoutePrefix("api/customerpaymentreceipt")]
    //[RoutePrefix("customerpaymentreceipt")] // For Publish
    public class CustomerPaymentReceiptController : ApiController
    {
        /// <summary>
        /// Bookings that are still live. A NULL status is not a dead one.
        /// Kept in step with the portal backend's EmailAutomationController and
        /// PRIDE_CUSTOMER_PORTAL_BOOKED_UNITS — a booking the portal would refuse
        /// must not be offered here.
        /// </summary>
        private const string LiveBookingFilter = @"
        (
            BOOKING_STATUS_NAME NOT IN (
                'In Abeyance',
                'Transaction Form',
                'Transaction Form Checked',
                'Transferred',
                'FILE BINDING DONE',
                'Cancelled'
            )
            OR BOOKING_STATUS_NAME IS NULL
        )";

        /// <summary>
        /// "Title First Last", skipping blank parts — the same name the portal
        /// builds in ReadBookedUnit, so a customer picked here reads identically there.
        /// </summary>
        private const string CustomerNameSql = @"
        LTRIM(RTRIM(
            ISNULL(NULLIF(LTRIM(RTRIM(CUST_TITLE)), '') + ' ', '') +
            ISNULL(NULLIF(LTRIM(RTRIM(CUST_FNAME)), '') + ' ', '') +
            ISNULL(LTRIM(RTRIM(LAST_NAME)), '')
        ))";

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

        private static int SqlCommandTimeoutSeconds
        {
            get
            {
                int seconds;
                var setting = ConfigurationManager.AppSettings["SqlCommandTimeoutSeconds"];
                return int.TryParse(setting, out seconds) && seconds > 0 ? seconds : 120;
            }
        }

        // ── Cascading lists ──────────────────────────────────────────

        /// <summary>GET api/customerpaymentreceipt/projects</summary>
        [HttpGet]
        [Route("projects")]
        public IHttpActionResult GetProjects()
        {
            var sql = $@"
                SELECT DISTINCT LTRIM(RTRIM(PROJECT_NAME)) AS Value
                FROM   SALES_BOOKING_DETAILS
                WHERE  NULLIF(LTRIM(RTRIM(PROJECT_NAME)), '') IS NOT NULL
                  AND  {LiveBookingFilter}
                ORDER BY Value";

            return Ok(ReadValues(sql, command => { }));
        }

        /// <summary>GET api/customerpaymentreceipt/subprojects?project=</summary>
        [HttpGet]
        [Route("subprojects")]
        public IHttpActionResult GetSubProjects(string project = null)
        {
            if (string.IsNullOrWhiteSpace(project))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'project' is required." });
            }

            var sql = $@"
                SELECT DISTINCT LTRIM(RTRIM(SUBPROJECT_NAME)) AS Value
                FROM   SALES_BOOKING_DETAILS
                WHERE  PROJECT_NAME = @project
                  AND  NULLIF(LTRIM(RTRIM(SUBPROJECT_NAME)), '') IS NOT NULL
                  AND  {LiveBookingFilter}
                ORDER BY Value";

            return Ok(ReadValues(sql, command => AddText(command, "@project", project)));
        }

        /// <summary>GET api/customerpaymentreceipt/units?project=&amp;subProject=</summary>
        [HttpGet]
        [Route("units")]
        public IHttpActionResult GetUnits(string project = null, string subProject = null)
        {
            if (string.IsNullOrWhiteSpace(project) || string.IsNullOrWhiteSpace(subProject))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'project' and 'subProject' are required." });
            }

            var sql = $@"
                SELECT DISTINCT LTRIM(RTRIM(UNIT_NO)) AS Value
                FROM   SALES_BOOKING_DETAILS
                WHERE  PROJECT_NAME = @project
                  AND  SUBPROJECT_NAME = @subProject
                  AND  NULLIF(LTRIM(RTRIM(UNIT_NO)), '') IS NOT NULL
                  AND  {LiveBookingFilter}
                ORDER BY Value";

            return Ok(ReadValues(sql, command =>
            {
                AddText(command, "@project", project);
                AddText(command, "@subProject", subProject);
            }));
        }

        /// <summary>GET api/customerpaymentreceipt/customers?project=&amp;subProject=&amp;unit=</summary>
        [HttpGet]
        [Route("customers")]
        public IHttpActionResult GetCustomers(string project = null, string subProject = null, string unit = null)
        {
            if (string.IsNullOrWhiteSpace(project) || string.IsNullOrWhiteSpace(subProject) || string.IsNullOrWhiteSpace(unit))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'project', 'subProject' and 'unit' are required." });
            }

            // The booking's key comes back with the name: picking the customer is
            // what settles which booking Create Record opens.
            var sql = $@"
                SELECT DISTINCT ACCOUNT_ITEM_NO, {CustomerNameSql} AS CUSTOMER_NAME
                FROM   SALES_BOOKING_DETAILS
                WHERE  PROJECT_NAME = @project
                  AND  SUBPROJECT_NAME = @subProject
                  AND  UNIT_NO = @unit
                  AND  {LiveBookingFilter}
                ORDER BY CUSTOMER_NAME";

            var customers = new List<ReceiptCustomerOption>();

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                AddText(command, "@project", project);
                AddText(command, "@subProject", subProject);
                AddText(command, "@unit", unit);

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var name = ReadString(reader, "CUSTOMER_NAME");

                        if (name.Length == 0)
                        {
                            continue;
                        }

                        customers.Add(new ReceiptCustomerOption
                        {
                            AccountItemNo = ReadString(reader, "ACCOUNT_ITEM_NO"),
                            CustomerName = name
                        });
                    }
                }
            }

            return Ok(customers);
        }

        // ── Hand-off to the Customer Payment Portal ─────────────────

        /// <summary>
        /// POST api/customerpaymentreceipt/handoff-token
        /// Header: Authorization: Bearer &lt;login token&gt;
        /// Body:   { "accountItemNo": "..." }
        ///
        /// Records a PRIDE_PORTAL_HANDOFF row and signs a token for it. The booking
        /// must be live and carry an email: the portal files the payment, and
        /// sends its acknowledgement, against that address.
        /// </summary>
        [HttpPost]
        [Route("handoff-token")]
        public IHttpActionResult CreateHandoffToken(PortalHandoffTokenRequest request)
        {
            int userId;
            string username;

            if (!TryReadCaller(out userId, out username))
            {
                return Content(HttpStatusCode.Unauthorized, new { message = "Your session has expired. Please sign in again." });
            }

            var accountItemNo = (request?.AccountItemNo ?? string.Empty).Trim();

            if (accountItemNo.Length == 0)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'accountItemNo' is required." });
            }

            var portalUrl = (ConfigurationManager.AppSettings["CustomerPortalUrl"] ?? string.Empty).Trim();

            if (portalUrl.Length == 0)
            {
                return Content(HttpStatusCode.ServiceUnavailable,
                    new { message = "The Customer Payment Portal address is not configured (Web.config 'CustomerPortalUrl')." });
            }

            var sql = $@"
                SELECT TOP (1)
                       COALESCE(NULLIF(LTRIM(RTRIM(EMAIL1)), ''),
                                NULLIF(LTRIM(RTRIM(EMAIL2)), ''),
                                NULLIF(LTRIM(RTRIM(EMAIL3)), '')) AS EMAIL
                FROM   SALES_BOOKING_DETAILS
                WHERE  ACCOUNT_ITEM_NO = @acc
                  AND  {LiveBookingFilter}";

            var handoffId = Guid.NewGuid();
            var expiresAtUtc = PortalHandoffToken.NewExpiry();

            using (var connection = new SqlConnection(PrideConnectionString))
            {
                connection.Open();

                bool found;
                string email = null;

                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@acc", SqlDbType.VarChar, 50).Value = accountItemNo;

                    using (var reader = command.ExecuteReader())
                    {
                        found = reader.Read();

                        if (found)
                        {
                            email = ReadString(reader, "EMAIL");
                        }
                    }
                }

                if (!found)
                {
                    return Content(HttpStatusCode.NotFound,
                        new { message = "This booking is no longer live, so a payment cannot be recorded against it." });
                }

                if (string.IsNullOrWhiteSpace(email))
                {
                    return Content((HttpStatusCode)422,
                        new { message = "This booking has no customer email address on record. Please update the booking before creating a payment record." });
                }

                using (var command = new SqlCommand(@"
                    INSERT INTO PRIDE_PORTAL_HANDOFF
                        (HandoffId, AccountItemNo, IssuedByUserId, IssuedByUsername, ExpiresAt, Status)
                    VALUES
                        (@hid, @acc, @uid, @usr, @exp, 'Issued')", connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@hid", SqlDbType.UniqueIdentifier).Value = handoffId;
                    command.Parameters.Add("@acc", SqlDbType.NVarChar, 50).Value = accountItemNo;
                    command.Parameters.Add("@uid", SqlDbType.Int).Value = userId;
                    command.Parameters.Add("@usr", SqlDbType.NVarChar, 100).Value = (object)username ?? DBNull.Value;
                    command.Parameters.Add("@exp", SqlDbType.DateTime2).Value = expiresAtUtc;
                    command.ExecuteNonQuery();
                }
            }

            var token = PortalHandoffToken.Issue(handoffId, accountItemNo, userId, username, expiresAtUtc);

            // In the #fragment, never the query string: a fragment is not sent to
            // the portal's server, so the token stays out of IIS logs and Referer.
            return Ok(new PortalHandoffTokenResponse
            {
                HandoffId = handoffId,
                Token = token,
                PortalUrl = portalUrl.Split('#')[0] + "#handoff=" + token,
                ExpiresAt = expiresAtUtc
            });
        }

        /// <summary>
        /// GET api/customerpaymentreceipt/handoff-status?id=
        /// Header: Authorization: Bearer &lt;login token&gt;
        ///
        /// Where a hand-off has got to — the ticketing tab's backstop for the
        /// portal's postMessage. Only the user who issued it may read it.
        /// </summary>
        [HttpGet]
        [Route("handoff-status")]
        public IHttpActionResult GetHandoffStatus(Guid? id = null)
        {
            int userId;
            string username;

            if (!TryReadCaller(out userId, out username))
            {
                return Content(HttpStatusCode.Unauthorized, new { message = "Your session has expired. Please sign in again." });
            }

            if (id == null || id.Value == Guid.Empty)
            {
                return Content(HttpStatusCode.BadRequest, new { message = "'id' is required." });
            }

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(@"
                SELECT AccountItemNo, IssuedByUserId, Status, TicketNumber,
                       CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS IsPastExpiry
                FROM   PRIDE_PORTAL_HANDOFF
                WHERE  HandoffId = @hid", connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@hid", SqlDbType.UniqueIdentifier).Value = id.Value;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return Content(HttpStatusCode.NotFound, new { message = "Unknown hand-off." });
                    }

                    if (Convert.ToInt32(reader["IssuedByUserId"]) != userId)
                    {
                        return Content(HttpStatusCode.Forbidden, new { message = "This hand-off belongs to another user." });
                    }

                    var status = ReadString(reader, "Status");
                    var pastExpiry = Convert.ToInt32(reader["IsPastExpiry"]) == 1;

                    string outcome;

                    if (status == "Saved")
                    {
                        outcome = "RECORD_SAVED";
                    }
                    else if (status == "Expired" || pastExpiry)
                    {
                        outcome = "SESSION_EXPIRED";
                    }
                    else
                    {
                        outcome = "PENDING";
                    }

                    return Ok(new PortalHandoffStatusResponse
                    {
                        HandoffId = id.Value,
                        Status = outcome,
                        AccountItemNo = ReadString(reader, "AccountItemNo"),
                        TicketNumber = ReadString(reader, "TicketNumber")
                    });
                }
            }
        }

        // ── Helpers ──────────────────────────────────────────────────

        /// <summary>The signed-in user behind the request's Bearer login token.</summary>
        private bool TryReadCaller(out int userId, out string username)
        {
            userId = 0;
            username = null;

            var header = Request.Headers.Authorization;

            if (header == null ||
                !string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrWhiteSpace(header.Parameter))
            {
                return false;
            }

            string role;
            return AuthTokenService.ValidateToken(header.Parameter.Trim(), out userId, out username, out role);
        }

        private static List<string> ReadValues(string sql, Action<SqlCommand> bind)
        {
            var values = new List<string>();

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                bind(command);

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        values.Add(ReadString(reader, "Value"));
                    }
                }
            }

            return values;
        }

        private static void AddText(SqlCommand command, string name, string value)
        {
            command.Parameters.Add(name, SqlDbType.NVarChar, 500).Value = value.Trim();
        }

        private static string ReadString(IDataRecord reader, string columnName)
        {
            var value = reader[columnName];

            return value == null || value == DBNull.Value ? string.Empty : value.ToString().Trim();
        }
    }
}
