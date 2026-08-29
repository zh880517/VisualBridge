import {
  ReferenceService,
  type DocumentDiagnostic,
  type JsonValue,
  type ReferenceDefinition,
  type ReferenceOccurrence,
} from "@visualbridge/core";
import { createTableRowReferenceProvider } from "@visualbridge/table";
import type { VisualBridgeWorkspace } from "./projectWorkspace.js";
import type { TableService } from "./tableService.js";

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
    const service = new ReferenceService([
      createTableRowReferenceProvider(() => this.tables.loadReferenceDocuments(project.projectFile)),
    ]);
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
    return this.createService(projectFile).then((service) => service.validate(occurrences));
  }

  public async validateChange(
    projectFile: string,
    before: readonly ReferenceOccurrence[],
    after: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }> {
    const service = await this.createService(projectFile);
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

  private async createService(projectFile: string): Promise<ReferenceService> {
    const project = await this.workspace.resolveProject(projectFile);
    return new ReferenceService([
      createTableRowReferenceProvider(() => this.tables.loadReferenceDocuments(project.projectFile)),
    ]);
  }
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
