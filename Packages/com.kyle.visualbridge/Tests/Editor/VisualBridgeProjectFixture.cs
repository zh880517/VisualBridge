using System;
using System.Collections.Generic;
using System.Linq;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// Project File v2 的测试构造器：集中 formatVersion、modules 与 tableLayout 的新位置，避免每个
    /// EditMode fixture 各写一份容易漂移的内联字符串。
    /// </summary>
    internal static class VisualBridgeProjectFixture
    {
        public const string TableModuleId = "visualbridge.table";
        public const string TableModuleEntry = "Modules/table.vbmodule.js";
        public const string DefaultTableLayoutJson = "{ \"nameKeyRow\": 2, \"dataStartRow\": 3 }";

        public static string Module(string id, string entry, string optionsJson = null, string hash = null)
        {
            return "{ \"id\": \"" + id + "\", \"entry\": \"" + entry + "\""
                + (optionsJson == null ? string.Empty : ", \"options\": " + optionsJson)
                + (hash == null ? string.Empty : ", \"hash\": \"" + hash + "\"")
                + " }";
        }

        public static string TableModule(string layoutJson = DefaultTableLayoutJson)
        {
            return layoutJson == null
                ? Module(TableModuleId, TableModuleEntry)
                : Module(TableModuleId, TableModuleEntry, "{ \"tableLayout\": " + layoutJson + " }");
        }

        public static string Project(
            string projectId,
            string documentRootsJson,
            string documentTypesJson,
            IEnumerable<string> modules = null,
            string providersJson = null)
        {
            var moduleList = modules == null ? Array.Empty<string>() : modules.ToArray();
            return "{\n"
                + "  \"formatVersion\": 2,\n"
                + "  \"projectId\": \"" + projectId + "\",\n"
                + "  \"documentRoots\": [" + documentRootsJson + "],\n"
                + "  \"modules\": [" + string.Join(", ", moduleList) + "],\n"
                + "  \"documentTypes\": [" + documentTypesJson + "]"
                + (providersJson == null ? string.Empty : ",\n  \"providers\": [" + providersJson + "]")
                + "\n}\n";
        }
    }
}
