import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  type DocumentDiagnostic,
  type ProjectProviderDocumentSnapshot,
  type ReferenceProvider,
} from "@visualbridge/core";
import {
  ProjectProviderHost,
  type ProjectProviderSourceManifestEntry,
} from "@visualbridge/node-host";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";

interface CachedHost {
  readonly projectHash: string;
  readonly host: ProjectProviderHost;
}

export class WorkspaceProjectProviderService implements vscode.Disposable {
  private readonly hosts = new Map<string, Promise<CachedHost>>();
  private readonly disposables: vscode.Disposable[] = [];
  private projectChangeTimer: NodeJS.Timeout | undefined;
  private revision = 0;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly output: vscode.OutputChannel,
  ) {
    const schedule = (): void => this.scheduleProjectChanged();
    this.disposables.push(
      projects.onDidChange(() => { void this.reset(); }),
      vscode.workspace.onDidCreateFiles(schedule),
      vscode.workspace.onDidDeleteFiles(schedule),
      vscode.workspace.onDidRenameFiles(schedule),
      vscode.workspace.onDidSaveTextDocument(schedule),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.reset(); }),
    );
  }

  public async referenceProviders(project: ProjectContext): Promise<readonly ReferenceProvider[]> {
    return (await this.getHost(project))?.referenceProviders ?? [];
  }

  public async validateDocument(
    project: ProjectContext,
    snapshot: ProjectProviderDocumentSnapshot,
  ): Promise<readonly DocumentDiagnostic[]> {
    const host = await this.getHost(project);
    if (host === undefined) return [];
    const result = await host.validateDocuments([snapshot]);
    return result.diagnostics.map(({ documentTypeId: _documentTypeId, documentPath: _documentPath, ...item }) => item);
  }

  public dispose(): void {
    if (this.projectChangeTimer !== undefined) clearTimeout(this.projectChangeTimer);
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    void this.reset();
  }

  private async getHost(project: ProjectContext): Promise<ProjectProviderHost | undefined> {
    if (!vscode.workspace.isTrusted || project.definition.providers.length === 0 || project.rootUri.scheme !== "file") {
      return undefined;
    }
    const projectHash = hashBytes(await vscode.workspace.fs.readFile(project.markerUri));
    const key = project.markerUri.toString();
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
    const allowedEntryPaths = project.definition.providers.map((provider) => (
      nodePath.resolve(project.rootUri.fsPath, ...provider.entry.split("/"))
    ));
    const host = await ProjectProviderHost.create({
      projectRoot: project.rootUri.fsPath,
      projectHash,
      project: project.definition,
      allowedEntryPaths,
      captureSourceManifest: () => this.captureSourceManifest(project),
      isDeclaredDocument: (documentTypeId, documentPath) => {
        const uri = vscode.Uri.joinPath(project.rootUri, ...documentPath.split("/"));
        const match = this.projects.resolveDocument(uri);
        return match?.project.markerUri.toString() === project.markerUri.toString()
          && match.documentType.id === documentTypeId
          && match.relativePath === documentPath;
      },
      log: (event) => this.output.appendLine(`[provider] ${JSON.stringify(event)}`),
    });
    return { projectHash, host };
  }

  private async captureSourceManifest(
    project: ProjectContext,
  ): Promise<readonly ProjectProviderSourceManifestEntry[]> {
    const paths = await this.projects.listAuthoringSourcePaths(project);
    return Promise.all(paths.map(async (sourcePath): Promise<ProjectProviderSourceManifestEntry> => {
      const uri = vscode.Uri.joinPath(project.rootUri, ...sourcePath.split("/"));
      try {
        await vscode.workspace.fs.stat(uri);
      } catch (errorValue) {
        if (isFileNotFound(errorValue)) return { path: sourcePath, expectedAbsent: true };
        throw errorValue;
      }
      return { path: sourcePath, hash: hashBytes(await vscode.workspace.fs.readFile(uri)) };
    }));
  }

  private scheduleProjectChanged(): void {
    if (!vscode.workspace.isTrusted || this.hosts.size === 0) return;
    if (this.projectChangeTimer !== undefined) clearTimeout(this.projectChangeTimer);
    this.projectChangeTimer = setTimeout(() => {
      this.projectChangeTimer = undefined;
      void this.notifyProjectChanged();
    }, 100);
  }

  private async notifyProjectChanged(): Promise<void> {
    const revision = ++this.revision;
    for (const project of this.projects.projects) {
      const cached = this.hosts.get(project.markerUri.toString());
      if (cached === undefined) continue;
      try {
        const [{ host }, manifest, projectBytes] = await Promise.all([
          cached,
          this.captureSourceManifest(project),
          vscode.workspace.fs.readFile(project.markerUri),
        ]);
        await host.projectChanged({
          projectId: project.definition.projectId,
          projectHash: hashBytes(projectBytes),
          documentSetHash: hashManifest(manifest),
          revision,
        });
      } catch (errorValue) {
        this.output.appendLine(`[provider] Project change notification failed: ${formatError(errorValue)}`);
      }
    }
  }

  private async reset(): Promise<void> {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    const settled = await Promise.allSettled(hosts);
    await Promise.all(settled.flatMap((result) => (
      result.status === "fulfilled" ? [result.value.host.dispose()] : []
    )));
  }
}

function hashManifest(entries: readonly ProjectProviderSourceManifestEntry[]): string {
  return hashBytes(Buffer.from(JSON.stringify([...entries].sort((left, right) => compareOrdinal(left.path, right.path)))));
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFileNotFound(errorValue: unknown): boolean {
  return errorValue instanceof vscode.FileSystemError
    ? errorValue.code === "FileNotFound"
    : errorValue instanceof Error && "code" in errorValue && errorValue.code === "ENOENT";
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
