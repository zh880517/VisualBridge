using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeDebugContractCompiler
    {
        private const string Runtime = "global::VisualBridge.Debug.VisualBridgeDebug";
        private const string RequestType = "global::VisualBridge.Debug.VisualBridgeDebugRequest";

        internal static IReadOnlyList<VisualBridgeDebugGeneratedFile> EmitFiles(
            IReadOnlyList<DebugContractModel> models)
        {
            var files = new List<VisualBridgeDebugGeneratedFile>();
            foreach (DebugContractModel model in models
                         .OrderBy(value => value.FullName, StringComparer.Ordinal))
            {
                string directory = model.GeneratedDirectory;
                if (model.IsQuery)
                {
                    files.Add(new VisualBridgeDebugGeneratedFile(
                        directory + "/" + model.FacadeFileName,
                        EmitQueryFacade(model)));
                    files.Add(new VisualBridgeDebugGeneratedFile(
                        directory + "/" + model.DispatcherFileName,
                        EmitQueryDispatcher(model)));
                }
                else
                {
                    files.Add(new VisualBridgeDebugGeneratedFile(
                        directory + "/" + model.FacadeFileName,
                        EmitEventFacade(model)));
                    files.Add(new VisualBridgeDebugGeneratedFile(
                        directory + "/" + model.ImplementationFileName,
                        EmitEventImplementation(model)));
                }
            }

            foreach (var group in models
                         .GroupBy(model => model.GeneratedDirectory, StringComparer.Ordinal)
                         .OrderBy(value => value.Key, StringComparer.Ordinal))
            {
                files.Add(new VisualBridgeDebugGeneratedFile(
                    group.Key + "/debug-contracts.json",
                    EmitContractJson(group.ToArray())));
            }

            return files
                .OrderBy(file => file.RelativePath, StringComparer.Ordinal)
                .ToArray();
        }

        private static string EmitEventFacade(DebugContractModel model)
        {
            var writer = new CodeWriter();
            WriteHeader(writer, model.Namespace, () =>
            {
                writer.Open("public static class " + model.ClassName);
                writer.Line("private static " + model.InterfaceName + " s_impl;");
                writer.Line();
                WriteDescribeInstance(writer, model);
                foreach (DebugMethodModel method in model.Methods)
                {
                    writer.Line();
                    writer.Open("public static void " + method.Name + "(" + Declarations(method) + ")");
                    WriteGuard(writer);
                    writer.Line();
                    writer.Line(
                        "(s_impl ??= new " + model.ImplementationClassName + "())."
                        + method.Name
                        + "("
                        + Names(method)
                        + ");");
                    writer.Close("}");
                }

                writer.Close("}");
            });
            return writer.ToString();
        }

        private static string EmitEventImplementation(DebugContractModel model)
        {
            var writer = new CodeWriter();
            WriteHeader(writer, model.Namespace, () =>
            {
                writer.Open(
                    "internal sealed class " + model.ImplementationClassName
                    + " : global::" + model.FullName);
                foreach (DebugMethodModel method in model.Methods)
                {
                    writer.Line();
                    writer.Open("public void " + method.Name + "(" + Declarations(method) + ")");
                    WriteStart(writer, model, method, StartInstanceArgument(model, method), null);
                    foreach (DebugParamModel parameter in method.Parameters)
                    {
                        writer.Line(
                            Runtime
                            + ".PushParam("
                            + Quote(parameter.Name)
                            + ", "
                            + parameter.Tag
                            + ", "
                            + parameter.WireArgument
                            + ");");
                    }

                    writer.Line(Runtime + ".End();");
                    writer.Close("}");
                }

                writer.Close("}");
            });
            return writer.ToString();
        }

        private static string EmitQueryFacade(DebugContractModel model)
        {
            var writer = new CodeWriter();
            WriteHeader(writer, model.Namespace, () =>
            {
                writer.Open("public static class " + model.ClassName);
                writer.Line("private static readonly object s_gate = new object();");
                writer.Line("private static " + model.InterfaceName + " s_impl;");
                writer.Line();
                if (model.InstanceParameter != null)
                {
                    WriteDescribeInstance(writer, model);
                    writer.Line();
                }

                writer.Open("public static void Register(" + model.InterfaceName + " implementation)");
                writer.Line("if (implementation == null)");
                writer.OpenBlock();
                writer.Line("throw new global::System.ArgumentNullException(nameof(implementation));");
                writer.Close("}");
                writer.Line();
                writer.Open("lock (s_gate)");
                writer.Open("if (s_impl != null)");
                writer.Line(
                    "global::UnityEngine.Debug.LogWarning("
                    + Quote("[visualbridge] " + model.InterfaceName + " registered twice; replacing.")
                    + ");");
                writer.Close("}");
                writer.Line();
                writer.Line("s_impl = implementation;");
                writer.Line(
                    Runtime
                    + ".RegisterRequestHandler("
                    + Quote(model.FullName)
                    + ", Dispatch);");
                writer.Close("}");
                writer.Close("}");
                writer.Line();
                writer.Open("public static void Unregister()");
                writer.Open("lock (s_gate)");
                writer.Line("s_impl = null;");
                writer.Line(
                    Runtime + ".UnregisterRequestHandler(" + Quote(model.FullName) + ");");
                writer.Close("}");
                writer.Close("}");

                foreach (DebugMethodModel method in model.Methods)
                {
                    writer.Line();
                    DebugParamModel instance = FindInstanceParameter(model, method);
                    writer.Open(
                        "public static void Send"
                        + method.Name
                        + "Result("
                        + SendDeclarations(model, method, instance)
                        + ")");
                    WriteGuard(writer);
                    writer.Line();
                    WriteStart(
                        writer,
                        model,
                        method,
                        instance == null ? "\"\"" : instance.Name,
                        "requestId");
                    int resultTag = 0;
                    foreach (DebugParamModel parameter in method.ResultParameters)
                    {
                        if (instance != null
                            && string.Equals(parameter.Name, instance.Name, StringComparison.Ordinal))
                        {
                            continue;
                        }

                        writer.Line(
                            Runtime
                            + ".PushParam("
                            + Quote(parameter.Name)
                            + ", "
                            + resultTag
                            + ", "
                            + parameter.WireArgument
                            + ");");
                        resultTag++;
                    }

                    writer.Line(Runtime + ".End();");
                    writer.Close("}");
                }

                writer.Line();
                writer.Open("private static void Dispatch(" + RequestType + " request)");
                writer.Line(model.InterfaceName + " implementation;");
                writer.Open("lock (s_gate)");
                writer.Line("implementation = s_impl;");
                writer.Close("}");
                writer.Line();
                writer.Line("if (implementation == null)");
                writer.OpenBlock();
                writer.Line("return;");
                writer.Close("}");
                writer.Line();
                writer.Line(model.DispatcherClassName + ".Dispatch(request, implementation);");
                writer.Close("}");
                writer.Close("}");
            });
            return writer.ToString();
        }

        private static string EmitQueryDispatcher(DebugContractModel model)
        {
            var writer = new CodeWriter();
            WriteHeader(writer, model.Namespace, () =>
            {
                writer.Open("internal static class " + model.DispatcherClassName);
                writer.Open(
                    "internal static void Dispatch(" + RequestType + " request, global::"
                    + model.FullName + " implementation)");
                writer.Open("switch (request.Method)");
                foreach (DebugMethodModel method in model.Methods)
                {
                    writer.Line("case " + Quote(method.Name) + ":");
                    writer.OpenBlock();
                    string[] localNames = GetLocalNames(method);
                    if (method.ParameterCount != 0)
                    {
                        var conditions = new List<string>();
                        for (int i = 0; i < method.ParameterCount; i++)
                        {
                            conditions.Add(TryGetArgument(method, i, localNames[i]));
                        }

                        for (int i = 0; i < conditions.Count; i++)
                        {
                            string prefix = i == 0 ? "if (!" : "    || !";
                            string suffix = i == conditions.Count - 1 ? ")" : string.Empty;
                            writer.Line(prefix + conditions[i] + suffix);
                        }

                        writer.OpenBlock();
                        writer.Line(Runtime + ".OnRequestArgumentError(request);");
                        writer.Line("return;");
                        writer.Close("}");
                        writer.Line();
                    }

                    var arguments = new List<string>();
                    for (int i = 0; i < method.ParameterCount; i++)
                    {
                        arguments.Add(InvocationArgument(method.Parameters[i], localNames[i]));
                    }

                    writer.Line("implementation." + method.Name + "(" + string.Join(", ", arguments) + ");");
                    writer.Line("return;");
                    writer.Close("}");
                }

                writer.Close("}");
                writer.Close("}");
                writer.Close("}");
            });
            return writer.ToString();
        }

        private static string TryGetArgument(
            DebugMethodModel method,
            int index,
            string localName)
        {
            DebugParamModel parameter = method.Parameters[index];
            return "request.TryGetArg("
                   + index
                   + ", out "
                   + parameter.WireTypeName
                   + " "
                   + localName
                   + ")";
        }

        private static string InvocationArgument(DebugParamModel parameter, string localName)
        {
            if (parameter.IsNarrowed)
            {
                return "(" + parameter.DeclaredTypeName + ")" + localName;
            }

            return localName;
        }

        private static string[] GetLocalNames(DebugMethodModel method)
        {
            var used = new HashSet<string>(StringComparer.Ordinal)
            {
                "request",
                "implementation",
            };
            var names = new string[method.ParameterCount];
            for (int i = 0; i < method.ParameterCount; i++)
            {
                string name = method.Parameters[i].Name;
                if (string.IsNullOrEmpty(name) || !used.Add(name))
                {
                    name = "arg" + i;
                    while (!used.Add(name))
                    {
                        name += "_";
                    }
                }

                names[i] = name;
            }

            return names;
        }

        private static void WriteHeader(
            CodeWriter writer,
            string namespaceName,
            Action body)
        {
            writer.Line("// <auto-generated />");
            if (string.IsNullOrEmpty(namespaceName))
            {
                body();
                return;
            }

            writer.Open("namespace " + namespaceName);
            body();
            writer.Close("}");
        }

        private static void WriteGuard(CodeWriter writer)
        {
            writer.Line("if (!" + Runtime + ".isDebugBuild");
            writer.Line("    || !" + Runtime + ".isConnected)");
            writer.Line("{");
            writer.Indent();
            writer.Line("return;");
            writer.Outdent();
            writer.Line("}");
        }

        private static void WriteDescribeInstance(CodeWriter writer, DebugContractModel model)
        {
            string instance = model.InstanceParameter;
            if (instance == null)
            {
                return;
            }

            writer.Open(
                "public static void DescribeInstance(string "
                + instance
                + ", string label, params string[] keywords)");
            writer.Line(
                Runtime
                + ".DescribeInstance("
                + Quote(model.Category)
                + ", "
                + instance
                + ", label, keywords);");
            writer.Close("}");
        }

        private static void WriteStart(
            CodeWriter writer,
            DebugContractModel model,
            DebugMethodModel method,
            string instanceArgument,
            string requestIdArgument)
        {
            string arguments = Quote(model.Category)
                               + ", "
                               + model.Version
                               + ", "
                               + Quote(model.FullName)
                               + ", "
                               + Quote(method.Name)
                               + ", "
                               + instanceArgument
                               + ", "
                               + (requestIdArgument ?? "null");
            DebugParamModel frame = FindFrameParameter(model, method);
            if (frame != null)
            {
                arguments += ", " + frame.Name;
            }

            writer.Line(Runtime + ".Start(");
            writer.Line("    " + arguments + ");");
        }

        private static string StartInstanceArgument(
            DebugContractModel model,
            DebugMethodModel method)
        {
            DebugParamModel instance = FindInstanceParameter(model, method);
            return instance == null ? "\"\"" : instance.Name;
        }

        private static DebugParamModel FindInstanceParameter(
            DebugContractModel model,
            DebugMethodModel method)
        {
            return model.InstanceParameter == null
                ? null
                : method.FindParameter(model.InstanceParameter);
        }

        private static DebugParamModel FindFrameParameter(
            DebugContractModel model,
            DebugMethodModel method)
        {
            return model.FrameParameter == null
                ? null
                : method.FindParameter(model.FrameParameter);
        }

        private static string SendDeclarations(
            DebugContractModel model,
            DebugMethodModel method,
            DebugParamModel instance)
        {
            var declarations = new List<string>();
            if (instance != null)
            {
                declarations.Add(instance.DeclaredTypeName + " " + instance.Name);
            }

            declarations.Add("string requestId");
            foreach (DebugParamModel parameter in method.ResultParameters)
            {
                if (instance != null
                    && string.Equals(parameter.Name, instance.Name, StringComparison.Ordinal))
                {
                    continue;
                }

                declarations.Add(parameter.DeclaredTypeName + " " + parameter.Name);
            }

            return string.Join(", ", declarations);
        }

        private static string Declarations(DebugMethodModel method)
        {
            return string.Join(
                ", ",
                method.Parameters.Select(parameter => parameter.DeclaredTypeName + " " + parameter.Name));
        }

        private static string Names(DebugMethodModel method)
        {
            return string.Join(", ", method.Parameters.Select(parameter => parameter.Name));
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                return "null";
            }

            return "\""
                   + value.Replace("\\", "\\\\")
                       .Replace("\"", "\\\"")
                       .Replace("\n", "\\n")
                       .Replace("\r", "\\r")
                   + "\"";
        }

        private static string EmitContractJson(IReadOnlyList<DebugContractModel> models)
        {
            var root = new JObject();
            root["schemaVersion"] = 1;

            var interfaces = new JArray();
            foreach (DebugContractModel model in models
                         .OrderBy(value => value.FullName, StringComparer.Ordinal))
            {
                var entry = new JObject();
                entry["id"] = model.FullName;
                entry["category"] = model.Category;
                entry["version"] = model.Version;
                entry["kind"] = model.ContractKind;
                if (model.InstanceParameter != null)
                {
                    entry["instanceParam"] = model.InstanceParameter;
                }

                if (model.FrameParameter != null)
                {
                    entry["frameParam"] = model.FrameParameter;
                }

                var methods = new JArray();
                foreach (DebugMethodModel method in model.Methods)
                {
                    var methodEntry = new JObject();
                    methodEntry["name"] = method.Name;
                    var parameters = new JArray();
                    foreach (DebugParamModel parameter in method.Parameters
                                 .OrderBy(value => value.Tag))
                    {
                        var parameterEntry = new JObject();
                        parameterEntry["name"] = parameter.Name;
                        parameterEntry["tag"] = parameter.Tag;
                        parameterEntry["type"] = parameter.ContractTypeName;
                        if (parameter.IsEnum)
                        {
                            parameterEntry["enumId"] = GetFullTypeName(parameter.DeclaredType);
                        }

                        parameters.Add(parameterEntry);
                    }

                    methodEntry["params"] = parameters;
                    methods.Add(methodEntry);
                }

                entry["methods"] = methods;
                interfaces.Add(entry);
            }

            root["interfaces"] = interfaces;
            root["enums"] = EmitEnums(models);
            return NormalizeNewLines(root.ToString(Formatting.Indented)) + "\n";
        }

        private static JArray EmitEnums(IReadOnlyList<DebugContractModel> models)
        {
            Type[] enumTypes = models
                .SelectMany(model => model.Methods)
                .SelectMany(method => method.Parameters)
                .Where(parameter => parameter.IsEnum)
                .Select(parameter => parameter.DeclaredType)
                .Distinct()
                .OrderBy(GetFullTypeName, StringComparer.Ordinal)
                .ToArray();

            var enums = new JArray();
            foreach (Type enumType in enumTypes)
            {
                var entry = new JObject();
                entry["id"] = GetFullTypeName(enumType);
                var members = new JArray();
                foreach (string name in Enum.GetNames(enumType)
                             .OrderBy(value => GetEnumMemberValue(enumType, value))
                             .ThenBy(value => value, StringComparer.Ordinal))
                {
                    var member = new JObject();
                    member["name"] = name;
                    member["value"] = GetEnumMemberValue(enumType, name);
                    members.Add(member);
                }

                entry["members"] = members;
                enums.Add(entry);
            }

            return enums;
        }

        private sealed class CodeWriter
        {
            private readonly StringBuilder _builder = new StringBuilder();
            private int _indent;

            public void Line(string text = "")
            {
                if (text.Length != 0)
                {
                    _builder.Append(' ', _indent * 4);
                    _builder.Append(text);
                }

                _builder.Append('\n');
            }

            public void Open(string text)
            {
                Line(text);
                Line("{");
                _indent++;
            }

            public void OpenBlock()
            {
                Line("{");
                _indent++;
            }

            public void Close(string text)
            {
                _indent--;
                Line(text);
            }

            public void Indent()
            {
                _indent++;
            }

            public void Outdent()
            {
                _indent--;
            }

            public override string ToString()
            {
                return _builder.ToString();
            }
        }
    }
}
