using System;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 契约指纹（附录 B.5）：把分类、接口、方法、参数、枚举按固定顺序拼成规范化文本，
    /// 取 SHA-256 前 8 字节的 16 位十六进制。文本只依赖契约输入，与生成顺序、遍历顺序无关。
    /// </summary>
    internal static class VisualBridgeDebugContractHash
    {
        private const string FormatVersion = "visualbridge.debug.contract/1";

        public static string Compute(VisualBridgeDebugDefinitionModel definition)
        {
            return Hash(ComputeText(definition));
        }

        public static string ComputeText(VisualBridgeDebugDefinitionModel definition)
        {
            var builder = new StringBuilder();
            builder.Append(FormatVersion).Append('\n');

            // hash 与遍历顺序无关：分类/接口/方法/枚举都在这里按固定规则重排，成员顺序也按值+名字归一。
            foreach (var category in definition.Categories.OrderBy(value => value.Name, StringComparer.Ordinal))
            {
                builder.Append("category\t").Append(category.Name).Append('\t').Append(category.TypeName).Append('\n');

                foreach (var contractInterface in category.Interfaces
                             .OrderBy(value => value.InterfaceFullName, StringComparer.Ordinal))
                {
                    builder.Append("interface\t")
                        .Append(category.Name).Append('\t')
                        .Append(contractInterface.InterfaceFullName).Append('\t')
                        .Append(contractInterface.KindText).Append('\t')
                        .Append(contractInterface.ClassName).Append('\n');

                    foreach (var method in contractInterface.Methods.OrderBy(value => value.Name, StringComparer.Ordinal))
                    {
                        builder.Append("method\t")
                            .Append(category.Name).Append('\t')
                            .Append(contractInterface.InterfaceFullName).Append('\t')
                            .Append(method.Name).Append('\t')
                            .Append(method.MethodId.ToString(CultureInfo.InvariantCulture)).Append('\t')
                            .Append(method.ResultContractType).Append('\n');

                        var index = 0;
                        foreach (var parameter in method.Parameters)
                        {
                            builder.Append("param\t")
                                .Append(category.Name).Append('\t')
                                .Append(contractInterface.InterfaceFullName).Append('\t')
                                .Append(method.Name).Append('\t')
                                .Append(index.ToString(CultureInfo.InvariantCulture)).Append('\t')
                                .Append(parameter.Name).Append('\t')
                                .Append(parameter.ContractType).Append('\t')
                                .Append(parameter.Tag.ToString(CultureInfo.InvariantCulture)).Append('\t')
                                .Append(parameter.IsInstance ? "instance" : parameter.IsRequest ? "request" : "payload").Append('\t')
                                .Append(parameter.Optional ? "optional" : "required").Append('\n');
                            index++;
                        }

                        if (method.ResultParameter != null)
                        {
                            builder.Append("result\t")
                                .Append(category.Name).Append('\t')
                                .Append(contractInterface.InterfaceFullName).Append('\t')
                                .Append(method.Name).Append('\t')
                                .Append(method.ResultParameter.Name).Append('\t')
                                .Append(method.ResultParameter.ContractType).Append('\t')
                                .Append(method.ResultParameter.Tag.ToString(CultureInfo.InvariantCulture)).Append('\n');
                        }
                    }
                }
            }

            foreach (var contractEnum in definition.Enums.OrderBy(value => value.FullName, StringComparer.Ordinal))
            {
                // 底层类型决定二进制值宽，属于契约输入。
                builder.Append("enum\t").Append(contractEnum.FullName).Append('\t')
                    .Append(contractEnum.UnderlyingType).Append('\n');
                foreach (var member in contractEnum.Members
                             .OrderBy(value => value.Value)
                             .ThenBy(value => value.Key, StringComparer.Ordinal))
                {
                    builder.Append("enum-member\t")
                        .Append(contractEnum.FullName).Append('\t')
                        .Append(member.Key).Append('\t')
                        .Append(member.Value.ToString(CultureInfo.InvariantCulture)).Append('\n');
                }
            }

            return builder.ToString();
        }

        /// <summary>契约指纹：规范化文本的 SHA-256 前 8 字节（16 位十六进制，附录 B.5）。</summary>
        public static string Hash(string text)
        {
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(Encoding.UTF8.GetBytes(text));
                var builder = new StringBuilder(16);
                for (var index = 0; index < 8; index++)
                {
                    builder.Append(hash[index].ToString("x2", CultureInfo.InvariantCulture));
                }

                return builder.ToString();
            }
        }

        /// <summary>产物文件的完整 SHA-256（64 位十六进制）；与契约指纹用的截断 hash 区分开。</summary>
        public static string HashFile(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(bytes);
                var builder = new StringBuilder(64);
                foreach (var value in hash)
                {
                    builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                }

                return builder.ToString();
            }
        }
    }
}
