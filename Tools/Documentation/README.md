# Documentation Gate

`npm run check:docs` validates the maintained Markdown, VS Code extension surface, MCP registry, and executable examples without opening VS Code or Unity. It then reuses the Protocol Contract workspace's real stdio `check:mcp`, so the MCP build must exist; CI runs this gate after `npm run build`.

## JSON fence metadata

New or changed business JSON fences must identify an executable contract. This example is itself checked:

```json visualbridge-schema=visualbridge-primitives.schema.json#/$defs/lockOwner
{
  "version": 1,
  "token": "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
  "pid": 42,
  "startedAt": "2026-08-30T12:34:56.000Z"
}
```

Use `visualbridge-parser=project`, `catalog-source`, `graph-document`, `graph-catalog`, `entity-document`, `entity-catalog`, `structured-document`, `structured-catalog`, or `table-catalog` for complete Authoring documents. A complete root-Schema example must declare both its Schema and production parser. A schema-only fence is allowed only when it names a formal JSON Pointer fragment such as `#/$defs/...` for which no standalone product parser exists. Parser-backed fences require the corresponding built workspace output.

There is no legacy bypass: every `json` or `jsonc` fence in the maintained documentation must carry executable metadata. Unmarked business JSON, new or old, fails the gate.

The maintained `Samples/PreUnityAuthoring` files are validated separately by `npm run test:samples`: every JSON Project, Catalog, and Document source passes its formal JSON Schema and its production parser; CSV additionally passes the production Table parser.

## Pinned parser dependencies

Versions and licenses were verified against the npm registry before adoption:

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `unified` | `11.0.5` | MIT | Markdown processing pipeline |
| `remark-parse` | `11.0.0` | MIT | CommonMark Markdown AST |
| `remark-gfm` | `4.0.1` | MIT | GitHub-flavored Markdown extensions |
| `github-slugger` | `2.0.0` | ISC | GitHub-compatible heading anchors |
| `jsdom` | `29.1.1` | MIT | Deterministic DOM for Mermaid parsing under Node |
| `mermaid` | `11.17.2` | MIT | Real Mermaid grammar parsing |
| `ajv` | `8.20.0` | MIT | JSON Schema 2020-12 validation |

The repository dependency policy requires these direct versions, the workspace license metadata, and the lockfile importer to remain exact.
