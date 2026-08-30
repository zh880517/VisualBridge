import {
  compareUtf16CodeUnits,
  createReferenceSearchCursor,
  type JsonValue,
  type ProjectProviderDiagnostic,
  type ProjectProviderDocumentSnapshot,
  type ProjectProviderReferenceResolveResult,
  type ProjectProviderReferenceSearchResult,
  type ProjectProviderReferenceValidateTargetResult,
  type ProjectProviderValidatorDiagnosticsResult,
  type ReferenceCandidate,
  type ReferenceProvider,
  type VisualBridgeProjectDefinition,
} from "@visualbridge/core";
import { randomUUID } from "node:crypto";
import {
  ProjectProviderExternalModificationError,
  ProjectProviderRuntime,
  ProjectProviderRuntimeError,
  type ProjectProviderInvocationOptions,
  type ProjectProviderLogSink,
  type ProjectProviderProjectChange,
  type ProjectProviderRuntimeOptions,
  type ProjectProviderSourceManifestEntry,
} from "./projectProviderRuntime";

export interface ProjectProviderHostOptions {
  readonly projectRoot: string;
  readonly projectHash: string;
  readonly project: VisualBridgeProjectDefinition;
  readonly allowedEntryPaths: readonly string[];
  readonly captureSourceManifest: () => Promise<readonly ProjectProviderSourceManifestEntry[]>;
  readonly isDeclaredDocument: (documentTypeId: string, path: string) => boolean | Promise<boolean>;
  readonly log?: ProjectProviderLogSink;
  readonly runtime?: Pick<
    ProjectProviderRuntimeOptions,
    "initializeTimeoutMs" | "requestTimeoutMs" | "shutdownTimeoutMs" | "cancellationGraceMs" | "restart"
  >;
}

export interface ProjectProviderValidationResult {
  readonly diagnostics: readonly ProjectProviderDiagnostic[];
  readonly unavailableProviderIds: readonly string[];
  readonly externalModification?: ProjectProviderExternalModificationError;
}

interface ProviderSlot {
  readonly definition: VisualBridgeProjectDefinition["providers"][number];
  readonly instanceId: string;
  readonly runtime?: ProjectProviderRuntime;
  readonly createError?: unknown;
}

export class ProjectProviderHost implements AsyncDisposable {
  private constructor(
    private readonly options: ProjectProviderHostOptions,
    private readonly slots: readonly ProviderSlot[],
  ) {}

  public static async create(options: ProjectProviderHostOptions): Promise<ProjectProviderHost> {
    const slots = await Promise.all(options.project.providers.map(async (definition): Promise<ProviderSlot> => {
      try {
        const runtime = await ProjectProviderRuntime.create({
          projectRoot: options.projectRoot,
          projectId: options.project.projectId,
          projectHash: options.projectHash,
          definition,
          allowedEntryPaths: options.allowedEntryPaths,
          ...(options.log === undefined ? {} : { log: options.log }),
          ...options.runtime,
        });
        return { definition, instanceId: randomUUID(), runtime };
      } catch (createError) {
        options.log?.({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "provider.createFailed",
          projectId: options.project.projectId,
          providerId: definition.id,
          state: "stopped",
          message: formatError(createError),
        });
        return { definition, instanceId: randomUUID(), createError };
      }
    }));
    return new ProjectProviderHost(options, slots);
  }

  public get referenceProviders(): readonly ReferenceProvider[] {
    return this.slots.flatMap((slot) => slot.definition.capabilities.reference?.kinds.map((kind) => ({
      kind,
      validateTarget: (target: Readonly<Record<string, JsonValue>>, signal?: AbortSignal) => (
        this.validateTarget(slot, kind, target, signal)
      ),
      search: async (request) => {
        const result = await this.request<ProjectProviderReferenceSearchResult>(slot, "reference/search", {
          kind,
          target: request.target,
          query: request.query,
          limit: request.limit,
        }, request.signal);
        if (result.status !== "ok") throw providerBusinessError(slot.definition.id, result);
        if (result.candidates.length > request.limit) {
          throw protocolViolation(slot.definition.id, "Reference search returned more candidates than requested.");
        }
        await this.assertCandidates(slot, result.candidates, kind, request.target);
        return result.candidates;
      },
      searchPage: async (request) => {
        const continuation = request.cursor?.providerContinuation;
        if (request.cursor !== undefined && continuation === undefined) {
          return cursorFailure("cursor.invalid", "Provider-backed Reference cursor is missing its continuation state.");
        }
        if (continuation !== undefined && continuation.providerId !== slot.definition.id) {
          return cursorFailure("cursor.snapshotChanged", "Project Provider instance changed after the cursor was issued.");
        }
        if (continuation !== undefined && continuation.instanceId !== slot.instanceId) {
          return cursorFailure("cursor.snapshotChanged", "Project Provider host instance changed after the cursor was issued.");
        }
        if (continuation !== undefined && slot.runtime !== undefined
          && await slot.runtime.captureEntryHash() !== continuation.entryHash) {
          return cursorFailure("cursor.snapshotChanged", "Project Provider entry changed after the cursor was issued.");
        }
        const result = await this.request<ProjectProviderReferenceSearchResult>(slot, "reference/search", {
          kind,
          target: request.target,
          query: request.query,
          limit: request.limit,
          ...(continuation === undefined ? {} : {
            cursor: continuation.cursor,
            snapshotHash: continuation.snapshotHash,
          }),
        }, request.signal);
        const generation = slot.runtime?.generation;
        if (generation === undefined) {
          throw protocolViolation(slot.definition.id, "Reference search completed without an active Provider generation.");
        }
        const entryHash = await slot.runtime!.captureEntryHash();
        if (continuation !== undefined && entryHash !== continuation.entryHash) {
          return cursorFailure("cursor.snapshotChanged", "Project Provider entry changed after the cursor was issued.");
        }
        if (continuation !== undefined && generation !== continuation.generation) {
          return cursorFailure("cursor.snapshotChanged", "Project Provider process generation changed after the cursor was issued.");
        }
        if (result.status === "cursor.invalid" || result.status === "cursor.queryMismatch"
          || result.status === "cursor.snapshotChanged") {
          return cursorFailure(result.status, result.message);
        }
        if (result.status !== "ok") throw providerBusinessError(slot.definition.id, result);
        if (continuation !== undefined && result.snapshotHash !== continuation.snapshotHash) {
          return cursorFailure("cursor.snapshotChanged", "Project Provider snapshot changed after the cursor was issued.");
        }
        if (result.candidates.length > request.limit) {
          throw protocolViolation(slot.definition.id, "Reference search returned more candidates than requested.");
        }
        if (result.nextCursor !== undefined && result.candidates.length === 0) {
          throw protocolViolation(slot.definition.id, "Reference search returned a continuation for an empty page.");
        }
        await this.assertCandidates(slot, result.candidates, kind, request.target);
        const last = result.candidates.at(-1);
        return {
          status: "ok" as const,
          candidates: result.candidates,
          ...(result.nextCursor === undefined || last === undefined ? {} : {
            nextCursor: createReferenceSearchCursor(
              kind,
              request.target,
              request.query,
              request.snapshotDependencyKey,
              last,
              {
                providerId: slot.definition.id,
                instanceId: slot.instanceId,
                generation,
                entryHash,
                cursor: result.nextCursor,
                snapshotHash: result.snapshotHash,
              },
            ),
          }),
        };
      },
      resolve: async (request) => {
        const result = await this.request<ProjectProviderReferenceResolveResult>(slot, "reference/resolve", {
          kind,
          target: request.target,
          value: request.value,
        }, request.signal);
        if (result.status === "invalidTarget" || result.status === "providerUnavailable") {
          throw providerBusinessError(slot.definition.id, result);
        }
        await this.assertCandidates(slot, result.candidates, kind, request.target, request.value);
        return result.candidates;
      },
    })) ?? []);
  }

  public get cacheGenerationKey(): string {
    return JSON.stringify(this.slots.map((slot) => ({
      providerId: slot.definition.id,
      generation: slot.runtime?.generation ?? -1,
      state: slot.runtime?.state ?? "unavailable",
    })));
  }

  public async validateDocuments(
    documents: readonly ProjectProviderDocumentSnapshot[],
    signal?: AbortSignal,
  ): Promise<ProjectProviderValidationResult> {
    assertUniqueDocuments(documents);
    const diagnostics: ProjectProviderDiagnostic[] = [];
    const unavailableProviderIds: string[] = [];
    let externalModification: ProjectProviderExternalModificationError | undefined;
    for (const slot of this.slots) {
      const declaredTypes = new Set(slot.definition.capabilities.validator?.documentTypes ?? []);
      const selected = documents.filter((document) => declaredTypes.has(document.documentTypeId));
      if (selected.length === 0) continue;
      try {
        const result = await this.request<ProjectProviderValidatorDiagnosticsResult>(
          slot,
          "validator/diagnostics",
          {
            project: { projectId: this.options.project.projectId, projectHash: this.options.projectHash },
            documents: selected,
          },
          signal,
        );
        if (result.status === "providerUnavailable") {
          unavailableProviderIds.push(slot.definition.id);
          diagnostics.push(...unavailableDiagnostics(slot.definition.id, selected, result.message));
          continue;
        }
        const sourceKeys = new Set(selected.map(documentKey));
        for (const diagnostic of result.diagnostics) {
          if (!sourceKeys.has(documentKey(diagnostic)) || !declaredTypes.has(diagnostic.documentTypeId)) {
            throw protocolViolation(
              slot.definition.id,
              `Validator diagnostic escaped the supplied semantic snapshot: '${diagnostic.documentTypeId}:${diagnostic.documentPath}'.`,
            );
          }
          diagnostics.push(diagnostic);
        }
      } catch (errorValue) {
        unavailableProviderIds.push(slot.definition.id);
        if (errorValue instanceof ProjectProviderExternalModificationError) {
          externalModification ??= errorValue;
          diagnostics.push(...externalModificationDiagnostics(slot.definition.id, selected, errorValue));
        } else {
          diagnostics.push(...unavailableDiagnostics(slot.definition.id, selected, formatError(errorValue)));
        }
      }
    }
    return {
      diagnostics: diagnostics.sort(compareDiagnostics),
      unavailableProviderIds: [...new Set(unavailableProviderIds)].sort(compareUtf16CodeUnits),
      ...(externalModification === undefined ? {} : { externalModification }),
    };
  }

  public async projectChanged(change: ProjectProviderProjectChange, signal?: AbortSignal): Promise<void> {
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.runtime?.capabilities === undefined) return;
      await slot.runtime.projectChanged(change, this.invocation(signal));
    }));
  }

  public async dispose(): Promise<void> {
    await Promise.all(this.slots.map((slot) => slot.runtime?.dispose().catch(() => undefined)));
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private async validateTarget(
    slot: ProviderSlot,
    kind: string,
    target: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.request<ProjectProviderReferenceValidateTargetResult>(
      slot,
      "reference/validateTarget",
      { kind, target },
      signal,
    );
    if (result.status === "valid") return undefined;
    if (result.status === "invalidTarget") return result.message;
    throw providerBusinessError(slot.definition.id, result);
  }

  private async request<T>(
    slot: ProviderSlot,
    method: "reference/search" | "reference/resolve" | "reference/validateTarget" | "validator/diagnostics",
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (slot.runtime === undefined) {
      throw new ProjectProviderRuntimeError(
        "provider.unavailable",
        `Project Provider '${slot.definition.id}' is unavailable: ${formatError(slot.createError)}.`,
        { providerId: slot.definition.id },
      );
    }
    const capabilities = await slot.runtime.start(this.invocation(signal));
    if (method.startsWith("reference/")) {
      const kind = params.kind;
      if (typeof kind !== "string" || !capabilities.reference?.kinds.includes(kind)) {
        throw new ProjectProviderRuntimeError(
          "provider.capabilityUnavailable",
          `Project Provider '${slot.definition.id}' did not activate reference kind '${String(kind)}'.`,
          { providerId: slot.definition.id, kind },
        );
      }
    } else if (method === "validator/diagnostics") {
      const requestedTypes = Array.isArray(params.documents)
        ? params.documents.flatMap((document) => (
          typeof document === "object" && document !== null && "documentTypeId" in document
            && typeof document.documentTypeId === "string"
            ? [document.documentTypeId]
            : []
        ))
        : [];
      const activeTypes = new Set(capabilities.validator?.documentTypes ?? []);
      const inactiveTypes = requestedTypes.filter((documentTypeId) => !activeTypes.has(documentTypeId));
      if (inactiveTypes.length > 0) {
        throw new ProjectProviderRuntimeError(
          "provider.capabilityUnavailable",
          `Project Provider '${slot.definition.id}' did not activate validator document type(s): ${inactiveTypes.join(", ")}.`,
          { providerId: slot.definition.id, documentTypes: inactiveTypes },
        );
      }
    }
    return await slot.runtime.request(method, params, this.invocation(signal)) as T;
  }

  private invocation(signal?: AbortSignal): ProjectProviderInvocationOptions {
    return {
      captureSourceManifest: this.options.captureSourceManifest,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private async assertCandidates(
    slot: ProviderSlot,
    candidates: readonly ReferenceCandidate[],
    kind: string,
    target: Readonly<Record<string, JsonValue>>,
    resolvedValue?: string | number,
  ): Promise<void> {
    const expectedTarget = canonicalJson(target);
    for (const candidate of candidates) {
      if (candidate.kind !== kind || canonicalJson(candidate.target) !== expectedTarget) {
        throw protocolViolation(slot.definition.id, "Reference candidate kind or target does not match the request.");
      }
      if (resolvedValue !== undefined
        && (typeof candidate.value !== typeof resolvedValue || candidate.value !== resolvedValue)) {
        throw protocolViolation(slot.definition.id, "Resolved reference candidate value does not match the request.");
      }
      if (candidate.location !== undefined
        && (candidate.location.projectId !== this.options.project.projectId
          || !await this.options.isDeclaredDocument(candidate.location.documentTypeId, candidate.location.path))) {
        throw protocolViolation(slot.definition.id, "Reference candidate location is outside the current declared Project.");
      }
    }
  }
}

function providerBusinessError(
  providerId: string,
  result: { readonly status: string; readonly message?: string },
): ProjectProviderRuntimeError {
  return new ProjectProviderRuntimeError(
    result.status === "invalidTarget" ? "provider.invalidTarget" : "provider.unavailable",
    result.message ?? `Project Provider '${providerId}' returned '${result.status}'.`,
    { providerId, status: result.status },
  );
}

function cursorFailure(
  status: "cursor.invalid" | "cursor.queryMismatch" | "cursor.snapshotChanged",
  message: string,
) {
  return { status, candidates: [] as const, message };
}

function protocolViolation(providerId: string, message: string): ProjectProviderRuntimeError {
  return new ProjectProviderRuntimeError("provider.protocolViolation", message, { providerId });
}

function unavailableDiagnostics(
  providerId: string,
  documents: readonly ProjectProviderDocumentSnapshot[],
  message: string,
): readonly ProjectProviderDiagnostic[] {
  return documents.map((document) => ({
    documentTypeId: document.documentTypeId,
    documentPath: document.path,
    severity: "warning",
    code: "provider.unavailable",
    path: "$",
    message: `Project Provider '${providerId}' is unavailable; stored content is preserved. ${message}`,
  }));
}

function externalModificationDiagnostics(
  providerId: string,
  documents: readonly ProjectProviderDocumentSnapshot[],
  errorValue: ProjectProviderExternalModificationError,
): readonly ProjectProviderDiagnostic[] {
  return documents.map((document) => ({
    documentTypeId: document.documentTypeId,
    documentPath: document.path,
    severity: "error",
    code: "provider.externalModification",
    path: "$",
    message: `Project Provider '${providerId}' changed Authoring sources outside a transaction: ${errorValue.changedPaths.join(", ")}.`,
  }));
}

function assertUniqueDocuments(documents: readonly ProjectProviderDocumentSnapshot[]): void {
  const seen = new Set<string>();
  for (const document of documents) {
    const key = documentKey(document);
    if (seen.has(key)) {
      throw new ProjectProviderRuntimeError(
        "provider.duplicateDocumentSnapshot",
        `Duplicate Project Provider document snapshot '${document.documentTypeId}:${document.path}'.`,
      );
    }
    seen.add(key);
  }
}

function documentKey(value: { readonly documentTypeId: string; readonly path?: string; readonly documentPath?: string }): string {
  return `${value.documentTypeId}\u0000${value.documentPath ?? value.path ?? ""}`;
}

function canonicalJson(value: JsonValue | Readonly<Record<string, JsonValue>>): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(record).sort(compareUtf16CodeUnits).map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareDiagnostics(left: ProjectProviderDiagnostic, right: ProjectProviderDiagnostic): number {
  return compareUtf16CodeUnits(
    `${left.documentTypeId}\u0000${left.documentPath}\u0000${left.path}\u0000${left.code}\u0000${left.message}`,
    `${right.documentTypeId}\u0000${right.documentPath}\u0000${right.path}\u0000${right.code}\u0000${right.message}`,
  );
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
