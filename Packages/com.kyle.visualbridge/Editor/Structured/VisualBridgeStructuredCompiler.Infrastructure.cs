using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using VisualBridge.Runtime;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeStructuredCompiler
    {
        private static OutputFileState InspectOutputFile(string path)
        {
            RejectOutputAlias(path);
            if (!File.Exists(path))
            {
                return new OutputFileState(false, null, null);
            }

            var identityBefore = GetWindowsFileIdentity(path, true);
            var hash = HashFile(path);
            var identityAfter = GetWindowsFileIdentity(path, true);
            if (!string.Equals(identityBefore, identityAfter, StringComparison.Ordinal))
            {
                throw Error("compile.outputChangedBeforeReplace", path, "Output identity changed while it was inspected.");
            }

            return new OutputFileState(true, identityAfter, hash);
        }

        private static string GetWindowsFileIdentity(string path, bool rejectHardLinks)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                return null;
            }

            var handle = CreateFile(
                path,
                0,
                FileShareRead | FileShareWrite | FileShareDelete,
                IntPtr.Zero,
                OpenExisting,
                0,
                IntPtr.Zero);
            if (handle == InvalidHandleValue)
            {
                throw Error("compile.outputIdentityUnavailable", path, $"Cannot inspect output file identity (Win32 {Marshal.GetLastWin32Error()}).");
            }

            try
            {
                if (!GetFileInformationByHandle(handle, out var information))
                {
                    throw Error("compile.outputIdentityUnavailable", path, $"Cannot inspect output file identity (Win32 {Marshal.GetLastWin32Error()}).");
                }

                if (rejectHardLinks && information.NumberOfLinks > 1)
                {
                    throw Error("compile.outputHardLinkForbidden", path, "Existing managed outputs must not have hard-link aliases.");
                }

                return information.VolumeSerialNumber.ToString("x8", CultureInfo.InvariantCulture)
                    + ":"
                    + information.FileIndexHigh.ToString("x8", CultureInfo.InvariantCulture)
                    + information.FileIndexLow.ToString("x8", CultureInfo.InvariantCulture);
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint OpenExisting = 3;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
        private static extern IntPtr CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(IntPtr file, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static void RequireDocumentKeys(JObject value, string path)
        {
            RequireKeys(value, path, new[] { "formatVersion", "documentId", "properties" });
        }

        internal static void RequireKeys(JObject value, string path, IEnumerable<string> required)
        {
            var allowed = new HashSet<string>(required, StringComparer.Ordinal);
            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("compile.unknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var property in allowed)
            {
                if (value.Property(property, StringComparison.Ordinal) == null)
                {
                    throw Error("compile.missingProperty", path + "." + property, $"Missing property '{property}'.");
                }
            }
        }

        internal static string RequireIdentifier(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.invalidIdentifier", path, "Expected a stable identifier.");
            }

            var value = token.Value<string>();
            if (value.Length == 0
                || value.Length > 128
                || !IsAsciiAlphaNumeric(value[0])
                || value.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("compile.invalidIdentifier", path, "Expected a stable identifier.");
            }

            return value;
        }

        internal static void RequireHash(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.invalidHash", path, "Expected a lowercase SHA-256 hash.");
            }

            var value = token.Value<string>();
            if (value.Length != 64 || value.Any(character => !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))))
            {
                throw Error("compile.invalidHash", path, "Expected a lowercase SHA-256 hash.");
            }
        }

        internal static void RequireTokenType(JToken token, JTokenType type, string path, string expected)
        {
            if (token == null || token.Type != type)
            {
                throw Error("compile.typeMismatch", path, "Expected " + expected + ".");
            }
        }

        private static void RequireValueType(string actual, string expected, string path)
        {
            if (!string.Equals(actual, expected, StringComparison.Ordinal))
            {
                throw Error("compile.catalogMetadataMismatch", path, $"Expected Catalog valueType '{expected}', found '{actual}'.");
            }
        }

        private static bool TryGetListItem(Type type, out Type itemType)
        {
            if (type.IsArray && type.GetArrayRank() == 1)
            {
                itemType = type.GetElementType();
                return true;
            }

            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
            {
                itemType = type.GetGenericArguments()[0];
                return true;
            }

            itemType = null;
            return false;
        }

        private static bool IsSupportedNumber(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint)
                || type == typeof(float)
                || type == typeof(double);
        }

        private static bool IsIntegral(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint);
        }

        internal static byte[] Serialize(JToken token)
        {
            var builder = new StringBuilder();
            using (var writer = new StringWriter(builder, CultureInfo.InvariantCulture))
            using (var json = new JsonTextWriter(writer))
            {
                json.Formatting = Formatting.Indented;
                json.Indentation = 2;
                json.IndentChar = ' ';
                json.StringEscapeHandling = StringEscapeHandling.EscapeNonAscii;
                json.Culture = CultureInfo.InvariantCulture;
                token.WriteTo(json);
                json.Flush();
            }

            return Utf8WithoutBom.GetBytes(builder.ToString().Replace("\r\n", "\n") + "\n");
        }

        internal static byte[] ReadInputBytes(string path)
        {
            try
            {
                return File.ReadAllBytes(path);
            }
            catch (Exception exception)
            {
                throw Error("compile.inputReadFailed", path, exception.Message);
            }
        }

        internal static void AddInput(IDictionary<string, InputSnapshot> inputs, string path)
        {
            var bytes = ReadInputBytes(path);
            AddInput(inputs, path, bytes, HashBytes(bytes));
        }

        internal static void AddInput(IDictionary<string, InputSnapshot> inputs, string path, byte[] bytes, string hash)
        {
            var fullPath = Path.GetFullPath(path);
            if (inputs.TryGetValue(fullPath, out var existing) && !string.Equals(existing.Hash, hash, StringComparison.Ordinal))
            {
                throw Error("compile.inputChanged", fullPath, "Input changed while it was being read.");
            }

            inputs[fullPath] = new InputSnapshot(fullPath, bytes, hash);
        }

        internal static string HashFile(string path)
        {
            return File.Exists(path) ? HashBytes(File.ReadAllBytes(path)) : null;
        }

        internal static string HashBytes(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                return string.Concat(sha256.ComputeHash(bytes).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        internal static string RelativePathInside(string root, string path, string jsonPath)
        {
            var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var fullPath = Path.GetFullPath(path);
            if (!IsInside(fullRoot, fullPath))
            {
                throw Error("compile.pathOutsideProject", jsonPath, "Path leaves the expected project root.");
            }

            var rootUri = new Uri(fullRoot + Path.DirectorySeparatorChar);
            return Uri.UnescapeDataString(rootUri.MakeRelativeUri(new Uri(fullPath)).ToString()).Replace('\\', '/');
        }

        private static bool IsInside(string root, string candidate)
        {
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var fullCandidate = Path.GetFullPath(candidate);
            return string.Equals(fullRoot, fullCandidate, comparison)
                || fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, comparison);
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        private static void TryDelete(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // 保留过期的事务辅助文件比提交后改写编译结果更安全。
            }
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

    }
}
