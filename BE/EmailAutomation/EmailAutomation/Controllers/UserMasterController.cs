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
    /// Phase 1 login only: authenticates against PRIDE_USER_MASTER /
    /// PRIDE_ROLE_MASTER (see App_Data\Scripts\001_auth_role_user_master.sql)
    /// and issues the session token AuthTokenService signs, plus a read-only
    /// user list for display names. User/role management is a later phase.
    /// </summary>
    [EnableCors(origins: "*", headers: "Content-Type, Authorization", methods: "GET, POST, PUT, DELETE")]
    [RoutePrefix("api/usermaster")]
    //[RoutePrefix("usermaster")]
    public class UserMasterController : ApiController
    {
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

        /// <summary>
        /// POST api/usermaster/login
        /// Body: { "username": "vivek", "password": "Admin@123" }
        ///
        /// Same "Invalid username or password" message whether the username
        /// doesn't exist, has no password set, or the password is wrong —
        /// so a caller can't use this endpoint to enumerate usernames.
        /// </summary>
        [HttpPost]
        [Route("login")]
        public IHttpActionResult Login(LoginRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.Username))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "Username is required." });
            }

            if (string.IsNullOrWhiteSpace(request.Password))
            {
                return Content(HttpStatusCode.BadRequest, new { message = "Password is required." });
            }

            var username = request.Username.Trim();

            try
            {
                int userId;
                string employeeName;
                string email;
                string passwordHash;
                bool isActive;
                string role;

                //if (!TryFindUser(username, out userId, out employeeName, out email, out passwordHash, out isActive, out role) ||
                //    !PasswordHasher.Verify(request.Password, passwordHash))  // For tempory 01-10-26
                if (!TryFindUser(username, request.Password, out userId, out employeeName, out email, out passwordHash, out isActive, out role))
                {
                    return Content(HttpStatusCode.Unauthorized, new { message = "Invalid username or password." });
                }

                if (!isActive)
                {
                    return Content(HttpStatusCode.Forbidden,
                        new { message = "Your account is inactive. Please contact the administrator." });
                }

                StampLastLogin(userId);

                string token;
                DateTime expiresAtUtc;
                AuthTokenService.Issue(userId, username, role, out token, out expiresAtUtc);

                return Ok(new LoginResponse
                {
                    Token = token,
                    ExpiresAt = expiresAtUtc,
                    User = new LoginUser
                    {
                        UserId = userId,
                        Username = username,
                        EmployeeName = employeeName,
                        Email = email,
                        Role = role
                    }
                });
            }
            catch (Exception)
            {
                return Content(HttpStatusCode.InternalServerError,
                    new { message = "Unable to sign in right now. Please try again." });
            }
        }

        /// <summary>
        /// GET api/usermaster/users
        ///
        /// Every active user with their name, mailbox and role — read by the
        /// UI once at startup to show "Namrata" where a ticket's [Assigned To]
        /// holds CRMHEAD@PRIDEWORLDCITY.COM, and to work out which tickets a
        /// Pre_User / Pos_User owns. Never returns PasswordHash.
        /// </summary>
        [HttpGet]
        [Route("users")]
        public IHttpActionResult GetUsers()
        {
            const string sql =
                "SELECT u.Username, u.EmployeeName, u.Email, r.RoleName " +
                "FROM PRIDE_USER_MASTER u " +
                "LEFT JOIN PRIDE_ROLE_MASTER r ON r.RoleID = u.RoleID " +
                "WHERE u.IsActive = 1 " +
                "ORDER BY u.EmployeeName";

            try
            {
                var users = new List<UserDirectoryEntry>();

                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;

                    connection.Open();

                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            users.Add(new UserDirectoryEntry
                            {
                                Username = reader["Username"] as string,
                                EmployeeName = reader["EmployeeName"] as string,
                                Email = reader["Email"] as string,
                                Role = reader["RoleName"] as string
                            });
                        }
                    }
                }

                return Ok(users);
            }
            catch (Exception)
            {
                return Content(HttpStatusCode.InternalServerError,
                    new { message = "Unable to read the user list right now." });
            }
        }

        /// <summary>
        /// Looks up one user by username (case-insensitive via the DB's
        /// default collation). Returns false — with every out param at its
        /// default — when no row matches, which Login treats the same as a
        /// wrong password.
        /// </summary>
        private static bool TryFindUser(
            string username,
            string passwordstring,
            out int userId,
            out string employeeName,
            out string email,
            out string passwordHash,
            out bool isActive,
            out string role)
        {
            userId = 0;
            employeeName = null;
            email = null;
            passwordHash = null;
            isActive = false;
            role = null;

            const string sql =
                //"SELECT TOP 1 u.UserID, u.EmployeeName, u.Email, u.PasswordHash, u.IsActive, r.RoleName " +
                //"FROM PRIDE_USER_MASTER u " +
                //"LEFT JOIN PRIDE_ROLE_MASTER r ON r.RoleID = u.RoleID " +
                //"WHERE u.Username = @username";

                "SELECT TOP 1 u.UserID, u.EmployeeName, u.Email, u.PasswordHash, u.IsActive, r.RoleName " +
                "FROM PRIDE_USER_MASTER u " +
                "LEFT JOIN PRIDE_ROLE_MASTER r ON r.RoleID = u.RoleID " +
                "WHERE u.Username = @username " +
                "AND u.PasswordString COLLATE Latin1_General_100_CS_AS = @passwordstring";

            using (var connection = new SqlConnection(PrideConnectionString))
            using (var command = new SqlCommand(sql, connection))
            {
                command.CommandTimeout = SqlCommandTimeoutSeconds;
                command.Parameters.Add("@username", SqlDbType.NVarChar, 100).Value = username;
                command.Parameters.Add("@passwordstring", SqlDbType.NVarChar, 100).Value = passwordstring;

                connection.Open();

                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return false;
                    }

                    userId = reader.GetInt32(reader.GetOrdinal("UserID"));
                    employeeName = reader["EmployeeName"] as string;
                    email = reader["Email"] as string;
                    passwordHash = reader["PasswordHash"] as string;
                    isActive = reader["IsActive"] != DBNull.Value && (bool)reader["IsActive"];
                    role = reader["RoleName"] as string;

                    return true;
                }
            }
        }

        /// <summary>Best-effort — a failure here should never fail the login itself.</summary>
        private static void StampLastLogin(int userId)
        {
            const string sql = "UPDATE PRIDE_USER_MASTER SET LastLoginDate = GETDATE() WHERE UserID = @userId";

            try
            {
                using (var connection = new SqlConnection(PrideConnectionString))
                using (var command = new SqlCommand(sql, connection))
                {
                    command.CommandTimeout = SqlCommandTimeoutSeconds;
                    command.Parameters.Add("@userId", SqlDbType.Int).Value = userId;

                    connection.Open();
                    command.ExecuteNonQuery();
                }
            }
            catch (Exception)
            {
                // Swallowed on purpose: LastLoginDate is a nicety, not part
                // of the login contract, and must never turn a good login
                // into a 500.
            }
        }
    }
}
