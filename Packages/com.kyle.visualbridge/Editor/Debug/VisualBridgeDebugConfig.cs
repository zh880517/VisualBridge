using System.Linq;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 调试契约生成器配置（ScriptableObject）。一个工程一份，放在任何被 asmdef 覆盖的目录即可。
    /// <see cref="ArtifactsRoot"/> 只承载三个全局产物（附录 B.5）；<see cref="GeneratedDirectory"/> 是
    /// 特性上 <c>GeneratedDirectory</c> 的推荐默认值，**不是**缺失时的回退：附录 B.5/B.1 规定特性上必填，
    /// 缺失即 VBDBG013。
    /// </summary>
    [CreateAssetMenu(
        fileName = "VisualBridgeDebugConfig",
        menuName = "VisualBridge/Debug Contract Config",
        order = 0)]
    public sealed class VisualBridgeDebugConfig : ScriptableObject
    {
        [SerializeField]
        private string artifactsRoot = VisualBridgeDebugGeneratorSettings.DefaultArtifactsRoot;

        [SerializeField]
        private string generatedDirectory = VisualBridgeDebugGeneratorSettings.DefaultGeneratedDirectory;

        /// <summary>三个全局产物的目录（项目相对路径，必须在项目内且被 asmdef 覆盖）。</summary>
        public string ArtifactsRoot
        {
            get
            {
                return string.IsNullOrWhiteSpace(artifactsRoot)
                    ? VisualBridgeDebugGeneratorSettings.DefaultArtifactsRoot
                    : artifactsRoot.Trim();
            }
        }

        /// <summary>特性 <c>GeneratedDirectory</c> 的推荐默认值（不参与 VBDBG013 判定）。</summary>
        public string GeneratedDirectory
        {
            get
            {
                return string.IsNullOrWhiteSpace(generatedDirectory)
                    ? VisualBridgeDebugGeneratorSettings.DefaultGeneratedDirectory
                    : generatedDirectory.Trim();
            }
        }

        /// <summary>供生成器测试与工具注入：ScriptableObject 不能用 new 构造。</summary>
        public void Configure(string artifactsRootValue, string generatedDirectoryValue)
        {
            artifactsRoot = artifactsRootValue;
            generatedDirectory = generatedDirectoryValue;
        }

        /// <summary>取工程里唯一一份配置；没有配置时返回内存里的默认配置（不落盘）。</summary>
        public static VisualBridgeDebugConfig LoadOrDefault()
        {
            var guids = AssetDatabase.FindAssets("t:VisualBridgeDebugConfig");
            if (guids == null || guids.Length == 0)
            {
                return CreateInstance<VisualBridgeDebugConfig>();
            }

            // 多份配置按资产路径排序取第一份，避免依赖 FindAssets 的返回顺序。
            var paths = guids
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(path => !string.IsNullOrEmpty(path))
                .OrderBy(path => path, System.StringComparer.Ordinal)
                .ToArray();
            foreach (var path in paths)
            {
                var config = AssetDatabase.LoadAssetAtPath<VisualBridgeDebugConfig>(path);
                if (config != null)
                {
                    return config;
                }
            }

            return CreateInstance<VisualBridgeDebugConfig>();
        }
    }
}
