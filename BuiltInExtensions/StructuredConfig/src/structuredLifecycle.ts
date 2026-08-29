import type {
  DocumentDiagnostic,
  DocumentLifecycleDeleteTarget,
  DocumentOperationResult,
  JsonValue,
  OwnedStableIdentity,
  StableIdentityRemap,
} from "@visualbridge/core";
import type { StructuredCatalogRegistry } from "./structuredCatalog";
import { validateStructuredDocument, type StructuredDocument } from "./structuredDocument";

export interface StructuredOwnedIdentity extends OwnedStableIdentity {
  readonly identityKey: "document";
  readonly kind: "document";
  readonly collisionScope: string;
  readonly value: string;
}

export type StructuredStableIdentityRemap = StableIdentityRemap;

export function collectStructuredOwnedIdentities(
  document: StructuredDocument,
  documentTypeId: string,
): readonly StructuredOwnedIdentity[] {
  return [{
    identityKey: "document",
    kind: "document",
    collisionScope: documentTypeId,
    value: document.documentId,
    reference: {
      definition: { kind: "document", target: { documentTypeId }, allowMissing: false },
    },
  }];
}

export function remapStructuredOwnedIdentities(
  document: StructuredDocument,
  documentTypeId: string,
  remaps: readonly StructuredStableIdentityRemap[],
  registry: StructuredCatalogRegistry,
  configTypeId: string,
): DocumentOperationResult<StructuredDocument> {
  const expected = collectStructuredOwnedIdentities(document, documentTypeId)[0]!;
  const remap = remaps[0];
  if (
    remaps.length !== 1
    || remap === undefined
    || remap.identityKey !== expected.identityKey
    || remap.from !== expected.value
    || remap.to === remap.from
    || typeof remap.to !== "string"
    || !isStableIdentifier(remap.to)
  ) {
    return {
      success: false,
      diagnostics: [error("stableIdRemap", "Structured copy requires exactly one matching, different Document ID remap.")],
    };
  }
  const next: StructuredDocument = { ...document, documentId: remap.to as string };
  const diagnostics = validateStructuredDocument(next, registry, configTypeId);
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { success: false, diagnostics }
    : { success: true, document: next, diagnostics };
}

export function deleteStructuredOwnedTarget(
  _document: StructuredDocument,
  target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
): DocumentOperationResult<StructuredDocument> {
  return {
    success: false,
    diagnostics: [error("target", `Structured lifecycle cannot delete '${target.kind}'.`)],
  };
}

function isStableIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function error(path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code: "lifecycle.invalidStableIdRemap", path, message };
}
