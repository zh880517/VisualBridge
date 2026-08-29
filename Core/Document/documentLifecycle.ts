import type { JsonValue } from "../Form/field";
import type { IndexedDocument } from "./documentIndex";
import type {
  ReferenceDefinition,
  ReferenceLocation,
} from "../Reference/reference";

export const DOCUMENT_LIFECYCLE_PLAN_VERSION = 1;

export type DocumentLifecycleKind = "create" | "copy" | "move" | "delete";
export type StableIdentityValue = string | number;
export type BaseHashManifest = Readonly<Record<string, string>>;

export interface DocumentLifecycleSelector {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly editor: string;
  readonly path: string;
}

export interface OwnedStableIdentity {
  /** Adapter-defined key that is unique and stable within the source snapshot. */
  readonly identityKey: string;
  readonly kind: string;
  /** Identities with the same collision scope may not map to the same value. */
  readonly collisionScope: string;
  readonly value: StableIdentityValue;
  readonly reference?: {
    readonly definition: ReferenceDefinition;
    /** Host planning supplies the physical Project location; built-in adapters only declare semantics. */
    readonly location?: ReferenceLocation;
  };
}

export interface OwnedStableIdentityCollisionDocument {
  readonly document: DocumentLifecycleSelector;
  /** Identities must come from that document's registered lifecycle Adapter. */
  readonly ownedIdentities: readonly OwnedStableIdentity[];
}

export interface OwnedStableIdentityCollisionEntry {
  readonly document: DocumentLifecycleSelector;
  readonly identity: OwnedStableIdentity;
}

export interface OwnedStableIdentityCollisionIndex {
  readonly entries: readonly OwnedStableIdentityCollisionEntry[];
}

export type OwnedStableIdentityCollisionTarget = Pick<
  OwnedStableIdentity,
  "identityKey" | "kind" | "collisionScope" | "value"
>;

export interface StableIdentityRemap {
  readonly identityKey: string;
  readonly from: StableIdentityValue;
  readonly to: StableIdentityValue;
}

export interface DocumentLifecycleCreateOperation {
  readonly kind: "create";
  readonly target: DocumentLifecycleSelector;
  /** Strictly JSON data interpreted by the selected built-in lifecycle adapter. */
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface DocumentLifecycleCopyOperation {
  readonly kind: "copy";
  readonly source: DocumentLifecycleSelector;
  readonly target: DocumentLifecycleSelector;
  /** Every owned identity reported by the source adapter must occur exactly once. */
  readonly stableIdRemap: readonly StableIdentityRemap[];
}

export interface DocumentLifecycleMoveOperation {
  readonly kind: "move";
  readonly source: DocumentLifecycleSelector;
  readonly target: DocumentLifecycleSelector;
}

export type DocumentLifecycleDeleteTarget =
  | { readonly kind: "document" }
  | { readonly kind: "entity.component"; readonly componentId: string }
  | {
      readonly kind: "graph.element";
      readonly graphId: string;
      readonly elementKind: "graph";
      readonly elementId: string;
    }
  | {
      readonly kind: "graph.element";
      readonly graphId: string;
      readonly elementKind: "node" | "interfacePort";
      readonly elementId: string;
    }
  | {
      readonly kind: "graph.element";
      readonly graphId: string;
      readonly elementKind: "dynamicPort";
      readonly elementId: string;
      readonly nodeId: string;
    }
  | { readonly kind: "table.row"; readonly sheetId: string; readonly rowId: string };

export interface DocumentLifecycleDeleteOperation {
  readonly kind: "delete";
  readonly source: DocumentLifecycleSelector;
  readonly target: DocumentLifecycleDeleteTarget;
}

export type DocumentLifecycleOperation =
  | DocumentLifecycleCreateOperation
  | DocumentLifecycleCopyOperation
  | DocumentLifecycleMoveOperation
  | DocumentLifecycleDeleteOperation;

export interface DocumentLifecyclePreviewRequest {
  readonly action: "preview";
  readonly operation: DocumentLifecycleOperation;
}

export interface DocumentLifecycleApplyRequest {
  readonly action: "apply";
  readonly operation: DocumentLifecycleOperation;
  readonly previewHash: string;
  readonly planPayload: string;
  readonly baseHashes: BaseHashManifest;
  readonly dependencies: readonly DocumentLifecycleDependency[];
}

export type DocumentLifecycleRequest = DocumentLifecyclePreviewRequest | DocumentLifecycleApplyRequest;

export interface DocumentLifecycleReferenceOccurrence {
  readonly document: DocumentLifecycleSelector;
  readonly path: string;
  readonly definition: ReferenceDefinition;
  readonly value: StableIdentityValue;
}

export type DocumentLifecycleReferenceImpact =
  | {
      readonly kind: "internalRetarget";
      readonly occurrence: DocumentLifecycleReferenceOccurrence;
      readonly targetIdentityKey: string;
      readonly replacement: StableIdentityValue;
    }
  | {
      readonly kind: "externalInbound";
      readonly occurrence: DocumentLifecycleReferenceOccurrence;
      readonly targetIdentityKey: string;
    }
  | {
      readonly kind: "outboundPreserved";
      readonly occurrence: DocumentLifecycleReferenceOccurrence;
      /** Absent only when an allowMissing reference intentionally has no current target. */
      readonly target?: ReferenceLocation;
    }
  | {
      readonly kind: "targetLocationChanged";
      readonly identityKey: string;
      readonly from: ReferenceLocation;
      readonly to: ReferenceLocation;
    };

export type DocumentLifecycleBlockerCode =
  | "identity.duplicateOwnedKey"
  | "identity.duplicateRemapKey"
  | "identity.remapMissing"
  | "identity.remapUnexpected"
  | "identity.remapManifestMismatch"
  | "identity.sourceMismatch"
  | "identity.valueTypeMismatch"
  | "identity.sameValue"
  | "identity.targetCollision"
  | "reference.inbound"
  | "reference.unresolvedInternal"
  | "reference.introducedError"
  | "plan.unsupportedVersion"
  | "mutation.duplicateTarget"
  | "mutation.conflict"
  | "source.invalid"
  | "source.notFound"
  | "target.exists"
  | "target.notDeclared"
  | "target.typeMismatch";

export interface DocumentLifecycleBlocker {
  readonly code: DocumentLifecycleBlockerCode;
  readonly message: string;
  readonly path?: string;
  readonly identityKey?: string;
  readonly occurrence?: DocumentLifecycleReferenceOccurrence;
}

export type DocumentLifecycleDependencyKind = "project" | "catalog" | "documentSet" | "referenceIndex";

export interface DocumentLifecycleDependency {
  readonly kind: DocumentLifecycleDependencyKind;
  /** Stable logical dependency identity; paths are data, not identity. */
  readonly key: string;
  readonly hash: string;
  readonly paths: readonly string[];
}

export interface DocumentLifecyclePhysicalSourceHash {
  readonly path: string;
  readonly hash: string;
}

export interface DocumentLifecycleDependencySnapshot {
  readonly projectId: string;
  readonly project: DocumentLifecyclePhysicalSourceHash;
  /** All Project Catalog sources, aggregated across Document Types. */
  readonly catalogs: readonly DocumentLifecyclePhysicalSourceHash[];
  /** Every physical source that belongs to the current semantic document set. */
  readonly documents: readonly DocumentLifecyclePhysicalSourceHash[];
  /** The semantic index used to classify Reference occurrences and candidates. */
  readonly index: readonly IndexedDocument[];
}

export type DocumentLifecycleMutation =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly nextHash: string;
      readonly targetMustBeAbsent: true;
    }
  | {
      readonly kind: "replace";
      readonly path: string;
      readonly baseHash: string;
      readonly nextHash: string;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly baseHash: string;
    }
  | {
      readonly kind: "move";
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly baseHash: string;
      readonly targetMustBeAbsent: true;
    };

export interface DocumentLifecyclePlan {
  readonly version: typeof DOCUMENT_LIFECYCLE_PLAN_VERSION;
  readonly operation: DocumentLifecycleOperation;
  readonly ownedIdentities: readonly OwnedStableIdentity[];
  readonly stableIdRemap: readonly StableIdentityRemap[];
  readonly referenceImpacts: readonly DocumentLifecycleReferenceImpact[];
  readonly blockers: readonly DocumentLifecycleBlocker[];
  readonly dependencies: readonly DocumentLifecycleDependency[];
  readonly baseHashes: BaseHashManifest;
  readonly mutations: readonly DocumentLifecycleMutation[];
}

export interface DocumentLifecyclePreview {
  readonly status: "preview";
  readonly previewHash: string;
  readonly planPayload: string;
  readonly plan: DocumentLifecyclePlan;
}

export interface StableIdentityRemapValidationSuccess {
  readonly success: true;
  readonly remap: readonly StableIdentityRemap[];
}

export interface StableIdentityRemapValidationFailure {
  readonly success: false;
  readonly blockers: readonly DocumentLifecycleBlocker[];
}

export type StableIdentityRemapValidationResult =
  | StableIdentityRemapValidationSuccess
  | StableIdentityRemapValidationFailure;

export type DocumentLifecycleApplyConflictReason =
  | "operationChanged"
  | "baseHashMismatch"
  | "dependencyChanged"
  | "planChanged"
  | "previewHashMismatch";

export type DocumentLifecyclePrepareApplyResult =
  | { readonly success: true; readonly status: "ready"; readonly plan: DocumentLifecyclePlan }
  | {
      readonly success: false;
      readonly status: "blocked";
      readonly blockers: readonly DocumentLifecycleBlocker[];
    }
  | {
      readonly success: false;
      readonly status: "conflict";
      readonly reason: DocumentLifecycleApplyConflictReason;
      readonly message: string;
    };

export type DocumentLifecyclePlanBuilder = (
  operation: DocumentLifecycleOperation,
) => DocumentLifecyclePlan | Promise<DocumentLifecyclePlan>;

export type DocumentLifecyclePayloadHasher = (payload: string) => string | Promise<string>;

/**
 * Builds the Project-wide collision index from authoritative lifecycle Adapter output. Hosts
 * must not infer identity kinds or scopes from paths, extensions, Reference definitions or IDs.
 */
export function buildOwnedStableIdentityCollisionIndex(
  documents: readonly OwnedStableIdentityCollisionDocument[],
): OwnedStableIdentityCollisionIndex {
  const entries = documents.flatMap((document) => document.ownedIdentities.map((identity) => ({
    document: cloneCanonical(document.document) as unknown as DocumentLifecycleSelector,
    identity: cloneCanonical(identity) as unknown as OwnedStableIdentity,
  }))).sort((left, right) => compareKeyThenCanonical(
    ownedStableIdentityCollisionEntryKey(left),
    ownedStableIdentityCollisionEntryKey(right),
    left,
    right,
  ));
  return { entries };
}

export function validateOwnedStableIdentityTargetCollisions(
  index: OwnedStableIdentityCollisionIndex,
  targets: readonly OwnedStableIdentityCollisionTarget[],
): readonly DocumentLifecycleBlocker[] {
  const existingByTarget = new Map<string, OwnedStableIdentityCollisionEntry[]>();
  for (const entry of index.entries) {
    const key = ownedStableIdentityValueKey(entry.identity);
    const existing = existingByTarget.get(key);
    if (existing === undefined) existingByTarget.set(key, [entry]);
    else existing.push(entry);
  }
  const blockers = targets.flatMap((target): readonly DocumentLifecycleBlocker[] => {
    const collisions = existingByTarget.get(ownedStableIdentityValueKey(target));
    if (collisions === undefined || collisions.length === 0) return [];
    const first = collisions[0]!;
    return [{
      code: "identity.targetCollision",
      identityKey: target.identityKey,
      path: first.document.path,
      message: `Stable identity target '${String(target.value)}' collides with '${first.identity.identityKey}' in '${first.document.path}'.`,
    }];
  });
  return sortBlockers(blockers);
}

export function remapOwnedStableIdentityCollisionTargets(
  ownedIdentities: readonly OwnedStableIdentity[],
  remap: readonly StableIdentityRemap[],
): readonly OwnedStableIdentityCollisionTarget[] {
  const remapByKey = new Map(remap.map((entry) => [entry.identityKey, entry]));
  return ownedIdentities.flatMap((identity): readonly OwnedStableIdentityCollisionTarget[] => {
    const replacement = remapByKey.get(identity.identityKey)?.to;
    return replacement === undefined ? [] : [{
      identityKey: identity.identityKey,
      kind: identity.kind,
      collisionScope: identity.collisionScope,
      value: replacement,
    }];
  });
}

/** Locale-independent lexicographic total order over JavaScript UTF-16 code units. */
export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Builds the one canonical dependency manifest shared by every Host. Absolute paths, display
 * titles and diagnostics are deliberately excluded: only authoritative Project/Catalog bytes,
 * the physical document set and normalized Reference resolution state participate in the hash.
 */
export async function buildCanonicalDocumentLifecycleDependencies(
  snapshot: DocumentLifecycleDependencySnapshot,
  hashPayload: DocumentLifecyclePayloadHasher,
): Promise<readonly DocumentLifecycleDependency[]> {
  const project = normalizePhysicalSources([snapshot.project])[0]!;
  const catalogs = normalizePhysicalSources(snapshot.catalogs);
  const documents = normalizePhysicalSources(snapshot.documents);
  const references = snapshot.index.flatMap((document) => document.references.map((reference) => ({
    document: {
      projectId: document.projectId,
      documentTypeId: document.documentTypeId,
      editor: document.editor,
      path: normalizeManifestPath(document.path),
    },
    occurrence: {
      path: reference.occurrence.path,
      definition: reference.occurrence.definition,
      value: reference.occurrence.value,
    },
    resolution: {
      status: reference.resolution.status,
      candidates: reference.resolution.candidates
        .map((candidate) => ({
          kind: candidate.kind,
          target: candidate.target,
          value: candidate.value,
          ...(candidate.location === undefined
            ? {}
            : { location: normalizeReferenceLocation(candidate.location) }),
        }))
        .sort((left, right) => compareUtf16CodeUnits(canonicalJson(left), canonicalJson(right))),
    },
  }))).sort((left, right) => compareUtf16CodeUnits(canonicalJson(left), canonicalJson(right)));
  const projectId = snapshot.projectId;
  return normalizeDependencies([{
    kind: "project",
    key: projectId,
    hash: project.hash,
    paths: [project.path],
  }, {
    kind: "catalog",
    key: projectId,
    hash: await hashPayload(canonicalJson(catalogs)),
    paths: catalogs.map((source) => source.path),
  }, {
    kind: "documentSet",
    key: projectId,
    hash: await hashPayload(canonicalJson(documents)),
    paths: documents.map((source) => source.path),
  }, {
    kind: "referenceIndex",
    key: projectId,
    hash: await hashPayload(canonicalJson(references)),
    paths: documents.map((source) => source.path),
  }]);
}

/**
 * The single host-independent preview boundary. Hosts provide semantic plan construction and
 * hashing, while normalization, canonical payload generation and apply comparison stay shared.
 */
export class DocumentLifecycleService {
  public constructor(
    private readonly planBuilder: DocumentLifecyclePlanBuilder,
    private readonly hashPayload: DocumentLifecyclePayloadHasher,
  ) {}

  public async preview(operation: DocumentLifecycleOperation): Promise<DocumentLifecyclePreview> {
    const normalized = normalizeDocumentLifecyclePlan(await this.planBuilder(operation));
    const payload = canonicalDocumentLifecyclePlanPayload(normalized);
    return createDocumentLifecyclePreview(normalized, await this.hashPayload(payload));
  }

  public prepareApply(
    request: DocumentLifecycleApplyRequest,
    current: DocumentLifecyclePreview,
  ): DocumentLifecyclePrepareApplyResult {
    return prepareDocumentLifecycleApply(request, current);
  }
}

export function validateCompleteStableIdentityRemap(
  ownedIdentities: readonly OwnedStableIdentity[],
  remap: readonly StableIdentityRemap[],
): StableIdentityRemapValidationResult {
  const blockers: DocumentLifecycleBlocker[] = [];
  const ownedByKey = new Map<string, OwnedStableIdentity>();
  for (const identity of ownedIdentities) {
    if (ownedByKey.has(identity.identityKey)) {
      blockers.push(identityBlocker(
        "identity.duplicateOwnedKey",
        identity.identityKey,
        `Owned identity key '${identity.identityKey}' is duplicated.`,
      ));
    } else {
      ownedByKey.set(identity.identityKey, identity);
    }
  }

  const remapByKey = new Map<string, StableIdentityRemap>();
  for (const entry of remap) {
    if (remapByKey.has(entry.identityKey)) {
      blockers.push(identityBlocker(
        "identity.duplicateRemapKey",
        entry.identityKey,
        `Stable identity remap key '${entry.identityKey}' is duplicated.`,
      ));
    } else {
      remapByKey.set(entry.identityKey, entry);
    }
  }

  for (const identity of ownedByKey.values()) {
    const entry = remapByKey.get(identity.identityKey);
    if (entry === undefined) {
      blockers.push(identityBlocker(
        "identity.remapMissing",
        identity.identityKey,
        `Owned identity '${identity.identityKey}' has no explicit remap.`,
      ));
      continue;
    }
    if (!stableIdentityValuesEqual(identity.value, entry.from)) {
      blockers.push(identityBlocker(
        "identity.sourceMismatch",
        identity.identityKey,
        `Stable identity remap '${identity.identityKey}' does not match the source value.`,
      ));
    }
    if (typeof entry.from !== typeof entry.to) {
      blockers.push(identityBlocker(
        "identity.valueTypeMismatch",
        identity.identityKey,
        `Stable identity remap '${identity.identityKey}' changes value type.`,
      ));
    } else if (stableIdentityValuesEqual(entry.from, entry.to)) {
      blockers.push(identityBlocker(
        "identity.sameValue",
        identity.identityKey,
        `Stable identity remap '${identity.identityKey}' must use a different value.`,
      ));
    }
  }

  for (const entry of remapByKey.values()) {
    if (!ownedByKey.has(entry.identityKey)) {
      blockers.push(identityBlocker(
        "identity.remapUnexpected",
        entry.identityKey,
        `Stable identity remap '${entry.identityKey}' does not belong to the source document.`,
      ));
    }
  }

  const targetOwners = new Map<string, string>();
  for (const identity of ownedByKey.values()) {
    const entry = remapByKey.get(identity.identityKey);
    if (entry === undefined || typeof entry.from !== typeof entry.to) continue;
    const targetKey = [identity.kind, identity.collisionScope, typeof entry.to, String(entry.to)].join("\u0000");
    const existing = targetOwners.get(targetKey);
    if (existing !== undefined && existing !== identity.identityKey) {
      blockers.push(identityBlocker(
        "identity.targetCollision",
        identity.identityKey,
        `Stable identities '${existing}' and '${identity.identityKey}' map to the same target value.`,
      ));
    } else {
      targetOwners.set(targetKey, identity.identityKey);
    }
  }

  const stableBlockers = sortBlockers(blockers);
  return stableBlockers.length === 0
    ? { success: true, remap: sortRemap(remap) }
    : { success: false, blockers: stableBlockers };
}

export function normalizeDocumentLifecyclePlan(plan: DocumentLifecyclePlan): DocumentLifecyclePlan {
  const operationRemap = plan.operation.kind === "copy" ? sortRemap(plan.operation.stableIdRemap) : [];
  const declaredRemap = sortRemap(plan.stableIdRemap);
  const remapManifestBlockers = canonicalJson(operationRemap) === canonicalJson(declaredRemap)
    ? []
    : [{
        code: "identity.remapManifestMismatch" as const,
        message: "The lifecycle plan remap does not match the copy operation remap.",
      }];
  const remapValidation = plan.operation.kind === "copy"
    ? validateCompleteStableIdentityRemap(plan.ownedIdentities, operationRemap)
    : undefined;
  const remapBlockers = remapValidation?.success === false ? remapValidation.blockers : [];
  const versionBlockers: readonly DocumentLifecycleBlocker[] = plan.version === DOCUMENT_LIFECYCLE_PLAN_VERSION
    ? []
    : [{
        code: "plan.unsupportedVersion",
        message: `Unsupported lifecycle plan version '${String(plan.version)}'.`,
      }];
  const mutationBlockers = validateMutationPlan(plan.mutations);
  return {
    version: DOCUMENT_LIFECYCLE_PLAN_VERSION,
    operation: normalizeOperation(plan.operation),
    ownedIdentities: [...plan.ownedIdentities]
      .map((identity) => cloneCanonical(identity) as unknown as OwnedStableIdentity)
      .sort((left, right) => compareKeyThenCanonical(left.identityKey, right.identityKey, left, right)),
    stableIdRemap: operationRemap,
    referenceImpacts: [...plan.referenceImpacts]
      .map((impact) => cloneCanonical(impact) as unknown as DocumentLifecycleReferenceImpact)
      .sort((left, right) => compareKeyThenCanonical(
        referenceImpactKey(left),
        referenceImpactKey(right),
        left,
        right,
      )),
    blockers: sortBlockers([
      ...plan.blockers,
      ...versionBlockers,
      ...remapManifestBlockers,
      ...remapBlockers,
      ...mutationBlockers,
    ]),
    dependencies: normalizeDependencies(plan.dependencies),
    baseHashes: normalizeBaseHashes(plan.baseHashes),
    mutations: [...plan.mutations]
      .map((mutation) => cloneCanonical(mutation) as DocumentLifecycleMutation)
      .sort((left, right) => compareKeyThenCanonical(mutationKey(left), mutationKey(right), left, right)),
  };
}

export function canonicalDocumentLifecyclePlanPayload(plan: DocumentLifecyclePlan): string {
  return JSON.stringify(cloneCanonical(normalizeDocumentLifecyclePlan(plan)));
}

export function canonicalBaseHashManifest(manifest: BaseHashManifest): string {
  return JSON.stringify(normalizeBaseHashes(manifest));
}

export function canonicalDependencyManifest(dependencies: readonly DocumentLifecycleDependency[]): string {
  return JSON.stringify(normalizeDependencies(dependencies));
}

export function sameDocumentLifecyclePlan(left: DocumentLifecyclePlan, right: DocumentLifecyclePlan): boolean {
  return canonicalDocumentLifecyclePlanPayload(left) === canonicalDocumentLifecyclePlanPayload(right);
}

export function sameBaseHashManifest(left: BaseHashManifest, right: BaseHashManifest): boolean {
  return canonicalBaseHashManifest(left) === canonicalBaseHashManifest(right);
}

export function sameDependencyManifest(
  left: readonly DocumentLifecycleDependency[],
  right: readonly DocumentLifecycleDependency[],
): boolean {
  return canonicalDependencyManifest(left) === canonicalDependencyManifest(right);
}

export function createDocumentLifecyclePreview(
  plan: DocumentLifecyclePlan,
  previewHash: string,
): DocumentLifecyclePreview {
  const normalized = normalizeDocumentLifecyclePlan(plan);
  return {
    status: "preview",
    previewHash,
    planPayload: canonicalDocumentLifecyclePlanPayload(normalized),
    plan: normalized,
  };
}

export function prepareDocumentLifecycleApply(
  request: DocumentLifecycleApplyRequest,
  current: DocumentLifecyclePreview,
): DocumentLifecyclePrepareApplyResult {
  if (canonicalJson(normalizeOperation(request.operation)) !== canonicalJson(normalizeOperation(current.plan.operation))) {
    return conflict("operationChanged", "The lifecycle operation no longer matches the previewed operation.");
  }
  if (!sameBaseHashManifest(request.baseHashes, current.plan.baseHashes)) {
    return conflict("baseHashMismatch", "One or more lifecycle source hashes changed after preview.");
  }
  if (!sameDependencyManifest(request.dependencies, current.plan.dependencies)) {
    return conflict("dependencyChanged", "A Project, Catalog, document-set, or Reference dependency changed after preview.");
  }
  if (request.planPayload !== current.planPayload) {
    return conflict("planChanged", "The canonical lifecycle mutation or Reference impact plan changed after preview.");
  }
  if (request.previewHash !== current.previewHash) {
    return conflict("previewHashMismatch", "The lifecycle preview hash does not match the current plan.");
  }
  if (current.plan.blockers.length > 0) {
    return { success: false, status: "blocked", blockers: current.plan.blockers };
  }
  return { success: true, status: "ready", plan: current.plan };
}

function normalizeOperation(operation: DocumentLifecycleOperation): DocumentLifecycleOperation {
  if (operation.kind === "copy") {
    return {
      kind: "copy",
      source: cloneCanonical(operation.source) as unknown as DocumentLifecycleSelector,
      target: cloneCanonical(operation.target) as unknown as DocumentLifecycleSelector,
      stableIdRemap: sortRemap(operation.stableIdRemap),
    };
  }
  return cloneCanonical(operation) as DocumentLifecycleOperation;
}

function normalizeBaseHashes(manifest: BaseHashManifest): BaseHashManifest {
  return Object.fromEntries(Object.entries(manifest).sort(([left], [right]) => compareUtf16CodeUnits(left, right)));
}

function normalizeDependencies(
  dependencies: readonly DocumentLifecycleDependency[],
): readonly DocumentLifecycleDependency[] {
  return [...dependencies]
    .map((dependency) => ({
      ...dependency,
      paths: [...dependency.paths].sort(compareUtf16CodeUnits),
    }))
    .sort((left, right) => compareUtf16CodeUnits(dependencyKey(left), dependencyKey(right)));
}

function sortRemap(remap: readonly StableIdentityRemap[]): readonly StableIdentityRemap[] {
  return [...remap]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => compareKeyThenCanonical(left.identityKey, right.identityKey, left, right));
}

function sortBlockers(blockers: readonly DocumentLifecycleBlocker[]): readonly DocumentLifecycleBlocker[] {
  const sorted = [...blockers]
    .map((blocker) => cloneCanonical(blocker) as unknown as DocumentLifecycleBlocker)
    .sort((left, right) => compareUtf16CodeUnits(blockerKey(left), blockerKey(right)));
  return sorted.filter((blocker, index) => index === 0 || blockerKey(blocker) !== blockerKey(sorted[index - 1]!));
}

function stableIdentityValuesEqual(left: StableIdentityValue, right: StableIdentityValue): boolean {
  return typeof left === typeof right && left === right;
}

function identityBlocker(
  code: DocumentLifecycleBlockerCode,
  identityKey: string,
  message: string,
): DocumentLifecycleBlocker {
  return { code, identityKey, message };
}

function conflict(
  reason: DocumentLifecycleApplyConflictReason,
  message: string,
): DocumentLifecyclePrepareApplyResult {
  return { success: false, status: "conflict", reason, message };
}

function dependencyKey(dependency: DocumentLifecycleDependency): string {
  return [dependency.kind, dependency.key, dependency.hash, ...dependency.paths].join("\u0000");
}

function ownedStableIdentityValueKey(identity: Pick<OwnedStableIdentity, "kind" | "collisionScope" | "value">): string {
  return [identity.kind, identity.collisionScope, typeof identity.value, String(identity.value)].join("\u0000");
}

function ownedStableIdentityCollisionEntryKey(entry: OwnedStableIdentityCollisionEntry): string {
  return [
    ownedStableIdentityValueKey(entry.identity),
    selectorKey(entry.document),
    entry.identity.identityKey,
  ].join("\u0000");
}

function mutationKey(mutation: DocumentLifecycleMutation): string {
  switch (mutation.kind) {
    case "move":
      return [mutation.kind, mutation.sourcePath, mutation.targetPath].join("\u0000");
    default:
      return [mutation.kind, mutation.path].join("\u0000");
  }
}

function validateMutationPlan(
  mutations: readonly DocumentLifecycleMutation[],
): readonly DocumentLifecycleBlocker[] {
  const owners = new Map<string, { readonly key: string; readonly canonical: string }>();
  const blockers: DocumentLifecycleBlocker[] = [];
  for (const mutation of mutations) {
    const key = mutationKey(mutation);
    const paths = mutation.kind === "move"
      ? [mutation.sourcePath, mutation.targetPath]
      : [mutation.path];
    for (const mutationPath of paths) {
      const existing = owners.get(mutationPath);
      if (existing === undefined) {
        owners.set(mutationPath, { key, canonical: canonicalJson(mutation) });
        continue;
      }
      const duplicate = existing.canonical === canonicalJson(mutation);
      blockers.push({
        code: duplicate ? "mutation.duplicateTarget" : "mutation.conflict",
        path: mutationPath,
        message: duplicate
          ? `Lifecycle mutation target '${mutationPath}' is duplicated.`
          : `Lifecycle mutation target '${mutationPath}' has conflicting actions.`,
      });
    }
  }
  return blockers;
}

function referenceImpactKey(impact: DocumentLifecycleReferenceImpact): string {
  switch (impact.kind) {
    case "targetLocationChanged":
      return [impact.kind, impact.identityKey, referenceLocationKey(impact.from), referenceLocationKey(impact.to)].join("\u0000");
    case "internalRetarget":
      return [impact.kind, occurrenceKey(impact.occurrence), impact.targetIdentityKey, typeof impact.replacement, String(impact.replacement)].join("\u0000");
    case "externalInbound":
      return [impact.kind, occurrenceKey(impact.occurrence), impact.targetIdentityKey].join("\u0000");
    case "outboundPreserved":
      return [
        impact.kind,
        occurrenceKey(impact.occurrence),
        impact.target === undefined ? "missing" : referenceLocationKey(impact.target),
      ].join("\u0000");
  }
}

function occurrenceKey(occurrence: DocumentLifecycleReferenceOccurrence): string {
  return [
    selectorKey(occurrence.document),
    occurrence.path,
    occurrence.definition.kind,
    canonicalJson(occurrence.definition.target),
    occurrence.definition.allowMissing ? "1" : "0",
    typeof occurrence.value,
    String(occurrence.value),
  ].join("\u0000");
}

function selectorKey(selector: DocumentLifecycleSelector): string {
  return [selector.projectId, selector.documentTypeId, selector.editor, selector.path].join("\u0000");
}

function referenceLocationKey(location: ReferenceLocation): string {
  return [
    location.projectId,
    location.documentTypeId,
    location.path,
    location.documentId ?? "",
    location.componentId ?? "",
    location.elementKind ?? "",
    location.elementId ?? "",
    location.graphId ?? "",
    location.nodeId ?? "",
    location.portId ?? "",
    location.sheetId ?? "",
    location.rowId ?? "",
  ].join("\u0000");
}

function blockerKey(blocker: DocumentLifecycleBlocker): string {
  return [
    blocker.code,
    blocker.path ?? "",
    blocker.identityKey ?? "",
    blocker.occurrence === undefined ? "" : occurrenceKey(blocker.occurrence),
    blocker.message,
  ].join("\u0000");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(cloneCanonical(value));
}

function normalizePhysicalSources(
  sources: readonly DocumentLifecyclePhysicalSourceHash[],
): readonly DocumentLifecyclePhysicalSourceHash[] {
  const byPath = new Map<string, string>();
  for (const source of sources) {
    const normalizedPath = normalizeManifestPath(source.path);
    const existing = byPath.get(normalizedPath);
    if (existing !== undefined && existing !== source.hash) {
      throw new Error(`Lifecycle dependency source '${normalizedPath}' has conflicting hashes.`);
    }
    byPath.set(normalizedPath, source.hash);
  }
  return [...byPath]
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([path, hash]) => ({ path, hash }));
}

function normalizeManifestPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeReferenceLocation(location: ReferenceLocation): ReferenceLocation {
  return { ...location, path: normalizeManifestPath(location.path) };
}

function compareKeyThenCanonical(
  leftKey: string,
  rightKey: string,
  left: unknown,
  right: unknown,
): number {
  return compareUtf16CodeUnits(leftKey, rightKey)
    || compareUtf16CodeUnits(canonicalJson(left), canonicalJson(right));
}

function cloneCanonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Lifecycle canonical payload cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneCanonical);
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareUtf16CodeUnits)
      .map((key) => [key, cloneCanonical(record[key])]));
  }
  throw new Error(`Lifecycle canonical payload cannot contain '${typeof value}'.`);
}
