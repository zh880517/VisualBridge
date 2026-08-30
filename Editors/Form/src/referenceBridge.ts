import type { ReferenceDefinition } from "@visualbridge/core";

export interface ReferenceEditorActions {
  readonly pick: (
    definition: ReferenceDefinition,
    currentValue: string | number,
  ) => Promise<string | number | undefined>;
  readonly reveal: (definition: ReferenceDefinition, currentValue: string | number) => void;
}

interface MessageApi {
  postMessage(message: unknown): void;
}

interface PendingRequest {
  readonly valueType: "string" | "number";
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
    return new Promise((resolve) => this.pending.set(requestId, {
      valueType: typeof currentValue === "string" ? "string" : "number",
      resolve,
    }));
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
    const selectedValue = value.value;
    request.resolve(
      value.type === "referenceSelected"
        && (typeof selectedValue === "string" || typeof selectedValue === "number")
        && typeof selectedValue === request.valueType
        ? selectedValue
        : undefined,
    );
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
