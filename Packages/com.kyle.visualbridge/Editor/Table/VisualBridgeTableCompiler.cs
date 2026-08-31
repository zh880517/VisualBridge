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
    public enum VisualBridgeTableCompileMode
    {
        Generate,
        Check,
    }

    public sealed class VisualBridgeTableCompileOutput
    {
        internal VisualBridgeTableCompileOutput(string path, string expectedSha256, string previousSha256, bool changed)
        {
            Path = path;
            ExpectedSha256 = expectedSha256;
            PreviousSha256 = previousSha256;
            Changed = changed;
        }

        public string Path { get; }

        public string ExpectedSha256 { get; }

        public string PreviousSha256 { get; }

        public bool Changed { get; }
    }

    public sealed class VisualBridgeTableCompileResult
    {
        internal VisualBridgeTableCompileResult(
            VisualBridgeTableCompileMode mode,
            IReadOnlyList<VisualBridgeTableCompileOutput> outputs,
            IReadOnlyList<string> staleOutputs)
        {
            Mode = mode;
            Outputs = outputs;
            StaleOutputs = staleOutputs;
        }

        public VisualBridgeTableCompileMode Mode { get; }

        public IReadOnlyList<VisualBridgeTableCompileOutput> Outputs { get; }

        public IReadOnlyList<string> StaleOutputs { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed) || StaleOutputs.Count != 0;
    }

    /// <summary>
    /// Table Compiler：把 CSV family 文档按 Document Type 聚合编译成确定性产物、source mapping 与独立
    /// manifest（manifest.table.json）。Table 是纯消费方——无 Exporter，table catalog 以提交文件为准；
    /// 消费语义（nameKey 列映射、cell encoding、key column、跨分区去重）镜像 VS Code 侧权威实现。
    /// 序列化、Hash 与原子提交复用 Structured Compiler。
    /// </summary>
    public static class VisualBridgeTableCompiler
    {
        private const string ArtifactKind = "visualbridge.table.compiled";
        private const string MappingKind = "visualbridge.table.sourceMapping";
        private const string ManifestKind = "visualbridge.table.compileManifest";
        // 独立于 Structured/Entity 的 manifest，各编译器不得互相覆盖托管清单。
        private const string ManifestFileName = "manifest.table.json";

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly JObject ScalarEncoding = new JObject { ["kind"] = "scalar" };
        private static readonly JObject JsonEncoding = new JObject { ["kind"] = "json" };

        public static VisualBridgeTableCompileResult Compile(string unityProjectRoot, VisualBridgeTableCompileMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            VisualBridgeStructuredCompiler.RequireFrozenOutputRoot(profile);
            VisualBridgeStructuredCompiler.RejectOutputAlias(profile.CompileOutputRoot);

            var project = VisualBridgeAuthoringProjectParser.Parse(profile.AuthoringProjectPath);
            var inputSnapshots = new Dictionary<string, VisualBridgeStructuredCompiler.InputSnapshot>(VisualBridgeStructuredCompiler.FilePathComparer);
            VisualBridgeStructuredCompiler.AddInput(inputSnapshots, profile.ProfilePath);
            VisualBridgeStructuredCompiler.AddInput(inputSnapshots, profile.AuthoringProjectPath);

            var registry = BuildRegistry(project, inputSnapshots);
            var routedDocuments = DiscoverDocuments(project, registry.Routes);
            var routedFiles = new List<RoutedFile>();
            foreach (var document in routedDocuments.OrderBy(value => value.RelativePath, StringComparer.Ordinal))
            {
                var bytes = VisualBridgeStructuredCompiler.ReadInputBytes(document.FullPath);
                var hash = VisualBridgeStructuredCompiler.HashBytes(bytes);
                VisualBridgeStructuredCompiler.AddInput(inputSnapshots, document.FullPath, bytes, hash);
                routedFiles.Add(new RoutedFile(document, bytes, hash));
            }

            var plans = new List<VisualBridgeStructuredCompiler.OutputPlan>();
            foreach (var route in registry.Routes.Values.OrderBy(value => value.DocumentType.Id, StringComparer.Ordinal))
            {
                plans.AddRange(BuildRouteOutputs(
                    profile,
                    project,
                    route,
                    routedFiles.Where(value => value.Route == route).ToArray(),
                    inputSnapshots));
            }

            plans = plans.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToList();
            VisualBridgeStructuredCompiler.RejectDuplicateOutputPaths(plans);
            var manifest = BuildManifest(profile, project, plans, inputSnapshots);
            plans.Add(manifest);
            plans = plans.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToList();

            VisualBridgeStructuredCompiler.RejectOutputAlias(VisualBridgeStructuredCompiler.ResolveOutputPath(profile.CompileOutputRoot, ManifestFileName));
            var previousManagedPaths = ReadPreviousManagedPaths(profile.CompileOutputRoot);
            var nextManagedPaths = new HashSet<string>(
                plans.Where(value => value.RelativePath != ManifestFileName).Select(value => value.RelativePath),
                StringComparer.Ordinal);
            var stalePaths = previousManagedPaths
                .Where(path => !nextManagedPaths.Contains(path))
                .Select(path => VisualBridgeStructuredCompiler.ResolveOutputPath(profile.CompileOutputRoot, path))
                .Where(File.Exists)
                .OrderBy(path => path, VisualBridgeStructuredCompiler.FilePathComparer)
                .ToArray();
            foreach (var stalePath in stalePaths)
            {
                VisualBridgeStructuredCompiler.RejectOutputAlias(stalePath);
            }

            var outputs = plans.Select(plan =>
            {
                VisualBridgeStructuredCompiler.RejectOutputAlias(plan.FullPath);
                var previousBytes = File.Exists(plan.FullPath) ? File.ReadAllBytes(plan.FullPath) : null;
                var previousHash = previousBytes == null ? null : VisualBridgeStructuredCompiler.HashBytes(previousBytes);
                return new VisualBridgeTableCompileOutput(
                    plan.FullPath,
                    plan.Hash,
                    previousHash,
                    previousBytes == null || !previousBytes.SequenceEqual(plan.Bytes));
            }).ToArray();

            VisualBridgeStructuredCompiler.VerifyInputs(inputSnapshots.Values);
            if (mode == VisualBridgeTableCompileMode.Generate && (outputs.Any(output => output.Changed) || stalePaths.Length != 0))
            {
                // 事务接口以 Structured 输出为载体，仅传递基线 Hash 与变更标记。
                var transactionOutputs = plans
                    .Zip(outputs, (plan, output) => new VisualBridgeStructuredCompileOutput(
                        plan.FullPath,
                        output.ExpectedSha256,
                        output.PreviousSha256,
                        output.Changed))
                    .ToArray();
                VisualBridgeStructuredCompiler.CommitTransaction(
                    profile.CompileOutputRoot,
                    plans,
                    transactionOutputs,
                    stalePaths,
                    inputSnapshots.Values);
            }

            return new VisualBridgeTableCompileResult(mode, outputs, stalePaths);
        }

        private static Registry BuildRegistry(
            VisualBridgeAuthoringProject project,
            IDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            var tableDocumentTypes = project.DocumentTypes.Where(value => value.Editor == "table").ToArray();
            if (tableDocumentTypes.Length != 0 && project.TableLayout == null)
            {
                throw Error("compile.tableLayoutMissing", "$.tableLayout", "Authoring Project must declare tableLayout for Table Document Types.");
            }

            // Table 无 Exporter：catalog 不在 profile 导出闭包中，以提交文件为准（严格解析 + 校验）。
            var catalogByPath = new Dictionary<string, CatalogDescriptor>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var documentType in tableDocumentTypes)
            {
                foreach (var catalogRelativePath in documentType.Catalogs)
                {
                    var catalogPath = VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalogRelativePath, documentType.Id + ".catalogs");
                    if (!File.Exists(catalogPath))
                    {
                        throw Error("compile.catalogNotFound", catalogRelativePath, "Table Catalog does not exist.");
                    }

                    if (!catalogByPath.ContainsKey(catalogPath))
                    {
                        var bytes = VisualBridgeStructuredCompiler.ReadInputBytes(catalogPath);
                        var hash = VisualBridgeStructuredCompiler.HashBytes(bytes);
                        var catalog = VisualBridgeIntegrationProfileLoader.ReadStrictObject(catalogPath, "compile.tableCatalogInvalidJson");
                        VisualBridgeTableCatalogValidator.Validate(catalog);
                        catalogByPath.Add(catalogPath, new CatalogDescriptor(catalogRelativePath, catalogPath, hash, catalog));
                        VisualBridgeStructuredCompiler.AddInput(inputs, catalogPath, bytes, hash);
                    }
                }
            }

            var routes = new Dictionary<string, RouteDescriptor>(StringComparer.Ordinal);
            foreach (var documentType in tableDocumentTypes)
            {
                var catalogs = documentType.Catalogs
                    .Select(relative => catalogByPath[VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relative, documentType.Id + ".catalogs")])
                    .OrderBy(value => value.RelativePath, StringComparer.Ordinal)
                    .ToArray();
                routes.Add(documentType.Id, new RouteDescriptor(documentType, ResolveTableType(catalogs, documentType.Id), catalogs));
            }

            return new Registry(routes);
        }

        private static JObject ResolveTableType(IReadOnlyList<CatalogDescriptor> catalogs, string identity)
        {
            var matches = catalogs
                .SelectMany(catalog => ((JArray)catalog.Root["tableTypes"]).Cast<JObject>())
                .Where(definition => MatchesIdentity(definition, identity))
                .ToArray();
            if (matches.Length == 0)
            {
                throw Error("compile.tableTypeUnknown", identity, "Identity does not resolve to a Table Type declared by the Document Type Catalogs.");
            }

            if (matches.Length != 1)
            {
                throw Error("compile.tableTypeAmbiguous", identity, "Identity resolves to multiple Table Types declared by the Document Type Catalogs.");
            }

            return matches[0];
        }

        private static bool MatchesIdentity(JObject definition, string identity)
        {
            if (string.Equals(definition.Value<string>("id"), identity, StringComparison.Ordinal))
            {
                return true;
            }

            return definition["aliases"] is JArray aliases && aliases.Values<string>().Contains(identity, StringComparer.Ordinal);
        }

        private static IReadOnlyList<RoutedDocument> DiscoverDocuments(
            VisualBridgeAuthoringProject project,
            IReadOnlyDictionary<string, RouteDescriptor> routes)
        {
            var discovered = new HashSet<string>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var relativeRoot in project.DocumentRoots.OrderBy(value => value, StringComparer.Ordinal))
            {
                var fullRoot = relativeRoot == "."
                    ? project.RootPath
                    : VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relativeRoot, "$.documentRoots");
                if (!Directory.Exists(fullRoot))
                {
                    throw Error("compile.documentRootNotFound", relativeRoot, "Document root does not exist.");
                }

                VisualBridgeStructuredCompiler.EnumerateFilesStrict(project.RootPath, fullRoot, discovered);
            }

            var result = new List<RoutedDocument>();
            foreach (var fullPath in discovered.OrderBy(value => value, VisualBridgeStructuredCompiler.FilePathComparer))
            {
                var relativePath = VisualBridgeStructuredCompiler.RelativePathInside(project.RootPath, fullPath, "document");
                if (!VisualBridgeAuthoringProjectParser.IsInsideDocumentRoots(project, relativePath))
                {
                    throw Error("compile.documentOutsideRoot", relativePath, "Discovered document is outside declared document roots.");
                }

                var matches = project.DocumentTypes
                    .Where(documentType => VisualBridgeAuthoringProjectParser.Matches(documentType, relativePath))
                    .ToArray();
                if (matches.Length == 0)
                {
                    continue;
                }

                if (matches.Length != 1)
                {
                    throw Error(
                        "compile.ambiguousRoute",
                        relativePath,
                        "Document matches multiple Document Types: " + string.Join(", ", matches.Select(value => value.Id).OrderBy(value => value, StringComparer.Ordinal)));
                }

                if (matches[0].Editor != "table")
                {
                    continue;
                }

                if (!routes.TryGetValue(matches[0].Id, out var route))
                {
                    throw Error("compile.tableTypeUnknown", matches[0].Id, "Table route has no registered Table Type.");
                }

                if (string.Equals(Path.GetExtension(fullPath), ".xlsx", StringComparison.OrdinalIgnoreCase))
                {
                    throw Error("table.xlsxUnsupported", relativePath, "XLSX workbooks are not supported; export the sheet family as CSV.");
                }

                result.Add(new RoutedDocument(fullPath, relativePath, route));
            }

            return result;
        }

        private static IEnumerable<VisualBridgeStructuredCompiler.OutputPlan> BuildRouteOutputs(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            RouteDescriptor route,
            IReadOnlyList<RoutedFile> files,
            IReadOnlyDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            var layout = project.TableLayout;
            var delimiter = route.TableType["csv"] is JObject csv ? csv.Value<string>("delimiter") : ",";
            var physicalSheets = new List<PhysicalSheet>();
            foreach (var file in files)
            {
                var records = ParseCsv(file.Bytes, delimiter, file.RelativePath);
                if (records.Count < layout.NameKeyRow)
                {
                    throw Error(
                        "table.missingNameKeyRow",
                        file.RelativePath,
                        $"CSV does not contain configured name-key row {layout.NameKeyRow}.");
                }

                var physicalName = Path.GetFileNameWithoutExtension(file.FullPath);
                var sheetMatches = ((JArray)route.TableType["sheets"]).Cast<JObject>()
                    .Where(sheet => MatchesSheetDefinition(sheet, physicalName))
                    .ToArray();
                if (sheetMatches.Length == 0)
                {
                    // 不匹配任何 sheet definition 的文件不属于该 Table Type，跳过。
                    continue;
                }

                if (sheetMatches.Length > 1)
                {
                    throw Error("table.csvSheetAmbiguous", file.RelativePath, $"CSV '{physicalName}' matches multiple sheet definitions.");
                }

                var definition = sheetMatches[0];
                var columns = ((JArray)definition["columns"]).Cast<JObject>().ToArray();
                var columnIndexes = ResolveColumnIndexes(columns, records[layout.NameKeyRow - 1], file.RelativePath);
                var physicalSheetId = definition.Value<string>("id") + ":" + physicalName;
                var keyColumn = definition["keyColumnId"] == null
                    ? null
                    : ResolveColumn(columns, definition.Value<string>("keyColumnId"));
                var usedKeys = new HashSet<string>(StringComparer.Ordinal);
                var rows = new List<PhysicalRow>();
                for (var index = layout.DataStartRow - 1; index < records.Count; index++)
                {
                    var rawCells = records[index];
                    if (rawCells.All(cell => cell.Length == 0))
                    {
                        continue;
                    }

                    var sourceRowNumber = index + 1;
                    var cells = new Dictionary<string, JToken>(StringComparer.Ordinal);
                    var defaults = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var column in columns)
                    {
                        var columnId = column.Value<string>("id");
                        var raw = columnIndexes[columnId] < rawCells.Length ? rawCells[columnIndexes[columnId]] : string.Empty;
                        if (raw.Length == 0)
                        {
                            // 空/缺 cell 以 Catalog defaultValue 物化。
                            cells[columnId] = column["defaultValue"].DeepClone();
                            defaults.Add(columnId);
                        }
                        else
                        {
                            cells[columnId] = DecodeCell(raw, column, file.RelativePath + "#R" + sourceRowNumber + "." + columnId);
                        }
                    }

                    var rowId = BuildRowId(keyColumn, cells, physicalSheetId, sourceRowNumber, usedKeys, file.RelativePath);
                    rows.Add(new PhysicalRow(rowId, cells, defaults, file.RelativePath, sourceRowNumber));
                }

                physicalSheets.Add(new PhysicalSheet(definition, file.RelativePath, file.Hash, rows));
            }

            if (physicalSheets.Count == 0)
            {
                return Array.Empty<VisualBridgeStructuredCompiler.OutputPlan>();
            }

            var mappings = new List<JObject>();
            var dataSheets = new JArray();
            var sheetIndex = 0;
            foreach (var group in physicalSheets
                .GroupBy(value => value.Definition.Value<string>("id"), StringComparer.Ordinal)
                .OrderBy(group => group.Key, StringComparer.Ordinal))
            {
                var definition = group.First().Definition;
                var effectiveRows = ResolveEffectiveRows(definition, group.SelectMany(value => value.Rows).ToList());
                var sortedColumns = ((JArray)definition["columns"]).Cast<JObject>()
                    .OrderBy(value => value.Value<string>("id"), StringComparer.Ordinal)
                    .ToArray();
                var rowsJson = new JArray();
                for (var rowIndex = 0; rowIndex < effectiveRows.Count; rowIndex++)
                {
                    var row = effectiveRows[rowIndex];
                    var cellsJson = new JObject();
                    foreach (var column in sortedColumns)
                    {
                        var columnId = column.Value<string>("id");
                        cellsJson[columnId] = row.Cells[columnId].DeepClone();
                        var cellMapping = new JObject();
                        if (!row.Defaults.Contains(columnId))
                        {
                            cellMapping["sourcePath"] = row.SourcePath + "#R" + row.SourceRowNumber + "." + columnId;
                        }

                        cellMapping["artifactPath"] = "data.sheets[" + sheetIndex + "].rows[" + rowIndex + "].cells." + columnId;
                        cellMapping["origin"] = row.Defaults.Contains(columnId) ? "metadataDefault" : "document";
                        mappings.Add(cellMapping);
                    }

                    rowsJson.Add(new JObject
                    {
                        ["rowId"] = row.RowId,
                        ["cells"] = cellsJson,
                    });
                }

                dataSheets.Add(new JObject
                {
                    ["definitionId"] = group.Key,
                    ["rows"] = rowsJson,
                });
                sheetIndex++;
            }

            var tableTypeId = route.TableType.Value<string>("id");
            var catalogInputs = new JArray(route.Catalogs.Select(catalog => new JObject
            {
                ["catalogId"] = catalog.Root.Value<string>("catalogId"),
                ["path"] = catalog.RelativePath,
                ["sha256"] = catalog.Hash,
            }));
            var artifactRelativePath = "documents/" + project.ProjectId + "/" + route.DocumentType.Id + "/" + tableTypeId + ".vbcompiled.json";
            var artifact = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ArtifactKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = route.DocumentType.Id,
                ["tableTypeId"] = tableTypeId,
                ["inputs"] = new JObject
                {
                    ["integrationProfileSha256"] = inputs[profile.ProfilePath].Hash,
                    ["projectSha256"] = inputs[profile.AuthoringProjectPath].Hash,
                    ["catalogs"] = catalogInputs,
                },
                ["data"] = new JObject
                {
                    ["sheets"] = dataSheets,
                },
            };
            var artifactBytes = VisualBridgeStructuredCompiler.Serialize(artifact);
            var artifactHash = VisualBridgeStructuredCompiler.HashBytes(artifactBytes);

            var mappingRelativePath = "mappings/" + project.ProjectId + "/" + route.DocumentType.Id + "/" + tableTypeId + ".vbsource.json";
            var mapping = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = MappingKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = route.DocumentType.Id,
                ["tableTypeId"] = tableTypeId,
                ["inputs"] = new JObject
                {
                    ["integrationProfileSha256"] = inputs[profile.ProfilePath].Hash,
                    ["projectSha256"] = inputs[profile.AuthoringProjectPath].Hash,
                    ["catalogs"] = catalogInputs.DeepClone(),
                },
                ["sources"] = new JArray(physicalSheets.Select(value => new JObject
                {
                    ["path"] = value.SourcePath,
                    ["sha256"] = value.SourceHash,
                })),
                ["artifact"] = new JObject
                {
                    ["path"] = artifactRelativePath,
                    ["sha256"] = artifactHash,
                },
                ["mappings"] = new JArray(mappings.OrderBy(value => value.Value<string>("artifactPath"), StringComparer.Ordinal)),
            };
            var mappingBytes = VisualBridgeStructuredCompiler.Serialize(mapping);
            return new[]
            {
                VisualBridgeStructuredCompiler.CreateOutput(profile.CompileOutputRoot, artifactRelativePath, artifactBytes, "artifact"),
                VisualBridgeStructuredCompiler.CreateOutput(profile.CompileOutputRoot, mappingRelativePath, mappingBytes, "sourceMapping"),
            };
        }

        private static string BuildRowId(
            JObject keyColumn,
            Dictionary<string, JToken> cells,
            string physicalSheetId,
            int sourceRowNumber,
            HashSet<string> usedKeys,
            string sourcePath)
        {
            if (keyColumn == null)
            {
                return physicalSheetId + ":row-" + sourceRowNumber;
            }

            var keyColumnId = keyColumn.Value<string>("id");
            var identity = StableValueKey(cells[keyColumnId]);
            var cellPath = sourcePath + "#R" + sourceRowNumber + "." + keyColumnId;
            if (identity.Length == 0)
            {
                throw Error("table.emptyKey", cellPath, "Key column cannot be empty.");
            }

            if (!usedKeys.Add(identity))
            {
                throw Error("table.duplicateKey", cellPath, $"Duplicate key '{identity}' is already used by another row in this sheet.");
            }

            return physicalSheetId + ":key-" + identity;
        }

        private static IReadOnlyList<PhysicalRow> ResolveEffectiveRows(JObject definition, IReadOnlyList<PhysicalRow> rows)
        {
            var partition = definition["partition"] as JObject;
            if (partition == null)
            {
                return rows;
            }

            // 有 partition 时按 deduplicateByColumnId 的 stableValueKey 跨全部物理 sheet 去重。
            var deduplicateColumn = ResolveColumn(
                ((JArray)definition["columns"]).Cast<JObject>().ToArray(),
                partition.Value<string>("deduplicateByColumnId"));
            var deduplicateColumnId = deduplicateColumn.Value<string>("id");
            var policy = partition.Value<string>("duplicatePolicy");
            var result = new List<PhysicalRow>();
            var indexes = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var row in rows)
            {
                var identity = StableValueKey(row.Cells[deduplicateColumnId]);
                if (!indexes.TryGetValue(identity, out var existingIndex))
                {
                    indexes.Add(identity, result.Count);
                    result.Add(row);
                    continue;
                }

                if (policy == "error")
                {
                    throw Error(
                        "table.duplicatePartitionKey",
                        row.SourcePath + "#R" + row.SourceRowNumber + "." + deduplicateColumnId,
                        $"Duplicate partition key '{identity}' is already used by another row.");
                }

                if (policy == "keepLast")
                {
                    // keepLast：原位替换为最后一个出现的行。
                    result[existingIndex] = row;
                }

                // keepFirst：跳过后续重复行。
            }

            return result;
        }

        private static Dictionary<string, int> ResolveColumnIndexes(IReadOnlyList<JObject> columns, IReadOnlyList<string> nameKeys, string path)
        {
            var result = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var column in columns)
            {
                var columnId = column.Value<string>("id");
                var allowed = new HashSet<string>(StringComparer.Ordinal) { column.Value<string>("nameKey") };
                if (column["nameKeyAliases"] is JArray aliases)
                {
                    foreach (var alias in aliases.Values<string>())
                    {
                        allowed.Add(alias);
                    }
                }

                var matches = new List<int>();
                for (var index = 0; index < nameKeys.Count; index++)
                {
                    if (allowed.Contains(nameKeys[index].Trim()))
                    {
                        matches.Add(index);
                    }
                }

                if (matches.Count == 0)
                {
                    throw Error(
                        "table.missingColumn",
                        path + ".columns." + columnId,
                        $"The name-key row does not contain '{column.Value<string>("nameKey")}' or an exported alias.");
                }

                if (matches.Count > 1)
                {
                    throw Error(
                        "table.ambiguousColumn",
                        path + ".columns." + columnId,
                        $"The name-key row contains more than one match for '{column.Value<string>("nameKey")}'.");
                }

                result.Add(columnId, matches[0]);
            }

            return result;
        }

        private static JObject ResolveColumn(IReadOnlyList<JObject> columns, string identity)
        {
            return columns.FirstOrDefault(column =>
                string.Equals(column.Value<string>("id"), identity, StringComparison.Ordinal)
                || (column["aliases"] is JArray aliases && aliases.Values<string>().Contains(identity, StringComparer.Ordinal)));
        }

        private static bool MatchesSheetDefinition(JObject sheet, string physicalName)
        {
            if (string.Equals(sheet.Value<string>("name"), physicalName, StringComparison.Ordinal))
            {
                return true;
            }

            if (sheet["nameAliases"] is JArray nameAliases && nameAliases.Values<string>().Contains(physicalName, StringComparer.Ordinal))
            {
                return true;
            }

            return sheet["partition"] is JObject partition && MatchesPartitionPattern(partition.Value<string>("namePattern"), physicalName);
        }

        private static bool MatchesPartitionPattern(string pattern, string value)
        {
            var separatorIndex = pattern.IndexOf("{part}", StringComparison.Ordinal);
            if (separatorIndex < 0)
            {
                return false;
            }

            var prefix = pattern.Substring(0, separatorIndex);
            var suffix = pattern.Substring(separatorIndex + "{part}".Length);
            return value.Length > prefix.Length + suffix.Length
                && value.StartsWith(prefix, StringComparison.Ordinal)
                && value.EndsWith(suffix, StringComparison.Ordinal);
        }

        // cell 解码镜像 cellCodec.ts：空串在调用侧短路为 defaultValue，此处只处理非空 raw。
        private static JToken DecodeCell(string raw, JObject column, string path)
        {
            return DecodeValue(raw, column, (JObject)column["cellEncoding"], path);
        }

        private static JToken DecodeValue(string raw, JObject definition, JObject encoding, string path)
        {
            switch (encoding.Value<string>("kind"))
            {
                case "json":
                    return ParseJsonCell(raw, path);
                case "scalar":
                    switch (definition.Value<string>("valueType"))
                    {
                        case "string":
                            return new JValue(raw);
                        case "number":
                            return DecodeNumber(raw, path);
                        case "boolean":
                            return DecodeBoolean(raw, path);
                        default:
                            throw Error("table.invalidCell", path, $"Scalar encoding cannot decode {definition.Value<string>("valueType")}.");
                    }

                default:
                    return DecodeDelimited(raw, definition, encoding, path);
            }
        }

        private static JToken DecodeDelimited(string raw, JObject definition, JObject encoding, string path)
        {
            var separator = encoding.Value<string>("separator");
            var valueType = definition.Value<string>("valueType");
            if (valueType == "array")
            {
                if (raw.Length == 0)
                {
                    return new JArray();
                }

                var itemDefinition = (JObject)definition["item"];
                var itemEncoding = encoding["item"] as JObject ?? ScalarEncoding;
                var items = new JArray();
                var parts = raw.Split(new[] { separator }, StringSplitOptions.None);
                for (var index = 0; index < parts.Length; index++)
                {
                    items.Add(DecodeValue(parts[index], itemDefinition, itemEncoding, path + "[" + index + "]"));
                }

                return items;
            }

            if (valueType == "object")
            {
                var parts = raw.Split(new[] { separator }, StringSplitOptions.None);
                var result = new JObject();
                var fields = ((JArray)definition["fields"]).Cast<JObject>().ToList();
                for (var index = 0; index < fields.Count; index++)
                {
                    var field = fields[index];
                    var fieldId = field.Value<string>("id");
                    // 缺位片段按空串递归解码（object 字段：primitive→scalar，其余→json）。
                    var part = index < parts.Length ? parts[index] : string.Empty;
                    result[fieldId] = DecodeValue(part, field, EncodingForObjectField(field), path + "." + fieldId);
                }

                return result;
            }

            throw Error("table.invalidCell", path, $"Delimited encoding cannot decode {valueType}.");
        }

        private static JObject EncodingForObjectField(JObject field)
        {
            var valueType = field.Value<string>("valueType");
            return valueType == "string" || valueType == "number" || valueType == "boolean" ? ScalarEncoding : JsonEncoding;
        }

        private static JToken DecodeNumber(string raw, string path)
        {
            // 镜像 TS Number()：空串解析为 0，其余必须 finite。
            var trimmed = raw.Trim();
            if (trimmed.Length == 0)
            {
                return new JValue(0d);
            }

            if (!double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                || double.IsNaN(number)
                || double.IsInfinity(number))
            {
                throw Error("table.invalidCell", path, $"Expected a finite number, received '{raw}'.");
            }

            // 镜像 JS Number 序列化：整数值物化为整数 JSON 文本（101 而非 101.0）。
            if (number == Math.Truncate(number) && number >= long.MinValue && number <= long.MaxValue)
            {
                return new JValue((long)number);
            }

            return new JValue(number);
        }

        private static JToken DecodeBoolean(string raw, string path)
        {
            var normalized = raw.Trim().ToLowerInvariant();
            if (normalized == "true" || normalized == "1")
            {
                return new JValue(true);
            }

            if (normalized == "false" || normalized == "0")
            {
                return new JValue(false);
            }

            throw Error("table.invalidCell", path, $"Expected true, false, 1 or 0, received '{raw}'.");
        }

        private static JToken ParseJsonCell(string raw, string path)
        {
            try
            {
                using (var stringReader = new StringReader(raw))
                using (var reader = new JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = DateParseHandling.None;
                    reader.FloatParseHandling = FloatParseHandling.Double;
                    reader.Culture = CultureInfo.InvariantCulture;
                    var value = JToken.Load(reader, new JsonLoadSettings
                    {
                        CommentHandling = CommentHandling.Load,
                    });
                    if (reader.Read())
                    {
                        throw Error("table.invalidCell", path, "Trailing JSON content is not allowed.");
                    }

                    RequireFiniteJson(value, path);
                    return value;
                }
            }
            catch (JsonException exception)
            {
                throw Error("table.invalidCell", path, exception.Message);
            }
        }

        private static void RequireFiniteJson(JToken token, string path)
        {
            if (token.Type == JTokenType.Comment
                || token.Type == JTokenType.Raw
                || token.Type == JTokenType.Undefined
                || token.Type == JTokenType.Date
                || token.Type == JTokenType.Bytes
                || token.Type == JTokenType.Guid
                || token.Type == JTokenType.Uri
                || token.Type == JTokenType.TimeSpan)
            {
                throw Error("table.invalidCell", path, "Expected a finite JSON value.");
            }

            if (token.Type == JTokenType.Float)
            {
                var number = token.Value<double>();
                if (double.IsNaN(number) || double.IsInfinity(number))
                {
                    throw Error("table.invalidCell", path, "Non-finite numbers are forbidden.");
                }
            }

            if (token is JContainer container)
            {
                foreach (var child in container.Children())
                {
                    RequireFiniteJson(child is JProperty property ? property.Value : child, path);
                }
            }
        }

        // stableValueKey 镜像 tableDocument.ts：string 原样；其余值为紧凑 JSON 文本（对象键排序，键序无关）。
        private static string StableValueKey(JToken value)
        {
            if (value.Type == JTokenType.String)
            {
                return value.Value<string>();
            }

            var builder = new StringBuilder();
            using (var writer = new JsonTextWriter(new StringWriter(builder, CultureInfo.InvariantCulture)))
            {
                writer.Formatting = Formatting.None;
                writer.Culture = CultureInfo.InvariantCulture;
                WriteCanonicalJson(writer, value);
                writer.Flush();
            }

            return builder.ToString();
        }

        private static void WriteCanonicalJson(JsonTextWriter writer, JToken token)
        {
            if (token is JObject objectValue)
            {
                writer.WriteStartObject();
                foreach (var property in objectValue.Properties().OrderBy(value => value.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonicalJson(writer, property.Value);
                }

                writer.WriteEndObject();
                return;
            }

            if (token is JArray arrayValue)
            {
                writer.WriteStartArray();
                foreach (var item in arrayValue)
                {
                    WriteCanonicalJson(writer, item);
                }

                writer.WriteEndArray();
                return;
            }

            if (token is JValue value && value.Type == JTokenType.Float)
            {
                // 整数 double 规范化为整数文本，与 JS JSON.stringify 一致。
                var number = value.Value<double>();
                if (number == Math.Truncate(number) && number >= long.MinValue && number <= long.MaxValue)
                {
                    writer.WriteValue((long)number);
                    return;
                }
            }

            token.WriteTo(writer);
        }

        // RFC4180 风格解析：UTF-8 严格、剥 BOM、quote 包裹与 "" 转义、relax_column_count、空行保留为单列空行。
        private static List<string[]> ParseCsv(byte[] bytes, string delimiter, string path)
        {
            string text;
            try
            {
                text = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException exception)
            {
                throw Error("table.invalidCsv", path, "File is not valid UTF-8: " + exception.Message);
            }

            if (text.Length != 0 && text[0] == '\uFEFF')
            {
                text = text.Substring(1);
            }

            return ParseCsvRecords(text, delimiter, path);
        }

        private static List<string[]> ParseCsvRecords(string text, string delimiter, string path)
        {
            var records = new List<string[]>();
            var row = new List<string>();
            var field = new StringBuilder();
            var fieldStarted = false;
            var inQuotes = false;
            var index = 0;
            while (index < text.Length)
            {
                var character = text[index];
                if (inQuotes)
                {
                    if (character == '"')
                    {
                        if (index + 1 < text.Length && text[index + 1] == '"')
                        {
                            field.Append('"');
                            index += 2;
                            continue;
                        }

                        inQuotes = false;
                        index++;
                        continue;
                    }

                    field.Append(character);
                    index++;
                    continue;
                }

                if (character == '"' && !fieldStarted)
                {
                    inQuotes = true;
                    fieldStarted = true;
                    index++;
                    continue;
                }

                if (MatchesDelimiter(text, index, delimiter))
                {
                    row.Add(field.ToString());
                    field.Clear();
                    fieldStarted = false;
                    index += delimiter.Length;
                    continue;
                }

                if (character == '\r' || character == '\n')
                {
                    index += character == '\r' && index + 1 < text.Length && text[index + 1] == '\n' ? 2 : 1;
                    row.Add(field.ToString());
                    field.Clear();
                    fieldStarted = false;
                    records.Add(row.ToArray());
                    row.Clear();
                    continue;
                }

                field.Append(character);
                fieldStarted = true;
                index++;
            }

            if (inQuotes)
            {
                throw Error("table.invalidCsv", path, "Unterminated quoted field.");
            }

            if (field.Length != 0 || fieldStarted || row.Count != 0)
            {
                row.Add(field.ToString());
                records.Add(row.ToArray());
            }

            return records;
        }

        private static bool MatchesDelimiter(string text, int index, string delimiter)
        {
            if (delimiter.Length == 1)
            {
                return text[index] == delimiter[0];
            }

            if (index + delimiter.Length > text.Length)
            {
                return false;
            }

            for (var offset = 0; offset < delimiter.Length; offset++)
            {
                if (text[index + offset] != delimiter[offset])
                {
                    return false;
                }
            }

            return true;
        }

        private static VisualBridgeStructuredCompiler.OutputPlan BuildManifest(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IReadOnlyList<VisualBridgeStructuredCompiler.OutputPlan> outputs,
            IReadOnlyDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            var manifest = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ManifestKind,
                ["projectId"] = project.ProjectId,
                ["inputs"] = new JArray(inputs.Values
                    .Select(input => new JObject
                    {
                        ["path"] = VisualBridgeStructuredCompiler.InputDisplayPath(profile, project, input.Path),
                        ["sha256"] = input.Hash,
                    })
                    .OrderBy(value => value.Value<string>("path"), StringComparer.Ordinal)),
                ["outputs"] = new JArray(outputs.OrderBy(output => output.RelativePath, StringComparer.Ordinal).Select(output => new JObject
                {
                    ["kind"] = output.Kind,
                    ["path"] = output.RelativePath,
                    ["sha256"] = output.Hash,
                })),
            };
            return VisualBridgeStructuredCompiler.CreateOutput(
                profile.CompileOutputRoot,
                ManifestFileName,
                VisualBridgeStructuredCompiler.Serialize(manifest),
                "manifest");
        }

        private static IReadOnlyList<string> ReadPreviousManagedPaths(string outputRoot)
        {
            var manifestPath = Path.Combine(outputRoot, ManifestFileName);
            if (!File.Exists(manifestPath))
            {
                return Array.Empty<string>();
            }

            VisualBridgeStructuredCompiler.RejectOutputAlias(manifestPath);
            var manifest = VisualBridgeIntegrationProfileLoader.ReadStrictObject(manifestPath, "compile.manifestInvalidJson");
            VisualBridgeStructuredCompiler.RequireKeys(manifest, "manifest", new[] { "formatVersion", "kind", "projectId", "inputs", "outputs" });
            if (manifest["formatVersion"].Type != JTokenType.Integer || manifest["formatVersion"].Value<long>() != 1)
            {
                throw Error("compile.manifestInvalid", "manifest.formatVersion", "Expected formatVersion 1.");
            }

            if (manifest["kind"].Type != JTokenType.String || manifest.Value<string>("kind") != ManifestKind)
            {
                throw Error("compile.manifestInvalid", "manifest.kind", "Unexpected manifest kind.");
            }

            if (!(manifest["inputs"] is JArray) || !(manifest["outputs"] is JArray outputs))
            {
                throw Error("compile.manifestInvalid", "manifest", "Expected input and output arrays.");
            }

            var result = new List<string>(outputs.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < outputs.Count; index++)
            {
                if (!(outputs[index] is JObject output))
                {
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}]", "Expected an object.");
                }

                VisualBridgeStructuredCompiler.RequireKeys(output, $"manifest.outputs[{index}]", new[] { "kind", "path", "sha256" });
                var path = output["path"].Type == JTokenType.String ? output.Value<string>("path") : null;
                VisualBridgeStructuredCompiler.ValidateOutputRelativePath(path, $"manifest.outputs[{index}].path");
                VisualBridgeStructuredCompiler.RequireHash(output["sha256"], $"manifest.outputs[{index}].sha256");
                if (!unique.Add(path))
                {
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}].path", "Duplicate managed output path.");
                }

                result.Add(path);
            }

            return result;
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

        private sealed class Registry
        {
            public Registry(IReadOnlyDictionary<string, RouteDescriptor> routes)
            {
                Routes = routes;
            }

            public IReadOnlyDictionary<string, RouteDescriptor> Routes { get; }
        }

        private sealed class RouteDescriptor
        {
            public RouteDescriptor(
                VisualBridgeAuthoringDocumentType documentType,
                JObject tableType,
                IReadOnlyList<CatalogDescriptor> catalogs)
            {
                DocumentType = documentType;
                TableType = tableType;
                Catalogs = catalogs;
            }

            public VisualBridgeAuthoringDocumentType DocumentType { get; }

            public JObject TableType { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }
        }

        private sealed class CatalogDescriptor
        {
            public CatalogDescriptor(string relativePath, string fullPath, string hash, JObject root)
            {
                RelativePath = relativePath;
                FullPath = fullPath;
                Hash = hash;
                Root = root;
            }

            public string RelativePath { get; }

            public string FullPath { get; }

            public string Hash { get; }

            public JObject Root { get; }
        }

        private sealed class RoutedDocument
        {
            public RoutedDocument(string fullPath, string relativePath, RouteDescriptor route)
            {
                FullPath = fullPath;
                RelativePath = relativePath;
                Route = route;
            }

            public string FullPath { get; }

            public string RelativePath { get; }

            public RouteDescriptor Route { get; }
        }

        private sealed class RoutedFile
        {
            public RoutedFile(RoutedDocument document, byte[] bytes, string hash)
            {
                Document = document;
                Bytes = bytes;
                Hash = hash;
            }

            public RoutedDocument Document { get; }

            public byte[] Bytes { get; }

            public string Hash { get; }

            public string FullPath => Document.FullPath;

            public string RelativePath => Document.RelativePath;

            public RouteDescriptor Route => Document.Route;
        }

        private sealed class PhysicalSheet
        {
            public PhysicalSheet(JObject definition, string sourcePath, string sourceHash, IReadOnlyList<PhysicalRow> rows)
            {
                Definition = definition;
                SourcePath = sourcePath;
                SourceHash = sourceHash;
                Rows = rows;
            }

            public JObject Definition { get; }

            public string SourcePath { get; }

            public string SourceHash { get; }

            public IReadOnlyList<PhysicalRow> Rows { get; }
        }

        private sealed class PhysicalRow
        {
            public PhysicalRow(string rowId, Dictionary<string, JToken> cells, HashSet<string> defaults, string sourcePath, int sourceRowNumber)
            {
                RowId = rowId;
                Cells = cells;
                Defaults = defaults;
                SourcePath = sourcePath;
                SourceRowNumber = sourceRowNumber;
            }

            public string RowId { get; }

            public Dictionary<string, JToken> Cells { get; }

            public HashSet<string> Defaults { get; }

            public string SourcePath { get; }

            public int SourceRowNumber { get; }
        }
    }
}
