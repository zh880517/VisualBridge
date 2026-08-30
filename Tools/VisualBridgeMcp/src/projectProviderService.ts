import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectProviderDocumentSnapshot, ReferenceProvider } from "@visualbridge/core";
import {
  ProjectProviderHost,
  type ProjectProviderHostOptions,
  type ProjectProviderSourceManifestEntry,
  type ProjectProviderValidationResult,
} from "@visualbridge/node-host";
import type { ProjectProviderAuthorization } from "./providerAuthorization.js";
import type { ProjectContext, VisualBridgeWorkspace } from "./projectWorkspace.js";

interface CachedHost {
  readonly projectHash: string;
  readonly host: ProjectProviderHost;
}

export class McpProjectProviderService implements AsyncDisposable {
  private readonly hosts = new Map<string, Promise<CachedHost>>();

  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    public readonly authorization: ProjectProviderAuthorization,
  ) {}

  public async referenceProviders(project: ProjectContext): Promise<readonly ReferenceProvider[]> {
    return (await this.getHost(project))?.referenceProviders ?? [];
  }

  public async validateDocuments(
    project: ProjectContext,
    documents: readonly ProjectProviderDocumentSnapshot[],
    signal?: AbortSignal,
  ): Promise<ProjectProviderValidationResult> {
    const host = await this.getHost(project);
    if (host === undefined) {
      return { diagnostics: [], unavailableProviderIds: [] };
    }
    return host.validateDocuments(documents, signal);
  }

  public async dispose(): Promise<void> {
    const hosts = await Promise.allSettled([...this.hosts.values()]);
    this.hosts.clear();
    await Promise.all(hosts.flatMap((result) => (
      result.status === "fulfilled" ? [result.value.host.dispose()] : []
    )));
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private async getHost(project: ProjectContext): Promise<ProjectProviderHost | undefined> {
    if (!this.authorization.enabled || project.definition.providers.length === 0) return undefined;
    const projectHash = hashBytes(await readFile(project.absoluteProjectFile));
    const key = pathIdentity(project.absoluteProjectFile);
    const existingPromise = this.hosts.get(key);
    if (existingPromise !== undefined) {
      const existing = await existingPromise;
      if (existing.projectHash === projectHash) return existing.host;
      this.hosts.delete(key);
      await existing.host.dispose();
    }
    const loading = this.createHost(project, projectHash).catch((errorValue: unknown) => {
      if (this.hosts.get(key) === loading) this.hosts.delete(key);
      throw errorValue;
    });
    this.hosts.set(key, loading);
    return (await loading).host;
  }

  private async createHost(project: ProjectContext, projectHash: string): Promise<CachedHost> {
    const options: ProjectProviderHostOptions = {
      projectRoot: project.projectRoot,
      projectHash,
      project: project.definition,
      allowedEntryPaths: this.authorization.allowedEntryPaths,
      captureSourceManifest: () => this.captureSourceManifest(project),
      isDeclaredDocument: async (documentTypeId, documentPath) => {
        try {
          const resolved = await this.workspace.resolveDeclaredDocument(
            documentPath,
            undefined,
            project.projectFile,
            documentTypeId,
          );
          return resolved.project.absoluteProjectFile === project.absoluteProjectFile
            && resolved.documentType.id === documentTypeId;
        } catch {
          return false;
        }
      },
      log: (event) => console.error(`[visualbridge-provider] ${JSON.stringify(event)}`),
    };
    return { projectHash, host: await ProjectProviderHost.create(options) };
  }

  private async captureSourceManifest(
    project: ProjectContext,
  ): Promise<readonly ProjectProviderSourceManifestEntry[]> {
    const paths = await this.workspace.listAuthoringSourcePaths(project);
    return Promise.all(paths.map(async (sourcePath): Promise<ProjectProviderSourceManifestEntry> => {
      const absolutePath = path.resolve(project.projectRoot, ...sourcePath.split("/"));
      try {
        await lstat(absolutePath);
      } catch (errorValue) {
        if (isNodeError(errorValue, "ENOENT")) return { path: sourcePath, expectedAbsent: true };
        throw errorValue;
      }
      return { path: sourcePath, hash: hashBytes(await readFile(absolutePath)) };
    }));
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isNodeError(errorValue: unknown, code: string): errorValue is NodeJS.ErrnoException {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}
