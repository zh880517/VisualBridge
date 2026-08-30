import { VisualBridgeMcpError } from "./projectWorkspace.js";
import { compareUtf16CodeUnits } from "@visualbridge/core";

export type CatalogAction = "read" | "search";

export interface DocumentCatalogRequest {
  readonly action: CatalogAction;
  readonly projectFile?: string;
  readonly documentTypeId?: string;
  readonly kind?: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly selector: Readonly<Record<string, unknown>>;
}

export type DocumentAction = "read" | "search" | "validate" | "apply";

export interface DocumentRequest {
  readonly action: DocumentAction;
  readonly projectFile?: string;
  readonly documentTypeId?: string;
  readonly path: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly selector: Readonly<Record<string, unknown>>;
  readonly baseHash?: string;
  readonly operations?: unknown;
}

export interface McpDocumentAdapter {
  readonly editor: string;
  queryCatalog(request: DocumentCatalogRequest): Promise<Record<string, unknown>>;
  executeDocument(request: DocumentRequest): Promise<Record<string, unknown>>;
}

export class McpDocumentAdapterRegistry {
  private readonly adapters = new Map<string, McpDocumentAdapter>();

  public constructor(adapters: readonly McpDocumentAdapter[]) {
    adapters.forEach((adapter) => {
      if (this.adapters.has(adapter.editor)) {
        throw new Error(`MCP Document Adapter '${adapter.editor}' is already registered.`);
      }
      this.adapters.set(adapter.editor, adapter);
    });
  }

  public require(editor: string): McpDocumentAdapter {
    const adapter = this.get(editor);
    if (adapter === undefined) {
      throw new VisualBridgeMcpError(
        "document.editorUnsupported",
        `Document editor '${editor}' is not supported by this MCP Server.`,
        { supportedEditors: this.listEditors() },
      );
    }
    return adapter;
  }

  public get(editor: string): McpDocumentAdapter | undefined {
    return this.adapters.get(editor);
  }

  public listEditors(): readonly string[] {
    return [...this.adapters.keys()].sort(compareUtf16CodeUnits);
  }
}
