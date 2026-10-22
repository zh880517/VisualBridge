using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using NUnit.Framework;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeRuntimeArtifactStoreTests
    {
        [Test]
        public void ComputeDigestUsesUtf8ByteLengthsForNonAsciiDocumentPaths()
        {
            var root = CreateTemporaryRoot();
            try
            {
                var nested = Path.Combine(root, "documents", "文档");
                Directory.CreateDirectory(nested);
                var asciiPath = Path.Combine(root, "documents", "Plain.vbcompiled.json");
                var unicodePath = Path.Combine(nested, "é.vbcompiled.json");
                File.WriteAllText(asciiPath, "{\"kind\":\"ascii\"}", new UTF8Encoding(false));
                File.WriteAllText(unicodePath, "{\"kind\":\"unicode\"}", new UTF8Encoding(false));

                var entries = new SortedDictionary<string, string>(StringComparer.Ordinal)
                {
                    ["documents/Plain.vbcompiled.json"] = HashFile(asciiPath),
                    ["documents/文档/é.vbcompiled.json"] = HashFile(unicodePath),
                };

                Assert.That(
                    VisualBridgeRuntimeArtifactStore.ComputeDigest(root),
                    Is.EqualTo(ManualDigest(entries)));
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void ComputeDigestMatchesManualHashForAsciiDocumentPaths()
        {
            var root = CreateTemporaryRoot();
            try
            {
                var documents = Path.Combine(root, "documents", "nested");
                Directory.CreateDirectory(documents);
                var artifactPath = Path.Combine(documents, "Plain.vbcompiled.json");
                File.WriteAllText(artifactPath, "{\"kind\":\"ascii\"}", new UTF8Encoding(false));

                var entries = new SortedDictionary<string, string>(StringComparer.Ordinal)
                {
                    ["documents/nested/Plain.vbcompiled.json"] = HashFile(artifactPath),
                };

                Assert.That(
                    VisualBridgeRuntimeArtifactStore.ComputeDigest(root),
                    Is.EqualTo(ManualDigest(entries)));
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        private static string CreateTemporaryRoot()
        {
            var root = Path.Combine(Path.GetTempPath(), "visualbridge-artifact-store-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static string ManualDigest(IEnumerable<KeyValuePair<string, string>> entries)
        {
            using (var sha = SHA256.Create())
            {
                foreach (var pair in entries)
                {
                    Transform(sha, pair.Key);
                    Transform(sha, "\n");
                    Transform(sha, pair.Value);
                    Transform(sha, "\n");
                }

                sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                return ToHex(sha.Hash);
            }
        }

        private static void Transform(SHA256 sha, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
        }

        private static string HashFile(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
            {
                return ToHex(sha.ComputeHash(stream));
            }
        }

        private static string ToHex(byte[] hash)
        {
            var builder = new StringBuilder(hash.Length * 2);
            foreach (var value in hash)
            {
                builder.Append(value.ToString("x2"));
            }

            return builder.ToString();
        }
    }
}
