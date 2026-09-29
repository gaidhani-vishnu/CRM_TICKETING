using System;
using System.Security.Cryptography;
using System.Text;

namespace EmailAutomation.Services
{
    /// <summary>
    /// Hashes and verifies login passwords with PBKDF2 (PKCS#5 v2 / RFC 8018),
    /// using HMACSHA256 as the pseudorandom function.
    ///
    /// This project targets .NET Framework 4.6.1, where Rfc2898DeriveBytes
    /// only supports SHA-1 (the HashAlgorithmName overload needs 4.7.2+), so
    /// the PBKDF2 derivation is written out by hand here instead of relying
    /// on that BCL helper. The construction is the standard one: each block
    /// is U1 = HMAC(password, salt || blockIndex), then Ui = HMAC(password,
    /// U(i-1)) for the remaining iterations, XORed together.
    ///
    /// Stored format: "PBKDF2$SHA256$&lt;iterations&gt;$&lt;saltBase64&gt;$&lt;hashBase64&gt;".
    /// </summary>
    public static class PasswordHasher
    {
        private const int Iterations = 100000;
        private const int SaltSize = 16;
        private const int KeySize = 32;
        private const int HashSize = 32; // SHA-256 output size

        /// <summary>Hashes a plaintext password into the storable PBKDF2$SHA256$... format.</summary>
        public static string Hash(string password)
        {
            if (password == null)
            {
                throw new ArgumentNullException("password");
            }

            var salt = new byte[SaltSize];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(salt);
            }

            var key = DeriveKey(password, salt, Iterations, KeySize);

            return string.Format(
                "PBKDF2$SHA256${0}${1}${2}",
                Iterations,
                Convert.ToBase64String(salt),
                Convert.ToBase64String(key));
        }

        /// <summary>
        /// True when <paramref name="password"/> matches the stored hash.
        /// False — never throws — for a null/empty/malformed hash or a
        /// wrong password, so a missing PasswordHash column just fails the
        /// login rather than 500ing.
        /// </summary>
        public static bool Verify(string password, string storedHash)
        {
            if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(storedHash))
            {
                return false;
            }

            var parts = storedHash.Split('$');

            // "PBKDF2", "SHA256", "<iterations>", "<saltB64>", "<hashB64>"
            if (parts.Length != 5 || parts[0] != "PBKDF2" || parts[1] != "SHA256")
            {
                return false;
            }

            int iterations;

            if (!int.TryParse(parts[2], out iterations) || iterations <= 0)
            {
                return false;
            }

            byte[] salt;
            byte[] expected;

            try
            {
                salt = Convert.FromBase64String(parts[3]);
                expected = Convert.FromBase64String(parts[4]);
            }
            catch (FormatException)
            {
                return false;
            }

            var actual = DeriveKey(password, salt, iterations, expected.Length);

            return FixedTimeEquals(actual, expected);
        }

        /// <summary>
        /// PBKDF2 (RFC 8018 section 5.2) with HMACSHA256 as the PRF. Only
        /// ever asked for one block's worth of key here (dkLen == 32 ==
        /// the PRF's own output size), but loops correctly if that changes.
        /// </summary>
        private static byte[] DeriveKey(string password, byte[] salt, int iterations, int dkLen)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(password)))
            {
                var blockCount = (int)Math.Ceiling(dkLen / (double)HashSize);
                var output = new byte[blockCount * HashSize];

                for (var block = 1; block <= blockCount; block++)
                {
                    var u = hmac.ComputeHash(Concat(salt, BlockIndexBytes(block)));
                    var t = (byte[])u.Clone();

                    for (var i = 1; i < iterations; i++)
                    {
                        u = hmac.ComputeHash(u);

                        for (var b = 0; b < t.Length; b++)
                        {
                            t[b] ^= u[b];
                        }
                    }

                    Buffer.BlockCopy(t, 0, output, (block - 1) * HashSize, HashSize);
                }

                if (output.Length == dkLen)
                {
                    return output;
                }

                var trimmed = new byte[dkLen];
                Buffer.BlockCopy(output, 0, trimmed, 0, dkLen);
                return trimmed;
            }
        }

        /// <summary>Big-endian 4-byte encoding of PBKDF2's 1-based block index.</summary>
        private static byte[] BlockIndexBytes(int block)
        {
            return new[]
            {
                (byte)((block >> 24) & 0xFF),
                (byte)((block >> 16) & 0xFF),
                (byte)((block >> 8) & 0xFF),
                (byte)(block & 0xFF)
            };
        }

        private static byte[] Concat(byte[] a, byte[] b)
        {
            var result = new byte[a.Length + b.Length];
            Buffer.BlockCopy(a, 0, result, 0, a.Length);
            Buffer.BlockCopy(b, 0, result, a.Length, b.Length);
            return result;
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
