import type {
  DocumentDiagnostic,
  DocumentLifecycleDeleteTarget,
  DocumentOperationResult,
  JsonValue,
  OwnedStableIdentity,
  StableIdentityRemap,
} from "@visualbridge/core";
import type { EntityCatalogRegistry } from "./entityCatalog";
import { applyEntityOperations, validateEntityDocument, type EntityDocument } from "./entityDocument";

export type EntityOwnedIdentityKind = "document" | "component";

export interface EntityOwnedIdentity extends OwnedStableIdentity {
  readonly identityKey: string;
  readonly kind: EntityOwnedIdentityKind;
  readonly collisionScope: string;
  readonly value: string;
}

export type EntityStableIdentityRemap = StableIdentityRemap;

export function collectEntityOwnedIdentities(
  document: EntityDocument,
  documentTypeId: string,
): readonly EntityOwnedIdentity[] {
  return [
    {
      identityKey: "document",
      kind: "document",
      collisionScope: documentTypeId,
      value: document.documentId,
      reference: {
        definition: { kind: "document", target: { documentTypeId }, allowMissing: false },
      },
    },
    ...document.components.map((component): EntityOwnedIdentity => ({
      identityKey: componentKey(component.id),
      kind: "component",
      collisionScope: documentTypeId,
      value: component.id,
      reference: {
        definition: { kind: "entity.component", target: { documentTypeId }, allowMissing: false },
      },
    })),
  ];
}

export function remapEntityOwnedIdentities(
  document: EntityDocument,
  documentTypeId: string,
  remaps: readonly EntityStableIdentityRemap[],
  registry: EntityCatalogRegistry,
): DocumentOperationResult<EntityDocument> {
  const identities = collectEntityOwnedIdentities(document, documentTypeId);
  const parsed = requireCompleteRemap(identities, remaps);
  if (!parsed.success) return parsed;
  const next: EntityDocument = {
    ...document,
    documentId: requireString(parsed.byKey.get("document")!.to),
    components: document.components.map((component) => ({
      ...component,
      id: requireString(parsed.byKey.get(componentKey(component.id))!.to),
    })),
  };
  const diagnostics = validateEntityDocument(next, registry);
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { success: false, diagnostics }
    : { success: true, document: next, diagnostics };
}

export function deleteEntityOwnedTarget(
  document: EntityDocument,
  target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
  registry: EntityCatalogRegistry,
): DocumentOperationResult<EntityDocument> {
  return target.kind === "entity.component"
    ? applyEntityOperations(document, [{ type: "entity.removeComponent", componentId: target.componentId }], registry)
    : { success: false, diagnostics: [error("target", `Entity lifecycle cannot delete '${target.kind}'.`)] };
}

function requireCompleteRemap(
  identities: readonly EntityOwnedIdentity[],
  remaps: readonly EntityStableIdentityRemap[],
): { readonly success: true; readonly byKey: ReadonlyMap<string, EntityStableIdentityRemap> }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] } {
  const diagnostics: DocumentDiagnostic[] = [];
  const byKey = new Map<string, EntityStableIdentityRemap>();
  remaps.forEach((remap, index) => {
    if (byKey.has(remap.identityKey)) {
      diagnostics.push(error(`stableIdRemap[${index}].identityKey`, "Duplicate identity remap key."));
    } else {
      byKey.set(remap.identityKey, remap);
    }
  });
  const expected = new Set(identities.map((entry) => entry.identityKey));
  identities.forEach((entry) => {
    const remap = byKey.get(entry.identityKey);
    if (remap === undefined) {
      diagnostics.push(error("stableIdRemap", `Missing remap for '${entry.identityKey}'.`));
    } else if (remap.from !== entry.value) {
      diagnostics.push(error("stableIdRemap", `Remap '${entry.identityKey}' does not match the owned identity.`));
    } else if (typeof remap.to !== "string" || !isStableIdentifier(remap.to) || remap.to === remap.from) {
      diagnostics.push(error("stableIdRemap", `Remap '${entry.identityKey}' requires a different stable string ID.`));
    }
  });
  for (const key of byKey.keys()) {
    if (!expected.has(key)) diagnostics.push(error("stableIdRemap", `Unexpected remap '${key}'.`));
  }
  const componentTargets = new Set<string>();
  remaps.filter((entry) => expected.has(entry.identityKey) && entry.identityKey !== "document").forEach((entry) => {
    const value = requireString(entry.to);
    if (componentTargets.has(value)) diagnostics.push(error("stableIdRemap", `Duplicate component target '${value}'.`));
    componentTargets.add(value);
  });
  return diagnostics.length > 0 ? { success: false, diagnostics } : { success: true, byKey };
}

function componentKey(componentId: string): string { return `component:${componentId}`; }

function requireString(value: string | number): string {
  return typeof value === "string" ? value : String(value);
}

function isStableIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function error(path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code: "lifecycle.invalidStableIdRemap", path, message };
}
