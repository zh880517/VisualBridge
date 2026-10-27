export const ENTITY_REVEAL_MESSAGE_TYPE = "revealEntityComponent";
export const ENTITY_REVEAL_RESULT_MESSAGE_TYPE = "entityRevealResult";

export interface EntityRevealTarget {
  readonly documentId: string;
  readonly componentId: string;
  readonly elementKind: "component";
  readonly elementId: string;
}

export interface EntityRevealRequest {
  readonly type: typeof ENTITY_REVEAL_MESSAGE_TYPE;
  readonly requestId: string;
  readonly target: EntityRevealTarget;
}

export interface EntityRevealResult {
  readonly type: typeof ENTITY_REVEAL_RESULT_MESSAGE_TYPE;
  readonly requestId: string;
  readonly found: boolean;
  readonly message?: string;
}

export class EntityRevealMailbox {
  private sequence = 0;
  private ready = false;
  private pending: EntityRevealRequest | undefined;

  public enqueue(target: EntityRevealTarget): EntityRevealRequest {
    this.pending = {
      type: ENTITY_REVEAL_MESSAGE_TYPE,
      requestId: `entity-reveal-${++this.sequence}`,
      target,
    };
    return this.pending;
  }

  public markReady(): void {
    this.ready = true;
  }

  public markUnavailable(): void {
    this.ready = false;
  }

  public get deliverable(): EntityRevealRequest | undefined {
    return this.ready ? this.pending : undefined;
  }

  public acknowledge(requestId: string): boolean {
    if (requestId !== this.pending?.requestId) return false;
    this.pending = undefined;
    return true;
  }
}

export type EntityRevealPlanResult =
  | { readonly success: true; readonly componentId: string }
  | { readonly success: false; readonly code: string; readonly message: string };

export interface EntityRevealDocument {
  readonly documentId: string;
  readonly components: readonly { readonly id: string }[];
}

export function readEntityRevealTarget(value: unknown): EntityRevealTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const { documentId, componentId, elementKind, elementId } = candidate;
  return isIdentifier(documentId)
    && isIdentifier(componentId)
    && elementKind === "component"
    && elementId === componentId
    ? { documentId, componentId, elementKind, elementId }
    : undefined;
}

export function planEntityComponentReveal(
  document: EntityRevealDocument,
  target: EntityRevealTarget,
): EntityRevealPlanResult {
  if (document.documentId !== target.documentId) {
    return {
      success: false,
      code: "entity.reveal.documentChanged",
      message: `Entity Document '${target.documentId}' 已变更或不在当前文件中。`,
    };
  }
  if (!document.components.some((component) => component.id === target.componentId)) {
    return {
      success: false,
      code: "entity.reveal.missingComponent",
      message: `组件 '${target.componentId}' 不在 Entity '${document.documentId}' 中。`,
    };
  }
  return { success: true, componentId: target.componentId };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
