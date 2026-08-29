import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const schemaNames = [
  "visualbridge-project.schema.json",
  "visualbridge-graph.schema.json",
  "visualbridge-graph-catalog.schema.json",
  "visualbridge-entity.schema.json",
  "visualbridge-entity-catalog.schema.json",
  "visualbridge-table-catalog.schema.json",
];
const destinationDirectory = path.join(scriptDirectory, "..", "dist", "schemas");

await mkdir(destinationDirectory, { recursive: true });
await Promise.all(schemaNames.map((schemaName) => copyFile(
  path.join(repositoryRoot, "Protocol", "Schema", schemaName),
  path.join(destinationDirectory, schemaName),
)));
