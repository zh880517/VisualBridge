using System;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 读取编译产物里的调试契约指纹（<c>debug-contracts.json</c> 的 <c>contractHash</c>），
    /// 供 Runtime Welcome 的 <c>contractHash</c> 字段使用（附录 A.3 指纹层）。
    /// Runtime 程序集不引用 Editor 侧的指纹实现，只读产物文件；缺失或非法时返回空串，
    /// 让指纹层降级（照常建连、payload 降级为 JSON），而不是握手失败。
    /// </summary>
    internal static class VisualBridgeRuntimeContractHash
    {
        internal const string FileName = "debug-contracts.json";

        private static readonly Regex HashPattern = new Regex("^[0-9a-f]{16}$", RegexOptions.Compiled);

        /// <summary>返回 16 位小写十六进制指纹；无契约、文件缺失、解析失败时返回空串。</summary>
        public static string Read(string artifactsRoot)
        {
            if (string.IsNullOrEmpty(artifactsRoot))
            {
                return string.Empty;
            }

            try
            {
                var path = Path.Combine(artifactsRoot, FileName);
                if (!File.Exists(path))
                {
                    return string.Empty;
                }

                var root = JObject.Parse(File.ReadAllText(path));
                var value = (root["contractHash"] as JValue)?.Value<string>();
                return value != null && HashPattern.IsMatch(value) ? value : string.Empty;
            }
            catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException
                || exception is JsonException || exception is ArgumentException)
            {
                // 产物可能正被编译进程替换：指纹层允许缺失，握手续用空串。
                return string.Empty;
            }
        }
    }
}
