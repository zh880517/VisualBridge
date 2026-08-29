# VisualBridge Table Semantic Model V1

## 1. Scope

Table V1 edits constrained game-data tables carried by UTF-8 CSV-compatible text files or `.xlsx` workbooks. The editor, validation, future MCP adapter and future Unity compiler share one semantic model and one Table Operation API. They do not implement separate CSV and Excel business rules.

The current implementation includes Table Catalog V1, CSV and XLSX codecs, atomic Table Operation batches, a record-oriented VS Code table editor, project-defined file associations, partitioned logical tables and fixed semantic fixtures. It does not add Unity code. Unity Catalog export, authoring import, runtime compilation and debugging remain future work.

## 2. C# owns the data definition

The future C# exporter is the source of truth for:

- stable Table Type, Sheet and Column IDs and aliases;
- ordinary runtime `class` / `struct` source type names;
- column display names and physical `nameKey` values;
- JSON shape and runtime `dataTypeId` values such as `int`, `float`, enum IDs and ordinary game structs;
- default values, editor constraints and enum options;
- scalar, JSON and delimiter-based cell encodings;
- logical sheet and partition rules.

The exported result is a `.vbtablecatalog` JSON file. Authoring data does not depend on `ScriptableObject`, Unity sub-assets or editor-only wrapper types. The future exporter may inspect only the ordinary C# types used by the game; it must not execute gameplay initialization methods to obtain defaults.

Table columns reuse the project-wide Core Field model and shared Form Editor. Numeric, boolean, text, color, select, List and recursively nested ordinary structures therefore behave the same in Entity, Table and later Structured editors.

## 3. Project-level row layout

`VisualBridge.project.vbjson` declares the physical header layout once for the whole project. Row numbers are one-based:

```json
{
  "tableLayout": {
    "nameKeyRow": 2,
    "dataStartRow": 3
  }
}
```

Rows before `dataStartRow` are header rows and are preserved by the codecs. A common layout is:

1. description row;
2. name-key row;
3. first data row.

`dataStartRow` must be greater than `nameKeyRow`. The semantic column mapping always reads `nameKeyRow`; it never assumes that a field remains at the same physical column index. Reordered columns and exported `nameKeyAliases` remain readable. Missing or ambiguous required name keys are errors.

## 4. Table Catalog V1

A Document Type selects the broad editor with `"editor": "table"`; its stable Document Type ID resolves a Table Type ID or alias. File extensions remain project-defined by `include` and `exclude` patterns.

```json
{
  "formatVersion": 1,
  "catalogId": "game.tables",
  "title": "Game Tables",
  "tableTypes": [
    {
      "id": "game.table.skills",
      "aliases": ["legacy.table.skills"],
      "title": "Skills",
      "source": {
        "providerId": "csharp",
        "typeName": "Game.SkillConfig"
      },
      "csv": { "delimiter": "\t" },
      "sheets": []
    }
  ]
}
```

Catalog IDs, Table Type IDs, Sheet IDs and Column IDs are persistent identities. Display titles, C# type names, physical sheet names and physical name keys are not identities. Aliases provide explicit migration without silently guessing renamed types or columns.

Each Sheet definition also declares how a row is named in the editor:

```json
{
  "id": "skills",
  "rowDisplayNamePattern": "{id}_{name}"
}
```

Placeholders must use exact, stable Column IDs. Physical `nameKey` values and aliases are rejected so exported column renames cannot silently change the authoring identity shown to users. The formatted value is presentation only: it drives the record list, selected-record title and search text, while row identity and duplicate detection continue to use their explicit semantic IDs and key columns.

## 5. Cell encoding

Every column carries the shared Field definition plus a physical `nameKey` and a C#-exported `cellEncoding`:

- `scalar`: primitive string, number or boolean value;
- `json`: JSON text inside one cell;
- `delimited`: an array or struct with an explicit separator and optional nested item encoding.

For example, C# `RewardItem[]` can define `;` between array items and `|` between the fields of each item. The cell `1001|2;1002|1` then maps to two typed objects. Delimiters are never inferred from current data. A structured field without explicit encoding is rejected.

The codec preserves unknown physical columns. Simple XLSX cell edits patch known cells in place. CSV serialization preserves the configured header rows, original line-ending style and untouched raw cell values.

## 6. Logical table partitioning

One logical Sheet definition may be split into multiple physical CSV files or XLSX worksheets. All partitions necessarily share the same columns because they resolve to the same Sheet definition.

```json
{
  "id": "skills",
  "name": "Skills",
  "keyColumnId": "id",
  "partition": {
    "namePattern": "Skills_{part}",
    "deduplicateByColumnId": "id",
    "duplicatePolicy": "keepFirst"
  },
  "columns": []
}
```

`namePattern` contains exactly one `{part}` placeholder. Examples matching the definition include `Skills_A` and `Skills_Season2`. Physical names that do not match the template do not join this logical table.

The de-duplication column is a stable Column ID, normally the first/key column. Policies are:

- `error`: duplicates across partitions are errors and new invalid operations are rejected;
- `keepFirst`: retain the first row in the effective logical row stream and emit a warning;
- `keepLast`: retain the last row in the effective logical row stream and emit a warning.

De-duplication does not delete or rewrite source rows. Codecs preserve every physical row, while `resolveEffectiveTableRows` supplies the policy-resolved logical view to future compilers and query services. Physical order is deterministic: XLSX uses workbook sheet order; a CSV family uses lexicographically sorted paths.

For CSV, partitions are discovered beside the opened file when they have the same physical extension, resolve to the same Project and Document Type, and match the naming template. The editor opens them as one logical document with partition tabs. An operation batch is applied to the combined semantic document; saving checks every member's base hash before writing any changed member. A conflict rejects the save instead of overwriting an external edit.

For XLSX, matching worksheets are partitions inside one workbook. Unrelated worksheets remain outside the Table semantic document and are preserved during write-back.

## 7. Semantic document and operations

The in-memory Table Document contains physical sheets, preserved header rows, resolved column indexes and typed rows. Source row numbers and raw cells are codec metadata; editors must not treat them as stable business identities.

V1 operations are:

- `table.setCell`;
- `table.insertRow`;
- `table.removeRow`;
- `table.moveRow`;
- `table.duplicateRow`.

The Core clones the document, applies the whole batch, validates the result and publishes it only if the batch introduces no new errors. This gives Table Operations atomic semantic behavior and keeps the record editor as a view layer. VS Code undo and redo restore complete semantic snapshots.

## 8. VS Code editor and persistence

The Table editor uses the Project Registry instead of hardcoded extensions. `VisualBridge: Open Document` routes any matching Table Document to the same custom editor. The carrier is detected from content: an XLSX ZIP package uses the workbook codec; other table files use the configured UTF-8 CSV codec.

The editor follows a record-oriented master-detail layout suitable for game configuration: a searchable record list is shown on the left and the selected record uses the project-wide shared Field editor on the right. The list and detail title both use `rowDisplayNamePattern`. Each record row uses the project-wide list action order: drag, insert-after and delete remain together; reordering is disabled while a filtered result hides rows. Search matches the formatted title and all encoded cells. Add and duplicate generate non-conflicting key/de-duplication values across every physical partition of the same logical Sheet; duplicate also gives the first non-key string used by the display pattern a `·副本` name.

Colors, Lists and nested ordinary structures therefore behave the same as Entity fields instead of becoming special table controls. Shared Lists use one dnd-kit sortable layout across Document Types, with drag, add-after and delete controls grouped beside each element. Accessible buttons use Base UI, functional controls use the shared Lucide icon set, and colors use the shared `react-colorful` popover. XLSX handling uses `exceljs`.

Every opened source records a SHA-256 base hash. Table Operations and save both recheck those hashes. Save stages bytes to a sibling temporary file and replaces the target only after serialization succeeds. A detected external change is never overwritten implicitly.

## 9. XLSX boundary

V1 supports ordinary game-data worksheets. Known typed cells, worksheet ordering, unrelated sheets and existing cell styles are preserved for simple cell edits. Structural row changes rewrite the configured data region and copy source-row styles where possible.

Macros, `.xls`, pivot tables, charts, external links, formula authoring and arbitrary workbook round-trip fidelity are outside V1. Formulas can be read through their cached result, but the Table editor does not promise to preserve complex formula-driven data-region semantics after structural row edits.

## 10. Deferred Unity and MCP work

No Unity Table Exporter, importer, runtime, `ScriptableObject` layer or Debug feature is implemented in this phase. Future Unity integration must export Table Catalog JSON from ordinary game structures and consume the same effective logical rows and encodings documented here.

The current stdio MCP vertical slice remains Graph-focused. Before AI modification of CSV/XLSX is enabled, MCP must expose Table query/search/validation/operation tools backed by these codecs and Table Operations, with the same base-hash conflict contract. AI must not bypass the semantic layer by editing workbook bytes or raw CSV cells directly.
