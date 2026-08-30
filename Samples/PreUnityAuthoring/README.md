# Pre-Unity Authoring Sample

This is the smallest maintained VisualBridge project that exercises all four built-in Authoring document families before Unity integration exists. Its source files and Catalogs are intentionally ordinary, reviewable files.

The sample includes:

- one `VisualBridge.project.vbjson` project;
- custom `.encounter`, `.character`, and `.settingsdata` document extensions;
- Graph V3, Entity V1, Structured V1, and Table CSV documents;
- matching Graph V4, Entity V1, Structured V1, and Table V1 Catalogs;
- an optional Project Provider V2 process for `sample.asset` references and one warning diagnostic.

Open this directory in VS Code after installing the VisualBridge VSIX. Use **VisualBridge: Open Document** or the VisualBridge Documents view for project-defined extensions. The CSV file can be opened with **VisualBridge Table Editor**.

Start with the repository [`Getting Started`](../../Doc/GettingStarted.md), then use the [`Authoring User Guide`](../../Doc/AuthoringUserGuide.md) for the four editors, Document Browser, lifecycle, references, diagnostics, and recovery. Host and automation authors should use the [`Integration Guide`](../../Doc/IntegrationGuide.md).

Project Providers are trusted project code. The included Provider starts only when the host allows the declared entry and, in VS Code, the workspace is trusted. Remove the `providers` array from `VisualBridge.project.vbjson` if Provider behavior is not wanted.

From the repository root, validate this complete sample with the same production parsers, Catalog registries, validators, Project matcher, and Provider host used by VisualBridge:

```powershell
npm run test:samples
npm run check:docs
```

The sample is text-only by design. XLSX uses the same Table semantic model but is omitted here so changes remain directly reviewable; the automated Table suite owns deterministic XLSX round-trip coverage.
