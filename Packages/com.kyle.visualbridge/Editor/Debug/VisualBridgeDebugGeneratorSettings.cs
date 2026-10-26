using System;
using System.Collections.Generic;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 生成器的一次输入。<see cref="Interfaces"/> 为空表示反射扫描全部已加载程序集里带
    /// <c>[VisualBridgeDebuger]</c> 的接口；测试传入显式集合，避免依赖测试程序集的加载顺序。
    /// </summary>
    public sealed class VisualBridgeDebugGeneratorSettings
    {
        /// <summary>ArtifactsRoot 的默认值：三个全局产物只写这里。</summary>
        public const string DefaultArtifactsRoot = "Assets/VisualBridgeGenerated/Debug";

        /// <summary>
        /// 特性的 <c>GeneratedDirectory</c> 推荐默认值。它**不是**缺失时的回退：
        /// 附录 B.5/B.1 规定特性上的 <c>GeneratedDirectory</c> 必填，缺失即 VBDBG013。
        /// </summary>
        public const string DefaultGeneratedDirectory = "Assets/VisualBridgeGenerated/Debug/Contracts";

        public VisualBridgeDebugGeneratorSettings(string unityProjectRoot)
        {
            if (string.IsNullOrWhiteSpace(unityProjectRoot))
            {
                throw new VisualBridgeDebugGeneratorException("debug.projectRootInvalid", "Unity 工程根不能为空。");
            }

            UnityProjectRoot = unityProjectRoot;
            ArtifactsRoot = DefaultArtifactsRoot;
            Interfaces = null;
        }

        /// <summary>Unity 工程根（含 <c>Assets/</c> 的目录）；输入里的 GeneratedDirectory 都相对它解析。</summary>
        public string UnityProjectRoot { get; }

        /// <summary>三个全局产物的目录（项目相对路径或绝对路径，必须在项目内且被 asmdef 覆盖）。</summary>
        public string ArtifactsRoot { get; set; }

        /// <summary>显式的接口集合；<c>null</c> 表示反射发现。</summary>
        public IReadOnlyList<Type> Interfaces { get; set; }
    }
}
