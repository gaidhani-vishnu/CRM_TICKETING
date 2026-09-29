using System;
using System.Configuration;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;

namespace EmailAutomation.Services
{
    /// <summary>
    /// Issues and validates the login session token: a small
    /// base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature),
    /// signed with the "AuthTokenSecret" appSetting.
    ///
    /// Not a JWT library on purpose — Phase 1 has exactly one claim shape
    /// and no need for the extra surface a full JWT stack brings.
    /// ValidateToken is written now, ahead of any caller, so it is ready
    /// for the protected APIs a later phase adds.
    /// </summary>
    public static class AuthTokenService
    {
        private sealed class TokenPayload
        {
            [JsonProperty("uid")]
            public int UserId { get; set; }

            [JsonProperty("usr")]
            public string Username { get; set; }

            [JsonProperty("role")]
            public string Role { get; set; }

            [JsonProperty("exp")]
            public long ExpiresAtUnixSeconds { get; set; }
        }

        private static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /// <summary>
        /// Issues a token for the given identity, valid for "AuthTokenHours"
        /// hours (defaults to 12 if that setting is missing or invalid).
        /// </summary>
        public static void Issue(int userId, string username, string role, out string token, out DateTime expiresAtUtc)
        {
            expiresAtUtc = DateTime.UtcNow.AddHours(ReadTokenHours());

            var payload = new TokenPayload
            {
                UserId = userId,
                Username = username ?? string.Empty,
                Role = role ?? string.Empty,
                ExpiresAtUnixSeconds = ToUnixSeconds(expiresAtUtc)
            };

            var payloadBytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(payload));
            var payloadPart = Base64UrlEncode(payloadBytes);
            var signaturePart = Base64UrlEncode(Sign(payloadBytes));

            token = payloadPart + "." + signaturePart;
        }

        /// <summary>
        /// True — with the claims in the out params — when
        /// <paramref name="token"/> has a valid signature and has not
        /// expired. False, never throws, for anything malformed, tampered
        /// with, or expired.
        /// </summary>
        public static bool ValidateToken(string token, out int userId, out string username, out string role)
        {
            userId = 0;
            username = null;
            role = null;

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

            if (!FixedTimeEquals(signature, Sign(payloadBytes)))
            {
                return false;
            }

            TokenPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<TokenPayload>(Encoding.UTF8.GetString(payloadBytes));
            }
            catch (JsonException)
            {
                return false;
            }

            if (payload == null || ToUnixSeconds(DateTime.UtcNow) >= payload.ExpiresAtUnixSeconds)
            {
                return false;
            }

            userId = payload.UserId;
            username = payload.Username;
            role = payload.Role;

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
            var secret = ConfigurationManager.AppSettings["AuthTokenSecret"];

            if (string.IsNullOrWhiteSpace(secret))
            {
                throw new ConfigurationErrorsException("Web.config is missing the 'AuthTokenSecret' appSetting.");
            }

            return secret;
        }

        private static int ReadTokenHours()
        {
            int hours;
            var setting = ConfigurationManager.AppSettings["AuthTokenHours"];

            return int.TryParse(setting, out hours) && hours > 0 ? hours : 12;
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
