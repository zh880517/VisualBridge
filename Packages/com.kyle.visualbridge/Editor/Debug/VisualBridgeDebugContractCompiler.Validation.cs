using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeDebugContractCompiler
    {
        private const BindingFlags s_methodFlags =
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly;

        internal static DebugModelSet CreateModelSet(IReadOnlyList<Type> interfaces)
        {
            var errors = new List<string>();
            var models = new List<DebugContractModel>();

            foreach (Type type in OrderInterfaces(interfaces))
            {
                if (type == null)
                {
                    errors.Add(Diagnostic(DiagnosticNotDebugInterface, "<null>", "Type is null."));
                    continue;
                }

                string subject = type.FullName ?? type.Name;
                if (!type.IsInterface)
                {
                    errors.Add(Diagnostic(
                        DiagnosticNotDebugInterface,
                        subject,
                        "Only interfaces can be marked with [VisualBridgeDebuger]."));
                    continue;
                }

                VisualBridgeDebugerAttribute attribute = GetDebugerAttribute(type);
                if (attribute == null)
                {
                    errors.Add(Diagnostic(
                        DiagnosticNotDebugInterface,
                        subject,
                        "Interface has no [VisualBridgeDebuger] attribute."));
                    continue;
                }

                var local = new List<string>();
                if (type.IsNested)
                {
                    local.Add(Diagnostic(DiagnosticNestedType, subject, "Nested interfaces are not supported."));
                }

                if (type.IsGenericType)
                {
                    local.Add(Diagnostic(DiagnosticGenericType, subject, "Generic interfaces are not supported."));
                }

                if (!type.IsPublic)
                {
                    local.Add(Diagnostic(DiagnosticNonPublic, subject, "Interface must be public."));
                }

                if (type.GetInterfaces().Length != 0)
                {
                    local.Add(Diagnostic(
                        DiagnosticInheritedInterface,
                        subject,
                        "Interface inheritance is not supported; declare all members on the debug interface."));
                }

                if (type.GetProperties(s_methodFlags).Length != 0
                    || type.GetEvents(s_methodFlags).Length != 0)
                {
                    local.Add(Diagnostic(
                        DiagnosticNonMethodMember,
                        subject,
                        "Properties, indexers and events are not supported; use methods only."));
                }

                if (!IsValidCategory(attribute.Category))
                {
                    local.Add(Diagnostic(
                        DiagnosticInvalidCategory,
                        subject,
                        "Category '" + attribute.Category
                        + "' is not a valid file name segment."));
                }

                string directory = NormalizeGeneratedDirectory(attribute.GeneratedDirectory);
                if (directory == null)
                {
                    local.Add(Diagnostic(
                        DiagnosticMissingGeneratedDirectory,
                        subject,
                        "GeneratedDirectory is not set."));
                }
                else if (!IsValidGeneratedDirectory(directory))
                {
                    local.Add(Diagnostic(
                        DiagnosticGeneratedDirectory,
                        subject,
                        "GeneratedDirectory must be under Assets/ or Packages/."));
                }

                MethodInfo[] methods = type.GetMethods(s_methodFlags)
                    .Where(method => !method.IsSpecialName)
                    .OrderBy(method => method.MetadataToken)
                    .ToArray();

                var methodModels = new List<DebugMethodModel>(methods.Length);
                ValidateMethodNames(type, methods, local);
                foreach (MethodInfo method in methods)
                {
                    string methodSubject = subject + "/" + method.Name;
                    if (!method.ReturnType.Equals(typeof(void)))
                    {
                        local.Add(Diagnostic(
                            DiagnosticNonVoidReturn,
                            methodSubject,
                            "Debug methods must return void."));
                    }

                    if (method.IsGenericMethodDefinition || method.IsGenericMethod)
                    {
                        local.Add(Diagnostic(
                            DiagnosticGenericType,
                            methodSubject,
                            "Generic methods are not supported."));
                    }

                    List<DebugParamModel> parameters = ValidateParameters(method, methodSubject, local);
                    methodModels.Add(new DebugMethodModel(method, parameters));
                }

                ValidateInstanceParameter(attribute, methodModels, subject, local);
                ValidateFrameParameter(attribute, methodModels, subject, local);

                if (local.Count == 0)
                {
                    models.Add(new DebugContractModel(type, attribute, methodModels, directory));
                }
                else
                {
                    errors.AddRange(local);
                }
            }

            ValidateConflicts(models, errors);

            return new DebugModelSet(models, errors);
        }

        private static IEnumerable<Type> OrderInterfaces(IReadOnlyList<Type> interfaces)
        {
            if (interfaces == null)
            {
                return Array.Empty<Type>();
            }

            var seen = new HashSet<Type>();
            var ordered = new List<Type>();
            foreach (Type type in interfaces)
            {
                if (type == null)
                {
                    ordered.Add(null);
                    continue;
                }

                if (seen.Add(type))
                {
                    ordered.Add(type);
                }
            }

            return ordered
                .OrderBy(type => type == null, Comparer<bool>.Default)
                .ThenBy(type => type == null ? string.Empty : type.FullName ?? type.Name, StringComparer.Ordinal);
        }

        private static void ValidateMethodNames(Type type, MethodInfo[] methods, List<string> errors)
        {
            foreach (var group in methods.GroupBy(method => method.Name, StringComparer.Ordinal))
            {
                string methodSubject = (type.FullName ?? type.Name) + "/" + group.Key;
                if (string.IsNullOrEmpty(group.Key))
                {
                    errors.Add(Diagnostic(DiagnosticMethodName, methodSubject, "Method name is empty."));
                    continue;
                }

                if (group.Count() == 1)
                {
                    continue;
                }

                var signatures = group
                    .Select(method => string.Join(
                        ",",
                        method.GetParameters().Select(parameter => GetFullTypeName(parameter.ParameterType))))
                    .ToArray();
                bool duplicate = signatures.Distinct(StringComparer.Ordinal).Count() != signatures.Length;
                errors.Add(duplicate
                    ? Diagnostic(DiagnosticMethodName, methodSubject, "Duplicate method signature.")
                    : Diagnostic(DiagnosticOverload, methodSubject, "Method overloads are not supported."));
            }
        }

        private static List<DebugParamModel> ValidateParameters(
            MethodInfo method,
            string methodSubject,
            List<string> errors)
        {
            var result = new List<DebugParamModel>();
            var names = new HashSet<string>(StringComparer.Ordinal);
            ParameterInfo[] parameters = method.GetParameters();
            int previousTag = -1;
            for (int i = 0; i < parameters.Length; i++)
            {
                ParameterInfo parameter = parameters[i];
                string name = parameter.Name ?? "<arg" + i + ">";
                string paramSubject = methodSubject + "/" + name;

                if (IsCSharpKeyword(name))
                {
                    errors.Add(Diagnostic(
                        DiagnosticReservedName,
                        paramSubject,
                        "Parameter name '" + name + "' is a C# keyword."));
                }

                if (!names.Add(name))
                {
                    errors.Add(Diagnostic(
                        DiagnosticReservedName,
                        paramSubject,
                        "Duplicate parameter name '" + name + "'."));
                }

                var tagAttribute = (VisualBridgeDebugTagAttribute)Attribute.GetCustomAttribute(
                    parameter,
                    typeof(VisualBridgeDebugTagAttribute),
                    false);
                bool hasExplicitTag = tagAttribute != null;
                int tag;
                if (hasExplicitTag)
                {
                    tag = tagAttribute.Tag;
                    if (tag < 0 || tag <= previousTag)
                    {
                        errors.Add(Diagnostic(
                            DiagnosticTagOrder,
                            paramSubject,
                            "Explicit tag must be non-negative and greater than the previous tag."));
                    }
                }
                else
                {
                    tag = previousTag + 1;
                }

                previousTag = tag;

                bool hasModifier = parameter.ParameterType.IsByRef
                    || parameter.IsOptional
                    || parameter.GetCustomAttributes(typeof(ParamArrayAttribute), false).Length != 0;
                if (hasModifier)
                {
                    errors.Add(Diagnostic(
                        DiagnosticParameterModifier,
                        paramSubject,
                        "ref/out/in/optional/params parameters are not supported."));
                    continue;
                }

                Type parameterType = parameter.ParameterType;
                DebugParamKind kind = GetParamKind(parameterType);
                string declaredTypeName = GetDeclaredTypeName(parameterType);
                if (kind == DebugParamKind.Unsupported || declaredTypeName == null)
                {
                    errors.Add(Diagnostic(
                        DiagnosticUnsupportedParameterType,
                        paramSubject,
                        "Unsupported parameter type '" + GetFullTypeName(parameterType) + "'."));
                    continue;
                }

                result.Add(new DebugParamModel(
                    parameter,
                    i,
                    kind,
                    declaredTypeName,
                    GetWireTypeName(kind, parameterType),
                    GetContractTypeName(kind),
                    tag,
                    hasExplicitTag));
            }

            return result;
        }

        private static void ValidateInstanceParameter(
            VisualBridgeDebugerAttribute attribute,
            IReadOnlyList<DebugMethodModel> methods,
            string subject,
            List<string> errors)
        {
            string name = DebugContractModel.NormalizeParameterName(attribute.InstanceParameter);
            if (name == null)
            {
                return;
            }

            if (string.Equals(name, "label", StringComparison.Ordinal)
                || string.Equals(name, "keywords", StringComparison.Ordinal))
            {
                errors.Add(Diagnostic(
                    DiagnosticReservedName,
                    subject + "/" + name,
                    "InstanceParameter name '" + name
                    + "' is reserved by the generated DescribeInstance method."));
            }

            if (attribute.Kind == VisualBridgeDebugerKind.Query
                && (string.Equals(name, "requestId", StringComparison.Ordinal)
                    || string.Equals(name, "payload", StringComparison.Ordinal)))
            {
                errors.Add(Diagnostic(
                    DiagnosticReservedName,
                    subject + "/" + name,
                    "InstanceParameter name '" + name
                    + "' is reserved by the generated query result sender signature."));
            }

            bool found = false;
            foreach (DebugMethodModel method in methods)
            {
                DebugParamModel parameter = method.FindParameter(name);
                if (parameter == null)
                {
                    continue;
                }

                found = true;
                if (parameter.DeclaredType != typeof(string))
                {
                    errors.Add(Diagnostic(
                        DiagnosticInstanceParameter,
                        subject + "/" + name,
                        "InstanceParameter must be a string parameter."));
                }
            }

            if (!found)
            {
                errors.Add(Diagnostic(
                    DiagnosticInstanceParameter,
                    subject,
                    "InstanceParameter '" + name + "' does not exist on the interface."));
            }
        }

        private static void ValidateFrameParameter(
            VisualBridgeDebugerAttribute attribute,
            IReadOnlyList<DebugMethodModel> methods,
            string subject,
            List<string> errors)
        {
            string name = DebugContractModel.NormalizeParameterName(attribute.FrameParameter);
            if (name == null)
            {
                return;
            }

            bool found = false;
            foreach (DebugMethodModel method in methods)
            {
                DebugParamModel parameter = method.FindParameter(name);
                if (parameter == null)
                {
                    continue;
                }

                found = true;
                if (parameter.DeclaredType != typeof(int) && parameter.DeclaredType != typeof(long))
                {
                    errors.Add(Diagnostic(
                        DiagnosticFrameParameter,
                        subject + "/" + name,
                        "FrameParameter must be an int or long parameter."));
                }
            }

            if (!found)
            {
                errors.Add(Diagnostic(
                    DiagnosticFrameParameter,
                    subject,
                    "FrameParameter '" + name + "' does not exist on the interface."));
            }
        }

        private static void ValidateConflicts(
            IReadOnlyList<DebugContractModel> models,
            List<string> errors)
        {
            var classNames = new Dictionary<string, string>(StringComparer.Ordinal);
            var filePaths = new HashSet<string>(StringComparer.Ordinal);
            foreach (DebugContractModel model in models
                         .OrderBy(value => value.FullName, StringComparer.Ordinal))
            {
                string classKey = model.Namespace + "." + model.ClassName;
                string existing;
                if (classNames.TryGetValue(classKey, out existing))
                {
                    errors.Add(Diagnostic(
                        DiagnosticClassNameConflict,
                        model.FullName,
                        "Generated class '" + classKey + "' conflicts with '" + existing + "'."));
                }
                else
                {
                    classNames.Add(classKey, model.FullName);
                }

                AddFile(filePaths, model, model.FacadeFileName, errors);
                AddFile(filePaths, model, model.ImplementationFileName, errors);
                if (model.IsQuery)
                {
                    AddFile(filePaths, model, model.DispatcherFileName, errors);
                }
            }
        }

        private static void AddFile(
            ISet<string> paths,
            DebugContractModel model,
            string fileName,
            List<string> errors)
        {
            string path = model.GeneratedDirectory + "/" + fileName;
            if (!paths.Add(path))
            {
                errors.Add(Diagnostic(
                    DiagnosticClassNameConflict,
                    model.FullName,
                    "Generated file '" + path + "' conflicts with another interface."));
            }
        }
    }
}
