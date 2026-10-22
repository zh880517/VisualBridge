using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeStructuredCatalogExporter
    {
        internal static string MakeRelativePath(string directory, string path)
        {
            var baseUri = new Uri(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar);
            var pathUri = new Uri(Path.GetFullPath(path));
            return Uri.UnescapeDataString(baseUri.MakeRelativeUri(pathUri).ToString()).Replace('\\', '/');
        }

        internal static JToken Canonicalize(JToken value)
        {
            if (value is JObject objectValue)
            {
                var result = new JObject();
                foreach (var property in objectValue.Properties().OrderBy(property => property.Name, StringComparer.Ordinal))
                {
                    result[property.Name] = Canonicalize(property.Value);
                }

                return result;
            }

            if (value is JArray array)
            {
                return new JArray(array.Select(Canonicalize));
            }

            return value.DeepClone();
        }

        private static IEnumerable<JToken> EnumerateTokens(JToken token)
        {
            yield return token;
            if (token is JContainer container)
            {
                foreach (var child in container.Children())
                {
                    foreach (var descendant in EnumerateTokens(child))
                    {
                        yield return descendant;
                    }
                }
            }
        }

        private static bool ContainsTokenType(JToken token, JTokenType type)
        {
            return EnumerateTokens(token).Any(value => value.Type == type);
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        internal static string WriteCompact(JToken value)
        {
            return WriteJson(value, Formatting.None, false);
        }

        internal static string WriteIndented(JToken value)
        {
            return WriteJson(value, Formatting.Indented, true);
        }

        private static string WriteJson(JToken value, Formatting formatting, bool finalNewline)
        {
            var builder = new StringBuilder();
            using (var stringWriter = new StringWriter(builder, CultureInfo.InvariantCulture) { NewLine = "\n" })
            using (var writer = new JsonTextWriter(stringWriter)
            {
                Formatting = formatting,
                Indentation = 2,
                IndentChar = ' ',
                Culture = CultureInfo.InvariantCulture,
                StringEscapeHandling = StringEscapeHandling.Default,
            })
            {
                value.WriteTo(writer);
                writer.Flush();
            }

            return finalNewline ? builder + "\n" : builder.ToString();
        }

        internal static string HashBytes(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                return string.Concat(sha256.ComputeHash(bytes).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        internal static void WriteAtomically(ExportPlan plan, string baselineHash)
        {
            VisualBridgeIntegrationProfileLoader.RevalidateResolvedProjectPath(plan.ProjectRoot, plan.OutputPath, plan.OutputPath);
            var directory = Path.GetDirectoryName(plan.OutputPath);
            Directory.CreateDirectory(directory);
            VisualBridgeIntegrationProfileLoader.RevalidateResolvedProjectPath(plan.ProjectRoot, plan.OutputPath, plan.OutputPath);
            var temporaryPath = plan.OutputPath + ".visualbridge." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(plan.Bytes, 0, plan.Bytes.Length);
                    stream.Flush(true);
                }

                VisualBridgeIntegrationProfileLoader.RevalidateResolvedProjectPath(plan.ProjectRoot, plan.OutputPath, plan.OutputPath);
                var outputExists = File.Exists(plan.OutputPath);
                var currentHash = outputExists ? HashBytes(File.ReadAllBytes(plan.OutputPath)) : null;
                if (!string.Equals(currentHash, baselineHash, StringComparison.Ordinal))
                {
                    throw Error("catalog.changedBeforeReplace", plan.OutputPath, "Output changed after planning and before atomic replacement.");
                }

                if (outputExists)
                {
                    File.Replace(temporaryPath, plan.OutputPath, null);
                }
                else
                {
                    File.Move(temporaryPath, plan.OutputPath);
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }
    }
}
