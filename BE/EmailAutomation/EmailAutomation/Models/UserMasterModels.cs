using System;
using Newtonsoft.Json;

namespace EmailAutomation.Models
{
    // ── User Master / login DTOs ──────────────────────────────────

    /// <summary>Body of POST /api/usermaster/login.</summary>
    public class LoginRequest
    {
        [JsonProperty("username")]
        public string Username { get; set; }

        [JsonProperty("password")]
        public string Password { get; set; }
    }

    /// <summary>200 response of a successful login.</summary>
    public class LoginResponse
    {
        [JsonProperty("token")]
        public string Token { get; set; }

        [JsonProperty("expiresAt")]
        public DateTime ExpiresAt { get; set; }

        [JsonProperty("user")]
        public LoginUser User { get; set; }
    }

    /// <summary>
    /// The signed-in user's public identity. Never carries PasswordHash —
    /// this is the shape returned to the browser, not the DB row.
    /// </summary>
    public class LoginUser
    {
        [JsonProperty("userId")]
        public int UserId { get; set; }

        [JsonProperty("username")]
        public string Username { get; set; }

        [JsonProperty("employeeName")]
        public string EmployeeName { get; set; }

        /// <summary>May be null — PRIDE_USER_MASTER.Email is nullable and not every seeded user has one.</summary>
        [JsonProperty("email")]
        public string Email { get; set; }

        [JsonProperty("role")]
        public string Role { get; set; }
    }

    /// <summary>
    /// One active user as GET /api/usermaster/users lists them — what the UI
    /// needs to show a name for an [Assigned To] mailbox. Never carries
    /// PasswordHash.
    /// </summary>
    public class UserDirectoryEntry
    {
        [JsonProperty("username")]
        public string Username { get; set; }

        [JsonProperty("employeeName")]
        public string EmployeeName { get; set; }

        /// <summary>May be null — PRIDE_USER_MASTER.Email is nullable.</summary>
        [JsonProperty("email")]
        public string Email { get; set; }

        [JsonProperty("role")]
        public string Role { get; set; }
    }
}
