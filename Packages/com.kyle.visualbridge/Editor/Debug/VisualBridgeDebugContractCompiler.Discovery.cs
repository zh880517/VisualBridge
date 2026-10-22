using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using VisualBridge.Debug;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeDebugContractCompiler
    {
        /// <summary>扫描所有带 [VisualBridgeDebuger] 的类型；测试程序集不参与生成。</summary>
        internal static IReadOnlyList<Type> DiscoverInterfaces()
        {
            return TypeCache.GetTypesWithAttribute<VisualBridgeDebugerAttribute>()
                .Where(type => type != null)
                .Where(type => !IsTestAssembly(type.Assembly.GetName().Name))
                .OrderBy(type => type.FullName ?? type.Name, StringComparer.Ordinal)
                .ToArray();
        }

        private static bool IsTestAssembly(string assemblyName)
        {
            if (string.IsNullOrEmpty(assemblyName))
            {
                return false;
            }

            return assemblyName.EndsWith(".Tests", StringComparison.Ordinal)
                || assemblyName.EndsWith(".Test", StringComparison.Ordinal);
        }

        internal static VisualBridgeDebugerAttribute GetDebugerAttribute(Type type)
        {
            return type.GetCustomAttributes(typeof(VisualBridgeDebugerAttribute), false)
                .OfType<VisualBridgeDebugerAttribute>()
                .FirstOrDefault();
        }
    }
}
