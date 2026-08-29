import type { ReferenceDefinition } from "@visualbridge/core";
import type { ReferenceEditorActions } from "./fieldEditor";

interface MessageApi {
  postMessage(message: unknown): void;
}

interface PendingRequest {
  readonly resolve: (value: string | number | undefined) => void;
}

export class WebviewReferenceBridge implements ReferenceEditorActions {
  private readonly pending = new Map<string, PendingRequest>();

  public constructor(private readonly api: MessageApi) {}

  public pick(
    definition: ReferenceDefinition,
    currentValue: string | number,
  ): Promise<string | number | undefined> {
    const requestId = crypto.randomUUID();
    this.api.postMessage({ type: "pickReference", requestId, definition, value: currentValue });
    return new Promise((resolve) => this.pending.set(requestId, { resolve }));
  }

  public reveal(definition: ReferenceDefinition, currentValue: string | number): void {
    this.api.postMessage({ type: "revealReference", definition, value: currentValue });
  }

  public handleMessage(value: unknown): boolean {
    if (!isRecord(value) || (value.type !== "referenceSelected" && value.type !== "referenceCancelled")
      || typeof value.requestId !== "string") {
      return false;
    }
    const request = this.pending.get(value.requestId);
    if (request === undefined) {
      return true;
    }
    this.pending.delete(value.requestId);
    request.resolve(value.type === "referenceSelected" && (typeof value.value === "string" || typeof value.value === "number")
      ? value.value
      : undefined);
    return true;
  }

  public dispose(): void {
    for (const request of this.pending.values()) {
      request.resolve(undefined);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
