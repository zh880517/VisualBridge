/**
 * MCP 的 Reference Refactor 服务（B4）。
 *
 * "重命名" 全部落在模块 facet 上：`replaceReferenceValues` 改引用、`renameDocumentId` 改文档 ID、
 * `renameTarget` 改领域内稳定身份（Graph element / Entity component / Table row key）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  compareUtf16CodeUnits,
  createReferenceValueRenamePlan,
  documentIndexKey,
  referenceValuesEqual,
  type IndexedDocument,
  type DocumentLifecycleDeleteTarget,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceService,
  type ReferenceValueRenamePlan,
} from "@visualbridge/core";
import type { McpDocumentService } from "./documentService.js";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "./projectTransaction.js";
import {
  VisualBridgeMcpError,
  resolveExistingProjectPath,
  type ProjectContext,
  type VisualBridgeWorkspace,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";

interface PreparedWrite {
  readonly path: string;
  readonly absolutePath: string;
  readonly before: Buffer;
  readonly after: Buffer;
}

interface PreparedRefactor {
  readonly project: ProjectContext;
  readonly plan: ReferenceValueRenamePlan;
  readonly writes: readonly PreparedWrite[];
  readonly dependencies: readonly { readonly path: string; readonly baseHash: string }[];
  readonly previewHash: string;
}

export interface ReferenceRefactorRequest {
  readonly projectFile?: string;
  readonly action: "preview" | "apply";
  readonly definition: ReferenceDefinition;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly previewHash?: string;
  readonly baseHashes?: Readonly<Record<string, string>>;
}

export class ReferenceRefactorService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
    private readonly documents: McpDocumentService,
  ) {}

  public async execute(request: ReferenceRefactorRequest): Promise<Record<string, unknown>> {
    if (request.action === "preview") {
      return previewResult(await this.prepare(request));
    }
    const project = await this.workspace.resolveProject(request.projectFile);
    try {
      return await withProjectTransaction(project.projectRoot, async (transaction) => {
        let prepared: PreparedRefactor;
        try {
          prepared = await this.prepare(request);
        } catch (errorValue) {
          if (!(errorValue instanceof VisualBridgeMcpError) || !isPreviewInvalidation(errorValue.code)) throw errorValue;
          return {
            status: "conflict",
            reason: "previewInvalidated",
            message: formatError(errorValue),
          };
        }
        const preview = previewResult(prepared);
        if (request.previewHash !== prepared.previewHash) {
          return { ...preview, status: "conflict", reason: "previewHashMismatch" };
        }
        const expected = request.baseHashes ?? {};
        const actual = Object.fromEntries(prepared.writes.map((write) => [write.path, hashBytes(write.before)]));
        if (!sameHashManifest(expected, actual)) {
          return { ...preview, status: "conflict", reason: "baseHashMismatch" };
        }
        const dependencies = await Promise.all(prepared.dependencies.map(async (dependency) => {
          const absolutePath = dependency.path === prepared.project.projectFile
            ? prepared.project.absoluteProjectFile
            : await resolveExistingProjectPath(prepared.project, dependency.path);
          return {
            path: path.relative(prepared.project.projectRoot, absolutePath).replaceAll("\\", "/"),
            absolutePath,
            hash: dependency.baseHash,
          };
        }));
        const committed = await transaction.commit(prepared.writes, dependencies);
        return {
          status: "applied",
          projectFile: prepared.project.projectFile,
          previewHash: prepared.previewHash,
          kind: prepared.plan.kind,
          oldValue: prepared.plan.oldValue,
          newValue: prepared.plan.newValue,
          referencesChanged: prepared.plan.changes.length,
          sources: prepared.writes.map((write) => ({
            path: write.path,
            previousHash: hashBytes(write.before),
            hash: hashBytes(write.after),
          })),
          ...(committed.maintenance === undefined ? {} : { maintenance: committed.maintenance }),
        };
      });
    } catch (errorValue) {
      if (errorValue instanceof ProjectTransactionConflict) {
        return {
          status: "conflict",
          reason: errorValue.reason,
          message: errorValue.message,
          details: errorValue.details,
        };
      }
      if (errorValue instanceof ProjectTransactionFailure) {
        throw new VisualBridgeMcpError(errorValue.code, errorValue.message, errorValue.details);
      }
      throw errorValue;
    }
  }

  private async prepare(request: ReferenceRefactorRequest): Promise<PreparedRefactor> {
    if (typeof request.oldValue !== typeof request.newValue || referenceValuesEqual(request.oldValue, request.newValue)) {
      throw new VisualBridgeMcpError(
        "refactor.invalidValue",
        "A reference rename must preserve value type and use a different value.",
      );
    }
    const project = await this.workspace.resolveProject(request.projectFile);
    // 引用数据必须完整：改造前 Table 的引用装载就是 strict（坏源直接失败），否则重命名会
    // 漏掉坏源里的引用并静默产生悬空（B4 第 2 轮 P2-2）。
    const references = await this.references.createProjectService(project.projectFile, undefined, {
      strictReferenceDataCode: "refactor.invalidSource",
    });
    const resolution = await references.resolve(request.definition, request.oldValue);
    if (resolution.status !== "resolved" || resolution.candidates.length !== 1) {
      throw new VisualBridgeMcpError("refactor.unresolvedTarget", "Only a uniquely resolved reference target can be renamed.", resolution);
    }
    const collision = await references.resolve(request.definition, request.newValue);
    if (collision.status !== "missing") {
      throw new VisualBridgeMcpError(
        "refactor.duplicateTarget",
        `The new value '${String(request.newValue)}' already resolves to ${collision.candidates.length} target(s).`,
      );
    }
    const documents = await this.references.buildProjectIndex(project.projectFile, {
      strict: false,
      errorCode: "refactor.invalidSource",
    });
    const selected = {
      occurrence: { definition: request.definition, value: request.oldValue, path: "$refactor" },
      resolution,
    };
    const planned = createReferenceValueRenamePlan(documents, selected, request.newValue);
    if (!planned.success) throw new VisualBridgeMcpError(`refactor.${planned.reason}`, planned.message);
    const targetDocument = documents.find((document) => (
      document.projectId === resolution.candidates[0]?.location?.projectId
      && document.documentTypeId === resolution.candidates[0]?.location?.documentTypeId
      && resolution.candidates[0]?.location?.path !== undefined
      && document.sourcePaths.includes(resolution.candidates[0]!.location!.path)
    ));
    if (targetDocument === undefined) {
      throw new VisualBridgeMcpError("refactor.targetNotIndexed", "The resolved target is no longer an indexed document.");
    }
    const affected = uniqueDocuments([
      targetDocument,
      ...planned.plan.changes.flatMap((change) => {
        const document = documents.find((candidate) => documentIndexKey(candidate) === documentIndexKey(change));
        return document === undefined ? [] : [document];
      }),
    ]);
    const writes = (await Promise.all(affected.map((document) => this.prepareDocument(
      project,
      document,
      new Set(planned.plan.changes
        .filter((change) => documentIndexKey(change) === documentIndexKey(document))
        .map((change) => change.occurrencePath)),
      planned.plan,
      documentIndexKey(document) === documentIndexKey(targetDocument),
    )))).flat()
      .filter((write) => !write.before.equals(write.after))
      .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    if (writes.length === 0) throw new VisualBridgeMcpError("refactor.noChanges", "The refactor did not produce source changes.");
    const dependencies = await loadDependencyHashes(project);
    const previewHash = hashStable({
      projectFile: project.projectFile,
      definition: request.definition,
      oldValue: request.oldValue,
      newValue: request.newValue,
      changes: planned.plan.changes,
      dependencies,
      sources: writes.map((write) => ({ path: write.path, baseHash: hashBytes(write.before), nextHash: hashBytes(write.after) })),
    });
    return { project, plan: planned.plan, writes, dependencies, previewHash };
  }

  private async prepareDocument(
    project: ProjectContext,
    indexed: IndexedDocument,
    occurrencePaths: ReadonlySet<string>,
    plan: ReferenceValueRenamePlan,
    isTarget: boolean,
  ): Promise<readonly PreparedWrite[]> {
    const loaded = await this.documents.loadDocument({
      path: indexed.path,
      editor: indexed.editor,
      projectFile: project.projectFile,
      documentTypeId: indexed.documentTypeId,
      includeProviderValidation: false,
      skipReferenceValidation: true,
    });
    if (loaded.document === undefined) throw invalidSource(indexed.path, loaded.parsed.diagnostics);
    const facet = loaded.module.facet;
    let document: unknown = loaded.document;
    if (occurrencePaths.size > 0) {
      assertOccurrenceValues(loaded.occurrences, occurrencePaths, plan.oldValue, indexed.path);
      const replaced = facet.replaceReferenceValues(document, loaded.context, occurrencePaths, plan.newValue);
      if (!replaced.success) throw invalidSource(indexed.path, replaced.diagnostics);
      document = replaced.document;
    }
    if (isTarget) {
      const location = plan.target.location!;
      if (plan.kind === "document") {
        const descriptor = facet.describe(document, loaded.context);
        assertDocumentTarget(descriptor.documentId, plan, indexed.path);
        if (facet.renameDocumentId === undefined) throw incompatibleTarget(plan.kind, indexed.editor);
        const renamed = facet.renameDocumentId(document, requireString(plan.newValue), loaded.context);
        if (!renamed.success) throw invalidSource(indexed.path, renamed.diagnostics);
        document = renamed.document;
      } else {
        if (facet.renameTarget === undefined) throw incompatibleTarget(plan.kind, indexed.editor);
        // 引用定位（location）没有 `kind`：模块用 `plan.kind` 判定自己能否处理这个目标。
        const target = {
          ...location,
          kind: plan.kind,
        } as unknown as Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>;
        const renamed = facet.renameTarget(
          document,
          target,
          plan.oldValue,
          plan.newValue,
          loaded.context,
        );
        if (!renamed.success) {
          throw new VisualBridgeMcpError(
            "refactor.targetChanged",
            `Reference target '${plan.kind}' at '${indexed.path}' could not be renamed.`,
            renamed.diagnostics,
          );
        }
        document = renamed.document;
      }
    }
    const rendered = await this.documents.renderDocument(loaded, document);
    return rendered.map((entry) => ({
      path: entry.path,
      absolutePath: entry.absolutePath,
      before: entry.before,
      after: entry.after,
    }));
  }
}

const PREVIEW_INVALIDATION_CODES = new Set([
  "file.invalidUtf8",
  "path.notFound",
  "project.notFound",
  "refactor.duplicateTarget",
  "refactor.invalidSource",
  "refactor.noChanges",
  "refactor.occurrenceChanged",
  "refactor.targetNotIndexed",
  "refactor.unresolvedTarget",
]);

function isPreviewInvalidation(code: string): boolean {
  return PREVIEW_INVALIDATION_CODES.has(code) || code.startsWith("document.") || code.startsWith("catalog.");
}

function previewResult(prepared: PreparedRefactor): Record<string, unknown> {
  return {
    status: "preview",
    projectFile: prepared.project.projectFile,
    previewHash: prepared.previewHash,
    kind: prepared.plan.kind,
    oldValue: prepared.plan.oldValue,
    newValue: prepared.plan.newValue,
    target: prepared.plan.target,
    changes: prepared.plan.changes,
    dependencies: prepared.dependencies,
    sources: prepared.writes.map((write) => ({
      path: write.path,
      baseHash: hashBytes(write.before),
      nextHash: hashBytes(write.after),
    })),
    baseHashes: Object.fromEntries(prepared.writes.map((write) => [write.path, hashBytes(write.before)])),
  };
}

async function loadDependencyHashes(
  project: ProjectContext,
): Promise<readonly { readonly path: string; readonly baseHash: string }[]> {
  const paths = [...new Set(project.definition.documentTypes.flatMap((documentType) => documentType.catalogs))].sort(compareUtf16CodeUnits);
  const catalogs = await Promise.all(paths.map(async (catalogPath) => ({
    path: catalogPath,
    baseHash: hashBytes(await readFile(await resolveExistingProjectPath(project, catalogPath))),
  })));
  return [{ path: project.projectFile, baseHash: hashBytes(await readFile(project.absoluteProjectFile)) }, ...catalogs];
}

function uniqueDocuments(documents: readonly IndexedDocument[]): readonly IndexedDocument[] {
  return [...new Map(documents.map((document) => [documentIndexKey(document), document])).values()]
    .sort((left, right) => compareUtf16CodeUnits(documentIndexKey(left), documentIndexKey(right)));
}

function assertOccurrenceValues(
  occurrences: readonly ReferenceOccurrence[],
  paths: ReadonlySet<string>,
  expectedValue: string | number,
  documentPath: string,
): void {
  for (const occurrencePath of paths) {
    if (occurrences.filter((occurrence) => (
      occurrence.path === occurrencePath && referenceValuesEqual(occurrence.value, expectedValue)
    )).length !== 1) {
      throw new VisualBridgeMcpError(
        "refactor.occurrenceChanged",
        `Reference occurrence '${documentPath}: ${occurrencePath}' changed after indexing.`,
      );
    }
  }
}

function assertDocumentTarget(currentId: string | undefined, plan: ReferenceValueRenamePlan, sourcePath: string): void {
  if (plan.target.location?.documentId !== plan.oldValue || currentId !== plan.oldValue) {
    throw new VisualBridgeMcpError("refactor.targetChanged", `The document ID in '${sourcePath}' changed after indexing.`);
  }
}

function requireString(value: string | number): string {
  if (typeof value !== "string") throw new VisualBridgeMcpError("refactor.invalidValue", "Document, Graph element, and Entity component IDs must be strings.");
  return value;
}

function incompatibleTarget(kind: string, editor: string): VisualBridgeMcpError {
  return new VisualBridgeMcpError("refactor.incompatibleTarget", `Reference target '${kind}' cannot be stored in a ${editor} document.`);
}

function invalidSource(sourcePath: string, diagnostics: readonly unknown[]): VisualBridgeMcpError {
  return new VisualBridgeMcpError("refactor.invalidSource", `Source '${sourcePath}' is invalid and cannot participate in a project refactor.`, diagnostics);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareUtf16CodeUnits(left, right)).map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}

function sameHashManifest(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => compareUtf16CodeUnits(a, b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => compareUtf16CodeUnits(a, b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
