using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    /// <summary>一个分类的号分配持久状态（附录 B.5 的 <c>debug-ids.json</c> 条目）。</summary>
    internal sealed class VisualBridgeDebugCategoryIds
    {
        public VisualBridgeDebugCategoryIds(string name, int nextMethodId)
        {
            Name = name;
            NextMethodId = nextMethodId;
            Methods = new SortedDictionary<string, ushort>(StringComparer.Ordinal);
        }

        public string Name { get; }

        /// <summary>下一个可用方法号；永不回退（附录 B.5）。</summary>
        public int NextMethodId { get; set; }

        /// <summary>方法名 → 方法号；已删除的方法条目保留，保证号不复用。</summary>
        public SortedDictionary<string, ushort> Methods { get; }
    }

    /// <summary>
    /// <c>debug-ids.json</c> 的读写。这是唯一可能被并发生成破坏的产物：解析集中在 Load，
    /// 写回走生成器的原子写；调用方负责在持有生成器锁时读改写。
    /// </summary>
    internal sealed class VisualBridgeDebugIdState
    {
        private const int MinimumBusinessMethodId = 10;   // 0 保留、1/2 系统、3–9 预留

        private readonly SortedDictionary<string, VisualBridgeDebugCategoryIds> _categories =
            new SortedDictionary<string, VisualBridgeDebugCategoryIds>(StringComparer.Ordinal);

        public IEnumerable<VisualBridgeDebugCategoryIds> Categories => _categories.Values;

        public static VisualBridgeDebugIdState CreateEmpty()
        {
            return new VisualBridgeDebugIdState();
        }

        public static VisualBridgeDebugIdState Load(string path)
        {
            if (!File.Exists(path))
            {
                return CreateEmpty();
            }

            JObject root;
            try
            {
                root = JObject.Parse(File.ReadAllText(path, new UTF8Encoding(false)));
            }
            catch (Exception exception) when (exception is JsonException || exception is IOException)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.idsInvalid",
                    "debug-ids.json 不是合法 JSON：" + path + "（" + exception.Message + "）");
            }

            var categories = root["categories"] as JObject;
            if (categories == null)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.idsInvalid",
                    "debug-ids.json 缺少 categories 对象：" + path);
            }

            var state = new VisualBridgeDebugIdState();
            foreach (var category in categories.Properties())
            {
                var value = category.Value as JObject;
                if (value == null)
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.idsInvalid",
                        "debug-ids.json 的分类 " + category.Name + " 必须是对象。");
                }

                var nextToken = value["nextMethodId"];
                if (nextToken == null || (nextToken.Type != JTokenType.Integer && nextToken.Type != JTokenType.Float))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.idsInvalid",
                        "debug-ids.json 的分类 " + category.Name + " 缺少整数 nextMethodId。");
                }

                var nextMethodId = nextToken.Value<int>();
                // 65536 是「号已耗尽」的哨兵值：最后一个号 65535 分配完后 nextMethodId 只能前进到 65536，
                // 再分配新方法时报 debug.methodIdExhausted（评审 P2-3）。
                if (nextMethodId < MinimumBusinessMethodId || nextMethodId > ushort.MaxValue + 1)
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.idsInvalid",
                        "debug-ids.json 的分类 " + category.Name + " 的 nextMethodId 超出业务号段 [10, 65536]："
                        + nextMethodId.ToString(CultureInfo.InvariantCulture));
                }

                var entry = new VisualBridgeDebugCategoryIds(category.Name, nextMethodId);
                var methods = value["methods"] as JObject;
                if (methods != null)
                {
                    var owners = new Dictionary<ushort, string>();
                    foreach (var method in methods.Properties())
                    {
                        if (method.Value.Type != JTokenType.Integer && method.Value.Type != JTokenType.Float)
                        {
                            throw new VisualBridgeDebugGeneratorException(
                                "debug.idsInvalid",
                                "debug-ids.json 的分类 " + category.Name + " 的方法 " + method.Name + " 的方法号不是整数。");
                        }

                        var id = method.Value.Value<int>();
                        if (id < MinimumBusinessMethodId || id > ushort.MaxValue)
                        {
                            throw new VisualBridgeDebugGeneratorException(
                                "debug.idsInvalid",
                                "debug-ids.json 的分类 " + category.Name + " 的方法 " + method.Name
                                + " 的方法号超出业务号段 [10, 65535]：" + id.ToString(CultureInfo.InvariantCulture));
                        }

                        string owner;
                        if (owners.TryGetValue((ushort)id, out owner))
                        {
                            if (!string.Equals(owner, method.Name, StringComparison.Ordinal))
                            {
                                throw new VisualBridgeDebugGeneratorException(
                                    "VBDBG015",
                                    "分类 " + category.Name + " 的方法 " + owner + " 与 " + method.Name
                                    + " 都分配了方法号 " + id.ToString(CultureInfo.InvariantCulture) + "（同分类同号不同名）。");
                            }
                        }
                        else
                        {
                            owners.Add((ushort)id, method.Name);
                        }

                        entry.Methods[method.Name] = (ushort)id;
                    }

                    if (entry.Methods.Count != 0 && nextMethodId <= entry.Methods.Values.Max())
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "VBDBG015",
                            "分类 " + category.Name + " 的 nextMethodId（" + nextMethodId.ToString(CultureInfo.InvariantCulture)
                            + "）不大于已分配的最大方法号（"
                            + entry.Methods.Values.Max().ToString(CultureInfo.InvariantCulture)
                            + "）：继续分配会产生同分类同号不同名。");
                    }
                }

                if (state._categories.ContainsKey(category.Name))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.idsInvalid",
                        "debug-ids.json 的分类重复：" + category.Name);
                }

                state._categories.Add(category.Name, entry);
            }

            return state;
        }

        public VisualBridgeDebugCategoryIds GetOrAddCategory(string name)
        {
            VisualBridgeDebugCategoryIds entry;
            if (!_categories.TryGetValue(name, out entry))
            {
                entry = new VisualBridgeDebugCategoryIds(name, MinimumBusinessMethodId);
                _categories.Add(name, entry);
            }

            return entry;
        }

        /// <summary>序列化为确定性 JSON（LF、2 空格缩进、分类与方法名按序数排序、末尾换行）。</summary>
        public string ToJson()
        {
            var builder = new StringBuilder();
            builder.Append("{\n");
            // JSON 不能写 // 注释，用同名键保留产物标记（读取方忽略未知键）。
            builder.Append("  \"//\": \"// <auto-generated />\",\n");
            builder.Append("  \"categories\": {\n");
            var categories = _categories.Values.OrderBy(value => value.Name, StringComparer.Ordinal).ToArray();
            for (var categoryIndex = 0; categoryIndex < categories.Length; categoryIndex++)
            {
                var category = categories[categoryIndex];
                builder.Append("    ").Append(JsonConvert.ToString(category.Name)).Append(": {\n");
                builder.Append("      \"nextMethodId\": ")
                    .Append(category.NextMethodId.ToString(CultureInfo.InvariantCulture))
                    .Append(",\n");
                builder.Append("      \"methods\": {");
                var methods = category.Methods.ToArray();
                if (methods.Length == 0)
                {
                    builder.Append("}\n");
                }
                else
                {
                    builder.Append('\n');
                    for (var methodIndex = 0; methodIndex < methods.Length; methodIndex++)
                    {
                        builder.Append("        ")
                            .Append(JsonConvert.ToString(methods[methodIndex].Key))
                            .Append(": ")
                            .Append(((int)methods[methodIndex].Value).ToString(CultureInfo.InvariantCulture));
                        builder.Append(methodIndex + 1 < methods.Length ? ",\n" : "\n");
                    }

                    builder.Append("      }\n");
                }

                builder.Append(categoryIndex + 1 < categories.Length ? "    },\n" : "    }\n");
            }

            builder.Append("  }\n");
            builder.Append("}\n");
            return builder.ToString();
        }
    }

    /// <summary>号分配：已存在的方法名沿用旧号，新方法从 nextMethodId 起递增，nextMethodId 不回退。</summary>
    internal static class VisualBridgeDebugIdAllocator
    {
        public static VisualBridgeDebugIdState Assign(VisualBridgeDebugDefinitionModel definition, VisualBridgeDebugIdState state)
        {
            foreach (var category in definition.Categories)
            {
                var entry = state.GetOrAddCategory(category.Name);
                foreach (var method in category.Interfaces.SelectMany(value => value.Methods)
                             .OrderBy(value => value.Name, StringComparer.Ordinal))
                {
                    ushort existing;
                    if (entry.Methods.TryGetValue(method.Name, out existing))
                    {
                        method.MethodId = existing;
                        continue;
                    }

                    if (entry.NextMethodId > ushort.MaxValue)
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.methodIdExhausted",
                            "分类 " + category.Name + " 的方法号已耗尽（上限 65535），无法分配给 " + method.Name + "。");
                    }

                    var id = (ushort)entry.NextMethodId;
                    entry.NextMethodId++;
                    entry.Methods[method.Name] = id;
                    method.MethodId = id;
                }
            }

            return state;
        }
    }
}
