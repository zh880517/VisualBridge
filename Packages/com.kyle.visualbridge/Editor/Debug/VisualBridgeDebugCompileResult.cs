using System.Collections.Generic;
using System.Linq;

namespace VisualBridge.Editor
{
    /// <summary>一次 Generate/Check 的结果；<see cref="DriftDetected"/> 是 batch 退出码 2 的唯一依据。</summary>
    public sealed class VisualBridgeDebugCompileResult
    {
        internal VisualBridgeDebugCompileResult(
            VisualBridgeDebugGenerateMode mode,
            IReadOnlyList<VisualBridgeDebugCompileOutput> outputs,
            IReadOnlyList<string> staleOutputs,
            string contractHash)
        {
            Mode = mode;
            Outputs = outputs;
            StaleOutputs = staleOutputs;
            ContractHash = contractHash;
        }

        public VisualBridgeDebugGenerateMode Mode { get; }

        /// <summary>全部应存在的产物（全局三个 + 每个分类的 C#/TS 产物）；Check 会逐个比较字节。</summary>
        public IReadOnlyList<VisualBridgeDebugCompileOutput> Outputs { get; }

        /// <summary>
        /// 已经不再对应任何契约输入的旧产物：被删除的接口、被删除的整个分类、被移动的生成目录，
        /// 以及换 ArtifactsRoot 后留下的旧全局产物（来自上一次 Generate 记录的清单）。
        /// Check 计为 drift，Generate 删除。
        /// </summary>
        public IReadOnlyList<string> StaleOutputs { get; }

        /// <summary>本次契约指纹（与 <c>debug-contracts.json</c> 的 contractHash 一致）。</summary>
        public string ContractHash { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed) || StaleOutputs.Count != 0;
    }
}
