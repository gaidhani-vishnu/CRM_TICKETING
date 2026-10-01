using System;
using System.Configuration;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;

namespace EmailAutomation.Services
{
    /// <summary>
    /// The short-lived token the Email Ticketing system hands the Customer
    /// Payment Portal when staff press "Create Record" on the Customer Payment
    /// Receipt tab. It names one booking (ACCOUNT_ITEM_NO) and one hand-off row
    /// in PRIDE_PORTAL_HANDOFF, and lets the portal skip email verification for
    /// that booking only.
    ///
    /// Same shape as AuthTokenService — base64url(JSON) + "." +
    /// base64url(HMAC-SHA256) — but signed with its own "PortalHandoffSecret",
    /// so a login token can never be replayed as a hand-off token or the other
    /// way round.
    ///
    /// THIS FILE IS KEPT BYTE-FOR-BYTE IDENTICAL in both backends: the ticketing
    /// backend issues, the portal backend validates. Both Web.configs must carry
    /// the same PortalHandoffSecret.
    /// </summary>
    public static class PortalHandoffToken
    {
        public sealed class Claims
        {
            [JsonProperty("hid")]
            public Guid HandoffId { get; set; }

            [JsonProperty("acc")]
            public string AccountItemNo { get; set; }

            [JsonProperty("uid")]
            public int UserId { get; set; }

            [JsonProperty("usr")]
            public string Username { get; set; }

            [JsonProperty("exp")]
            public long ExpiresAtUnixSeconds { get; set; }
        }

        private static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /// <summary>
        /// Issues a token for one booking, valid until <paramref name="expiresAtUtc"/>
        /// (take it from NewExpiry, so both the token and its PRIDE_PORTAL_HANDOFF row agree).
        /// </summary>
        public static string Issue(Guid handoffId, string accountItemNo, int userId, string username, DateTime expiresAtUtc)
        {
            var claims = new Claims
            {
                HandoffId = handoffId,
                AccountItemNo = accountItemNo ?? string.Empty,
                UserId = userId,
                Username = username ?? string.Empty,
                ExpiresAtUnixSeconds = ToUnixSeconds(expiresAtUtc)
            };

            var payloadBytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(claims));

            return Base64UrlEncode(payloadBytes) + "." + Base64UrlEncode(Sign(payloadBytes));
        }

        /// <summary>When a token issued now should stop working: "PortalHandoffMinutes" from now, 15 if unset.</summary>
        public static DateTime NewExpiry()
        {
            int minutes;
            var setting = ConfigurationManager.AppSettings["PortalHandoffMinutes"];

            return DateTime.UtcNow.AddMinutes(int.TryParse(setting, out minutes) && minutes > 0 ? minutes : 15);
        }

        /// <summary>
        /// True — with the claims — when the token has a valid signature and has
        /// not expired. False, never throws, for anything malformed, tampered
        /// with, or expired.
        /// </summary>
        public static bool Validate(string token, out Claims claims)
        {
            return TryRead(token, false, out claims);
        }

        /// <summary>
        /// Like Validate, but accepts an expired token. Only for closing out a
        /// hand-off that timed out — never for granting access.
        /// </summary>
        public static bool ValidateSignatureOnly(string token, out Claims claims)
        {
            return TryRead(token, true, out claims);
        }

        private static bool TryRead(string token, bool allowExpired, out Claims claims)
        {
            claims = null;

            if (string.IsNullOrEmpty(token))
            {
                return false;
            }

            var dot = token.IndexOf('.');

            if (dot <= 0 || dot == token.Length - 1)
            {
                return false;
            }

            byte[] payloadBytes;
            byte[] signature;

            try
            {
                payloadBytes = Base64UrlDecode(token.Substring(0, dot));
                signature = Base64UrlDecode(token.Substring(dot + 1));
            }
            catch (FormatException)
            {
                return false;
            }

            byte[] expected;

            try
            {
                expected = Sign(payloadBytes);
            }
            catch (ConfigurationErrorsException)
            {
                // No secret configured: nothing can be verified, so nothing is accepted.
                return false;
            }

            if (!FixedTimeEquals(signature, expected))
            {
                return false;
            }

            Claims payload;

            try
            {
                payload = JsonConvert.DeserializeObject<Claims>(Encoding.UTF8.GetString(payloadBytes));
            }
            catch (JsonException)
            {
                return false;
            }

            if (payload == null || payload.HandoffId == Guid.Empty || string.IsNullOrWhiteSpace(payload.AccountItemNo))
            {
                return false;
            }

            if (!allowExpired && ToUnixSeconds(DateTime.UtcNow) >= payload.ExpiresAtUnixSeconds)
            {
                return false;
            }

            claims = payload;
            return true;
        }

        private static byte[] Sign(byte[] payloadBytes)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(ReadSecret())))
            {
                return hmac.ComputeHash(payloadBytes);
            }
        }

        private static string ReadSecret()
        {
            var secret = ConfigurationManager.AppSettings["PortalHandoffSecret"];

            if (string.IsNullOrWhiteSpace(secret))
            {
                throw new ConfigurationErrorsException("Web.config is missing the 'PortalHandoffSecret' appSetting.");
            }

            return secret;
        }

        private static long ToUnixSeconds(DateTime utc)
        {
            return (long)(utc - UnixEpoch).TotalSeconds;
        }

        private static string Base64UrlEncode(byte[] bytes)
        {
            return Convert.ToBase64String(bytes)
                .Replace('+', '-')
                .Replace('/', '_')
                .TrimEnd('=');
        }

        private static byte[] Base64UrlDecode(string value)
        {
            var padded = value.Replace('-', '+').Replace('_', '/');

            switch (padded.Length % 4)
            {
                case 2: padded += "=="; break;
                case 3: padded += "="; break;
            }

            return Convert.FromBase64String(padded);
        }

        /// <summary>Constant-time byte comparison, so a mismatch never leaks timing.</summary>
        private static bool FixedTimeEquals(byte[] a, byte[] b)
        {
            if (a.Length != b.Length)
            {
                return false;
            }

            var diff = 0;
            for (var i = 0; i < a.Length; i++)
            {
                diff |= a[i] ^ b[i];
            }

            return diff == 0;
        }
    }
}
