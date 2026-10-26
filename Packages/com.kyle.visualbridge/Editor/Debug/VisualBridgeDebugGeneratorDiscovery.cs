using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 反射扫描 <c>[VisualBridgeDebuger]</c> 接口并构造成生成模型（附录 B.5）。
    /// 本层做输入合法性校验（VBDBG012/013/014、参数类型、接口形状）与参数号归一化：显式
    /// <c>[VisualBridgeDebugTag]</c> 优先，未标记的载荷参数按声明顺序从 1 起自动分配；方法号由号分配器随后填入。
    /// </summary>
    internal static class VisualBridgeDebugGeneratorDiscovery
    {
        private const int MaxParameterNameLength = 64;     // 附录 B.2：PushParam 的 name ≤ 64
        private const int MaxCategoryLength = 64;

        /// <summary>
        /// 发现全部带特性的接口；按完整名排序，与程序集加载顺序无关。
        /// 测试程序集（名称以 <c>.Tests</c> / <c>-Tests</c> 结尾）不参与发现：
        /// 调试契约必须由业务程序集声明，否则测试夹具会污染批量生成。
        /// </summary>
        public static IReadOnlyList<Type> DiscoverInterfaces()
        {
            var discovered = new List<Type>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (assembly.IsDynamic || IsTestAssembly(assembly))
                {
                    continue;
                }

                Type[] types;
                try
                {
                    types = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException exception)
                {
                    types = exception.Types.Where(type => type != null).ToArray();
                }
                catch (Exception)
                {
                    // 无法反射的程序集不参与扫描；契约接口必须能被正常反射到。
                    continue;
                }

                foreach (var type in types)
                {
                    if (type == null || !type.IsInterface)
                    {
                        continue;
                    }

                    if (type.GetCustomAttribute<VisualBridgeDebugerAttribute>(false) == null)
                    {
                        continue;
                    }

                    discovered.Add(type);
                }
            }

            return discovered
                .Distinct()
                .OrderBy(VisualBridgeDebugTypeMapping.FullName, StringComparer.Ordinal)
                .ToArray();
        }

        /// <summary>
        /// 明确的测试程序集判定：程序集名的 <c>.Tests</c> / <c>-Tests</c> 后缀（Unity 测试 asmdef 的默认命名，
        /// 也覆盖 Unity 自动生成的 <c>Assembly-CSharp-Editor-Tests</c>）。不做「引用了 nunit 就跳过」这种宽推断，
        /// 避免误伤同时含业务契约的程序集。
        /// </summary>
        private static bool IsTestAssembly(Assembly assembly)
        {
            var name = assembly.GetName().Name;
            if (string.IsNullOrEmpty(name))
            {
                return false;
            }

            return name.EndsWith(".Tests", StringComparison.OrdinalIgnoreCase)
                || name.EndsWith("-Tests", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>把接口集合构造成确定性模型；任何非法输入都以生成器异常失败。</summary>
        public static VisualBridgeDebugDefinitionModel BuildDefinition(IReadOnlyList<Type> interfaces, string projectRoot)
        {
            var types = (interfaces ?? DiscoverInterfaces())
                .Where(type => type != null)
                .Distinct()
                .OrderBy(VisualBridgeDebugTypeMapping.FullName, StringComparer.Ordinal)
                .ToArray();

            var interfaceModels = types.Select(type => BuildInterface(type, projectRoot)).ToArray();
            return new VisualBridgeDebugDefinitionModel(BuildCategories(interfaceModels), BuildEnums(interfaceModels));
        }

        private static VisualBridgeDebugInterfaceModel BuildInterface(Type type, string projectRoot)
        {
            var attribute = type.GetCustomAttribute<VisualBridgeDebugerAttribute>(false);
            if (attribute == null)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.interfaceNotDecorated",
                    "接口没有 [VisualBridgeDebuger]：" + VisualBridgeDebugTypeMapping.FullName(type));
            }

            if (type.IsGenericTypeDefinition)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.genericInterfaceUnsupported",
                    "调试接口不能是泛型定义：" + VisualBridgeDebugTypeMapping.FullName(type));
            }

            if (!type.IsVisible)
            {
                // 生成的门面/实现是 public，引用 internal 接口会 CS0050/CS0051 不可编译。
                throw new VisualBridgeDebugGeneratorException(
                    "debug.interfaceNotVisible",
                    "调试接口必须是 public（含外层类型）：" + VisualBridgeDebugTypeMapping.FullName(type));
            }

            var inheritedWithMethods = type.GetInterfaces()
                .Where(value => value.GetMethods(BindingFlags.Public | BindingFlags.Instance).Length != 0)
                .Select(VisualBridgeDebugTypeMapping.FullName)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray();
            if (inheritedWithMethods.Length != 0)
            {
                // 生成器只发射接口自身声明的方法；继承来的方法要么不生成（漏契约），要么重名（重复生成）。
                throw new VisualBridgeDebugGeneratorException(
                    "debug.inheritedInterfaceUnsupported",
                    "调试接口 " + VisualBridgeDebugTypeMapping.FullName(type)
                    + " 继承的接口声明了方法，生成器只处理本接口自身声明的方法："
                    + string.Join(", ", inheritedWithMethods)
                    + "。请把方法移到本接口，或对基接口单独标注 [VisualBridgeDebuger]。");
            }

            var category = attribute.Category;
            ValidateCategory(category, type);

            if (string.IsNullOrWhiteSpace(attribute.GeneratedDirectory))
            {
                // 附录 B.5/B.1：GeneratedDirectory 必填、没有隐式默认（配置里的默认值不能回退）。
                throw new VisualBridgeDebugGeneratorException(
                    "VBDBG013",
                    "接口 " + VisualBridgeDebugTypeMapping.FullName(type)
                    + " 没有设置 [VisualBridgeDebuger(..., GeneratedDirectory = \"Assets/...\")]。");
            }

            var generatedDirectory = VisualBridgeDebugGeneratorPaths.NormalizeProjectRelative(
                projectRoot,
                attribute.GeneratedDirectory,
                "VBDBG011");

            var methods = type
                .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Select(method => BuildMethod(type, attribute.Kind, method))
                .OrderBy(method => method.Name, StringComparer.Ordinal)
                .ToArray();

            return new VisualBridgeDebugInterfaceModel(
                type,
                VisualBridgeDebugTypeMapping.FullName(type),
                category,
                attribute.Kind,
                generatedDirectory,
                ClassNameOf(type),
                type.Namespace ?? string.Empty,
                methods);
        }

        private static VisualBridgeDebugMethodModel BuildMethod(Type interfaceType, VisualBridgeDebugerKind kind, MethodInfo method)
        {
            if (method.IsSpecialName)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.methodSpecialNameUnsupported",
                    "调试接口 " + interfaceType.Name + " 不能声明属性或事件访问器：" + method.Name);
            }

            if (method.IsGenericMethodDefinition)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.genericMethodUnsupported",
                    "调试接口 " + interfaceType.Name + " 的方法 " + method.Name + " 不能是泛型方法。");
            }

            var models = new List<VisualBridgeDebugParameterModel>();
            var payloadNames = new HashSet<string>(StringComparer.Ordinal);
            var instanceCandidates = new List<int>();
            VisualBridgeDebugParameterModel requestParameter = null;

            var declared = method.GetParameters();
            for (var index = 0; index < declared.Length; index++)
            {
                var parameter = declared[index];
                if (parameter.ParameterType.IsByRef)
                {
                    throw ParameterError(interfaceType, method, parameter, "不支持 ref/out/in 参数");
                }

                var isInstance = parameter.GetCustomAttribute<VisualBridgeDebugInstanceAttribute>(false) != null;
                var isRequest = kind == VisualBridgeDebugerKind.Query
                    && parameter.ParameterType == typeof(VisualBridgeDebugRequest);

                if (kind == VisualBridgeDebugerKind.Query && isInstance)
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.queryInstanceNotAllowed",
                        "Query 接口 " + interfaceType.Name + " 的方法 " + method.Name
                        + " 不应声明 [VisualBridgeDebugInstance] 参数：实例 id 由 VisualBridgeDebugRequest.InstanceId 提供。");
                }

                if (isRequest)
                {
                    if (requestParameter != null)
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.queryRequestDuplicate",
                            "Query 接口 " + interfaceType.Name + " 的方法 " + method.Name
                            + " 只能有一个 VisualBridgeDebugRequest 参数。");
                    }

                    if (index != 0)
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.queryRequestNotFirst",
                            "Query 接口 " + interfaceType.Name + " 的方法 " + method.Name
                            + " 的 VisualBridgeDebugRequest 必须是第一个参数。");
                    }

                    requestParameter = new VisualBridgeDebugParameterModel(
                        parameter.Name ?? string.Empty,
                        parameter.ParameterType,
                        "VisualBridgeDebugRequest",
                        0,
                        false,
                        true,
                        false,
                        VisualBridgeDebugValueKind.String,
                        null,
                        null,
                        null,
                        false);
                    models.Add(requestParameter);
                    continue;
                }

                if (!VisualBridgeDebugTypeMapping.TryDescribe(
                        parameter.ParameterType,
                        out var valueKind,
                        out var contractType,
                        out var castType,
                        out var tsType))
                {
                    throw ParameterError(
                        interfaceType,
                        method,
                        parameter,
                        "不支持的参数类型 " + VisualBridgeDebugTypeMapping.FullName(parameter.ParameterType));
                }

                var name = parameter.Name ?? string.Empty;
                if (name.Length > MaxParameterNameLength)
                {
                    throw ParameterError(
                        interfaceType,
                        method,
                        parameter,
                        "参数名超过 " + MaxParameterNameLength.ToString(CultureInfo.InvariantCulture) + " 个字符");
                }

                if (!payloadNames.Add(name))
                {
                    throw ParameterError(interfaceType, method, parameter, "参数名重复");
                }

                var hasExplicitTag = parameter.IsDefined(typeof(VisualBridgeDebugTagAttribute), false);
                var tag = hasExplicitTag ? TagOf(parameter) : (ushort)0;

                if (isInstance)
                {
                    if (parameter.ParameterType != typeof(string))
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "VBDBG012",
                            "Event 接口 " + interfaceType.Name + " 的方法 " + method.Name
                            + " 的 [VisualBridgeDebugInstance] 参数必须是 string，实际是 "
                            + VisualBridgeDebugTypeMapping.FullName(parameter.ParameterType) + "。");
                    }

                    instanceCandidates.Add(models.Count);
                }

                models.Add(new VisualBridgeDebugParameterModel(
                    name,
                    parameter.ParameterType,
                    contractType,
                    tag,
                    isInstance,
                    false,
                    parameter.HasDefaultValue,
                    valueKind,
                    castType,
                    tsType,
                    parameter.HasDefaultValue ? parameter.DefaultValue : null,
                    parameter.HasDefaultValue)
                {
                    HasExplicitTag = hasExplicitTag,
                });
            }

            VisualBridgeDebugParameterModel instanceParameter = null;
            if (kind == VisualBridgeDebugerKind.Event)
            {
                instanceParameter = ResolveInstanceParameter(interfaceType, method, models, instanceCandidates);
                if (instanceParameter == null)
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "VBDBG012",
                        "Event 接口 " + interfaceType.Name + " 的方法 " + method.Name
                        + " 必须恰好有一个 string 实例参数：优先用 [VisualBridgeDebugInstance]，"
                        + "否则按名为 instanceId 的唯一 string 参数识别。");
                }

                if (method.ReturnType != typeof(bool))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.methodReturnTypeInvalid",
                        "Event 接口 " + interfaceType.Name + " 的方法 " + method.Name
                        + " 必须返回 bool（false = 消息未入队），实际是 "
                        + VisualBridgeDebugTypeMapping.FullName(method.ReturnType) + "。");
                }
            }
            else if (requestParameter == null)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.queryRequestMissing",
                    "Query 接口 " + interfaceType.Name + " 的方法 " + method.Name
                    + " 的第一个参数必须是 VisualBridgeDebugRequest（生成的 Dispatcher 用它回发结果）。");
            }

            var resultIsVoid = method.ReturnType == typeof(void);
            VisualBridgeDebugParameterModel resultParameter = null;
            string resultContractType;
            if (kind == VisualBridgeDebugerKind.Query && !resultIsVoid)
            {
                if (!VisualBridgeDebugTypeMapping.TryDescribe(
                        method.ReturnType,
                        out var resultKind,
                        out var resultContract,
                        out var resultCast,
                        out var resultTs))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.resultTypeUnsupported",
                        "Query 接口 " + interfaceType.Name + " 的方法 " + method.Name
                        + " 的返回类型不受支持：" + VisualBridgeDebugTypeMapping.FullName(method.ReturnType));
                }

                resultParameter = new VisualBridgeDebugParameterModel(
                    "result",
                    method.ReturnType,
                    resultContract,
                    0,
                    false,
                    false,
                    false,
                    resultKind,
                    resultCast,
                    resultTs,
                    null,
                    false);
                resultContractType = resultContract;
            }
            else
            {
                resultContractType = kind == VisualBridgeDebugerKind.Event ? "bool" : "void";
            }

            // 实例参数已在上面标好，剩下的才是载荷参数；自动 tag 只分配给它们。
            AssignPayloadTags(interfaceType, method, models);

            return new VisualBridgeDebugMethodModel(
                method.Name,
                models,
                instanceParameter,
                requestParameter,
                resultParameter,
                resultContractType,
                resultIsVoid);
        }

        /// <summary>
        /// 参数号规则（附录 B.2/A.4 的稀疏参数区）：显式 <c>[VisualBridgeDebugTag]</c> 优先且必须互不相同；
        /// 未标记的载荷参数按声明顺序从 1 起分配，跳过显式占用的号。0 只留给系统字段与查询结果。
        /// 接收端按 tag 匹配契约声明，重复 tag 会让两个参数无法区分。
        /// </summary>
        private static void AssignPayloadTags(
            Type interfaceType,
            MethodInfo method,
            IReadOnlyList<VisualBridgeDebugParameterModel> models)
        {
            var payload = models.Where(model => model.IsPayload).ToArray();
            var used = new HashSet<ushort>();
            foreach (var parameter in payload.Where(value => value.HasExplicitTag))
            {
                if (!used.Add(parameter.Tag))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.tagDuplicate",
                        "接口 " + interfaceType.Name + " 的方法 " + method.Name + " 有重复的参数 tag："
                        + parameter.Tag.ToString(CultureInfo.InvariantCulture)
                        + "。显式 tag 之间、显式与自动分配之间都必须唯一。");
                }
            }

            var next = 1;
            foreach (var parameter in payload.Where(value => !value.HasExplicitTag))
            {
                while (next <= ushort.MaxValue && used.Contains((ushort)next))
                {
                    next++;
                }

                if (next > ushort.MaxValue)
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.tagExhausted",
                        "接口 " + interfaceType.Name + " 的方法 " + method.Name + " 的载荷参数过多，参数号已耗尽。");
                }

                parameter.Tag = (ushort)next;
                used.Add((ushort)next);
            }
        }

        /// <summary>附录 B.5：优先 [VisualBridgeDebugInstance]，否则取名为 instanceId 的唯一 string 参数。</summary>
        private static VisualBridgeDebugParameterModel ResolveInstanceParameter(
            Type interfaceType,
            MethodInfo method,
            IReadOnlyList<VisualBridgeDebugParameterModel> models,
            IReadOnlyList<int> attributed)
        {
            if (attributed.Count > 1)
            {
                throw new VisualBridgeDebugGeneratorException(
                    "VBDBG012",
                    "Event 接口 " + interfaceType.Name + " 的方法 " + method.Name
                    + " 声明了多个 [VisualBridgeDebugInstance] 参数。");
            }

            if (attributed.Count == 1)
            {
                var instance = models[attributed[0]];
                instance.IsInstance = true;
                return instance;
            }

            var named = models
                .Where(model => !model.IsRequest
                    && model.DeclaredType == typeof(string)
                    && string.Equals(model.Name, "instanceId", StringComparison.Ordinal))
                .ToArray();
            if (named.Length != 1)
            {
                return null;
            }

            named[0].IsInstance = true;
            return named[0];
        }

        private static VisualBridgeDebugCategoryModel[] BuildCategories(IReadOnlyList<VisualBridgeDebugInterfaceModel> interfaces)
        {
            var categories = new List<VisualBridgeDebugCategoryModel>();
            var protocolNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var group in interfaces
                         .GroupBy(value => value.Category, StringComparer.Ordinal)
                         .OrderBy(group => group.Key, StringComparer.Ordinal))
            {
                var directories = group
                    .Select(value => value.GeneratedDirectory)
                    .Distinct(VisualBridgeDebugGeneratorPaths.FilePathComparer)
                    .ToArray();
                if (directories.Length != 1)
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.categoryDirectoryMismatch",
                        "分类 " + group.Key + " 的接口必须共用同一个 GeneratedDirectory，实际有："
                        + string.Join(", ", directories));
                }

                var fileBase = PascalCase(group.Key);
                var typeName = fileBase + "Protocol";
                string existingCategory;
                if (protocolNames.TryGetValue(typeName, out existingCategory))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.categoryNameCollision",
                        "分类 " + group.Key + " 与 " + existingCategory + " 会生成同名类型 " + typeName + "（大小写不敏感）。");
                }

                protocolNames.Add(typeName, group.Key);

                var methodNames = new HashSet<string>(StringComparer.Ordinal);
                foreach (var method in group.SelectMany(value => value.Methods))
                {
                    if (!methodNames.Add(method.Name))
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "VBDBG014",
                            "分类 " + group.Key + " 内方法重名：" + method.Name + "（同分类方法共用一个方法号命名空间）。");
                    }
                }

                categories.Add(new VisualBridgeDebugCategoryModel(
                    group.Key,
                    typeName,
                    fileBase,
                    directories[0],
                    group.OrderBy(value => value.InterfaceFullName, StringComparer.Ordinal).ToArray()));
            }

            // 生成类名在同一个生成目录内必须唯一（不同命名空间的同名接口会抢同名文件）。
            var generatedNames = new Dictionary<string, string>(VisualBridgeDebugGeneratorPaths.FilePathComparer);
            // 同一命名空间下即使目录不同，生成的类也是同一程序集里的同名类型，同样不允许。
            var generatedTypes = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var model in categories.SelectMany(category => category.Interfaces))
            {
                var key = model.GeneratedDirectory + "/" + model.ClassName;
                string existing;
                if (generatedNames.TryGetValue(key, out existing))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.generatedNameCollision",
                        "生成目录 " + model.GeneratedDirectory + " 内有两个接口生成同一个类名 " + model.ClassName
                        + "：" + existing + " 与 " + model.InterfaceFullName);
                }

                generatedNames.Add(key, model.InterfaceFullName);

                var typeKey = model.GeneratedNamespace + "." + model.ClassName;
                if (generatedTypes.TryGetValue(typeKey, out existing))
                {
                    throw new VisualBridgeDebugGeneratorException(
                        "debug.generatedNameCollision",
                        "命名空间 " + model.GeneratedNamespace + " 内有两个接口生成同一个类 " + model.ClassName
                        + "：" + existing + " 与 " + model.InterfaceFullName);
                }

                generatedTypes.Add(typeKey, model.InterfaceFullName);
            }

            return categories.ToArray();
        }

        private static VisualBridgeDebugEnumModel[] BuildEnums(IReadOnlyList<VisualBridgeDebugInterfaceModel> interfaces)
        {
            var enumTypes = new Dictionary<string, Type>(StringComparer.Ordinal);
            foreach (var method in interfaces.SelectMany(value => value.Methods))
            {
                foreach (var parameter in method.PayloadParameters.Where(
                             parameter => parameter.Kind == VisualBridgeDebugValueKind.Enum))
                {
                    enumTypes[VisualBridgeDebugTypeMapping.FullName(parameter.DeclaredType)] = parameter.DeclaredType;
                }

                if (method.ResultParameter != null && method.ResultParameter.Kind == VisualBridgeDebugValueKind.Enum)
                {
                    enumTypes[VisualBridgeDebugTypeMapping.FullName(method.ResultParameter.DeclaredType)] =
                        method.ResultParameter.DeclaredType;
                }
            }

            var enums = new List<VisualBridgeDebugEnumModel>();
            foreach (var pair in enumTypes.OrderBy(value => value.Key, StringComparer.Ordinal))
            {
                var members = new List<KeyValuePair<string, long>>();
                foreach (var member in pair.Value.GetFields(BindingFlags.Public | BindingFlags.Static))
                {
                    if (!member.IsLiteral)
                    {
                        continue;
                    }

                    long value;
                    try
                    {
                        value = Convert.ToInt64(member.GetRawConstantValue(), CultureInfo.InvariantCulture);
                    }
                    catch (Exception exception) when (exception is OverflowException || exception is InvalidCastException)
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.enumValueUnsupported",
                            "枚举 " + pair.Key + " 的成员 " + member.Name + " 超出契约 hash 能表示的 64 位有符号整数范围。");
                    }

                    members.Add(new KeyValuePair<string, long>(member.Name, value));
                }

                members.Sort((left, right) =>
                {
                    var byValue = left.Value.CompareTo(right.Value);
                    return byValue != 0 ? byValue : string.CompareOrdinal(left.Key, right.Key);
                });

                enums.Add(new VisualBridgeDebugEnumModel(
                    pair.Key,
                    VisualBridgeDebugTypeMapping.CSharpTypeName(Enum.GetUnderlyingType(pair.Value)),
                    VisualBridgeDebugTypeMapping.TsEnumName(pair.Key),
                    members));
            }

            return enums.ToArray();
        }

        private static void ValidateCategory(string category, Type type)
        {
            if (string.IsNullOrEmpty(category)
                || category.Length > MaxCategoryLength
                || !char.IsLetter(category[0])
                || category.Any(character => character >= 128 || (!char.IsLetterOrDigit(character) && character != '_')))
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.categoryInvalid",
                    "接口 " + VisualBridgeDebugTypeMapping.FullName(type)
                    + " 的分类名非法（要求 1–" + MaxCategoryLength.ToString(CultureInfo.InvariantCulture)
                    + " 个 ASCII 字母/数字/下划线且以字母开头）：" + (category ?? "<null>"));
            }
        }

        private static string ClassNameOf(Type type)
        {
            var name = type.Name;
            if (name.Length > 1 && name[0] == 'I' && char.IsUpper(name[1]))
            {
                name = name.Substring(1);
            }

            if (name.Length == 0
                || !char.IsLetter(name[0])
                || name.Any(character => character >= 128 || (!char.IsLetterOrDigit(character) && character != '_')))
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.interfaceNameInvalid",
                    "接口名去 I 后不是合法的 C# 类名：" + type.Name);
            }

            return name;
        }

        private static string PascalCase(string value)
        {
            return char.ToUpperInvariant(value[0]) + value.Substring(1);
        }

        private static ushort TagOf(ParameterInfo parameter)
        {
            var attribute = parameter.GetCustomAttribute<VisualBridgeDebugTagAttribute>(false);
            return attribute == null ? (ushort)0 : attribute.Tag;
        }

        private static VisualBridgeDebugGeneratorException ParameterError(
            Type interfaceType,
            MethodInfo method,
            ParameterInfo parameter,
            string reason)
        {
            return new VisualBridgeDebugGeneratorException(
                "debug.parameterInvalid",
                "接口 " + interfaceType.Name + " 的方法 " + method.Name + " 的参数 " + parameter.Name + "：" + reason);
        }
    }
}
