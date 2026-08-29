import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createDocumentReferenceProvider,
  ReferenceService,
  type DocumentReferenceDocument,
  type DocumentDiagnostic,
  type JsonValue,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceResolution,
} from "@visualbridge/core";
import {
  createEntityComponentReferenceProvider,
  parseEntityDocument,
  type EntityReferenceDocument,
} from "@visualbridge/entity";
import {
  createGraphElementReferenceProvider,
  parseGraphDocument,
  type GraphReferenceDocument,
} from "@visualbridge/graph";
import { parseStructuredDocument } from "@visualbridge/structured";
import { createTableRowReferenceProvider } from "@visualbridge/table";
import type { VisualBridgeWorkspace } from "./projectWorkspace.js";
import type { TableService } from "./tableService.js";
import { loadMcpEntityRegistry } from "./entityRegistry.js";

export class VisualBridgeReferenceService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly tables: TableService,
  ) {}

  public async query(options: {
    readonly projectFile?: string;
    readonly action: "search" | "resolve";
    readonly definition: ReferenceDefinition;
    readonly query?: string;
    readonly value?: string | number;
    readonly limit: number;
  }): Promise<Record<string, unknown>> {
    const project = await this.workspace.resolveProject(options.projectFile);
    const service = await this.createProjectService(project.projectFile);
    if (options.action === "search") {
      const results = await service.search(options.definition, options.query ?? "", options.limit);
      return {
        projectFile: project.projectFile,
        action: options.action,
        definition: options.definition,
        query: options.query ?? "",
        results,
      };
    }
    if (options.value === undefined) {
      throw new Error("Reference resolve requires value.");
    }
    const resolution = await service.resolve(options.definition, options.value);
    return {
      projectFile: project.projectFile,
      action: options.action,
      definition: options.definition,
      value: options.value,
      ...resolution,
    };
  }

  public async validate(
    projectFile: string,
    occurrences: readonly ReferenceOccurrence[],
  ): Promise<readonly DocumentDiagnostic[]> {
    return this.createProjectService(projectFile).then((service) => service.validate(occurrences));
  }

  public async resolve(
    projectFile: string,
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<ReferenceResolution> {
    return (await this.createProjectService(projectFile)).resolve(definition, value);
  }

  public async validateChange(
    projectFile: string,
    before: readonly ReferenceOccurrence[],
    after: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }> {
    const service = await this.createProjectService(projectFile);
    const baseline = diagnosticCounts(await service.validate(before));
    const diagnostics = await service.validate(after);
    const introducedErrors = diagnostics.filter((diagnostic) => {
      if (diagnostic.severity !== "error") {
        return false;
      }
      const key = diagnosticKey(diagnostic);
      const count = baseline.get(key) ?? 0;
      if (count === 0) {
        return true;
      }
      baseline.set(key, count - 1);
      return false;
    });
    return { diagnostics, introducedErrors };
  }

  public async createProjectService(projectFile: string): Promise<ReferenceService> {
    const project = await this.workspace.resolveProject(projectFile);
    let semanticDocuments: Promise<{
      readonly documents: readonly DocumentReferenceDocument[];
      readonly entities: readonly EntityReferenceDocument[];
      readonly graphs: readonly GraphReferenceDocument[];
    }> | undefined;
    const loadSemanticDocuments = () => (semanticDocuments ??= this.loadSemanticDocuments(project.projectFile));
    return new ReferenceService([
      createDocumentReferenceProvider(() => loadSemanticDocuments().then((loaded) => loaded.documents)),
      createEntityComponentReferenceProvider(() => loadSemanticDocuments().then((loaded) => loaded.entities)),
      createGraphElementReferenceProvider(() => loadSemanticDocuments().then((loaded) => loaded.graphs)),
      createTableRowReferenceProvider(() => this.tables.loadReferenceDocuments(project.projectFile)),
    ]);
  }

  private async loadSemanticDocuments(projectFile: string): Promise<{
    readonly documents: readonly DocumentReferenceDocument[];
    readonly entities: readonly EntityReferenceDocument[];
    readonly graphs: readonly GraphReferenceDocument[];
  }> {
    const project = await this.workspace.resolveProject(projectFile);
    const declared = await this.workspace.listDeclaredDocuments(project);
    const documents: DocumentReferenceDocument[] = [];
    const entities: EntityReferenceDocument[] = [];
    const graphs: GraphReferenceDocument[] = [];
    const entityRegistries = new Map<string, ReturnType<typeof loadMcpEntityRegistry>>();
    for (const source of declared) {
      if (source.documentType.editor !== "graph"
        && source.documentType.editor !== "entity"
        && source.documentType.editor !== "structured") continue;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(source.absolutePath));
      if (source.documentType.editor === "graph") {
        const parsed = parseGraphDocument(text);
        if (!parsed.success) continue;
        const title = parsed.document.graphs.find((graph) => graph.id === parsed.document.rootGraphId)?.title
          ?? path.basename(source.path, path.extname(source.path));
        documents.push(documentReference(project.definition.projectId, source.documentType.id, source.documentType.editor, source.path, parsed.document.documentId, title));
        graphs.push({
          projectId: project.definition.projectId,
          documentTypeId: source.documentType.id,
          path: source.path,
          document: parsed.document,
        });
      } else if (source.documentType.editor === "entity") {
        const parsed = parseEntityDocument(text);
        if (parsed.success) {
          documents.push(documentReference(project.definition.projectId, source.documentType.id, source.documentType.editor, source.path, parsed.document.documentId, parsed.document.title));
          let registry = entityRegistries.get(source.documentType.id);
          if (registry === undefined) {
            registry = loadMcpEntityRegistry(project, source.documentType);
            entityRegistries.set(source.documentType.id, registry);
          }
          entities.push({
            projectId: project.definition.projectId,
            documentTypeId: source.documentType.id,
            path: source.path,
            document: parsed.document,
            registry: await registry,
          });
        }
      } else {
        const parsed = parseStructuredDocument(text);
        if (parsed.success) {
          documents.push(documentReference(
            project.definition.projectId,
            source.documentType.id,
            source.documentType.editor,
            source.path,
            parsed.document.documentId,
            path.basename(source.path, path.extname(source.path)),
          ));
        }
      }
    }
    documents.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
    entities.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
    graphs.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
    return { documents, entities, graphs };
  }
}

function documentReference(
  projectId: string,
  documentTypeId: string,
  editor: string,
  sourcePath: string,
  documentId: string,
  title: string,
): DocumentReferenceDocument {
  return { projectId, documentTypeId, editor, path: sourcePath, documentId, title };
}

export function referenceDefinition(
  kind: string,
  target: Readonly<Record<string, JsonValue>>,
  allowMissing: boolean,
): ReferenceDefinition {
  return { kind, target, allowMissing };
}

function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const result = new Map<string, number>();
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    result.set(key, (result.get(key) ?? 0) + 1);
  });
  return result;
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
}
