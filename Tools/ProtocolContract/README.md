# VisualBridge Protocol Contract Tool

`Protocol/Schema` is the single input for public transport contracts. Run `npm run generate` in this package to compile every JSON Schema and regenerate `Protocol/Generated/contracts.d.ts` plus the deterministic schema index. Every formal Schema receives a file-derived TypeScript namespace containing its root contract as `Root` and one declaration for every `$defs` entry. Source file and `$id` comments keep declarations traceable; namespaces isolate intentional cross-Schema names such as `Identifier`, while normalized name collisions and unresolved `$ref` values fail generation.

`npm run check` fails when either generated artifact drifts. `schema-index.json` hashes every Schema byte-for-byte, so annotation-only changes are detected even if they do not alter a TypeScript type; Schema additions also require a new namespace and index entry. `npm run check:mcp` launches the built MCP stdio server, obtains its actual `tools/list` schemas, and compares the seven public tool surfaces with `visualbridge-mcp-tools.schema.json`.

This package does not generate C# yet. A future C# generator must consume the same JSON Schema files and must not infer contracts from TypeScript source or Unity assemblies.
