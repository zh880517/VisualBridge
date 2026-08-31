import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VisualBridgeMcpError, VisualBridgeWorkspace } from "./projectWorkspace.js";
import {
  enumerateRuntimeInstances,
  RUNTIME_BRIDGE_DISCOVERY_DIRECTORY,
  RuntimeBridgeClientError,
  RuntimeBridgeConnection,
  RuntimeBridgeDiscoveredInstance,
  RuntimeDocumentSnapshot,
  RuntimeDocumentSource,
} from "./runtimeBridgeClient.js";

export interface RuntimeInstanceView {
  readonly instanceId: string;
  readonly kind: string;
  readonly tcpPort: number;
  readonly pid: number;
  readonly generation: number;
  readonly startedAt: string;
  readonly capabilities: readonly string[];
  readonly staleReason?: string;
}

export interface DocumentSourceDrift {
  readonly documentTypeId: string;
  readonly documentId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  /** true/false 表示可判定的漂移结果；unknown 表示源路径在工作区中不存在或歧义。 */
  readonly drift: boolean | "unknown";
}

/** Runtime 实例检查服务：枚举、快照与 Source 漂移；每次调用独立连接，不长期持有租约。 */
export class RuntimeService {
  public constructor(private readonly workspace: VisualBridgeWorkspace) {}

  public async listInstances(): Promise<readonly RuntimeInstanceView[]> {
    const instances = await enumerateRuntimeInstances(this.discoveryDirectory());
    return instances.map((instance) => ({
      instanceId: instance.instanceId,
      kind: instance.kind,
      tcpPort: instance.tcpPort,
      pid: instance.pid,
      generation: instance.generation,
      startedAt: instance.startedAt,
      capabilities: [...instance.capabilities],
      ...(instance.staleReason === undefined ? {} : { staleReason: instance.staleReason }),
      // 不暴露 token：发现记录的认证凭据不出 MCP 边界。
    }));
  }

  public async getSnapshot(
    instanceId: string,
    documentTypeIds?: readonly string[],
  ): Promise<readonly RuntimeDocumentSnapshot[]> {
    const instance = await this.requireLiveInstance(instanceId);
    return this.withConnection(instance, (connection) => connection.getSnapshot(documentTypeIds));
  }

  public async getDocumentSources(instanceId: string): Promise<readonly DocumentSourceDrift[]> {
    const instance = await this.requireLiveInstance(instanceId);
    const sources = await this.withConnection(instance, async (connection) => {
      await connection.acquireLease();
      const result = await connection.getDocumentSources();
      // 漂移计算完成后主动释放；失败由 dispose 断开连接兜底（租约随连接自动释放）。
      await connection.releaseLease();
      return result;
    });
    return this.computeDrift(sources);
  }

  private discoveryDirectory(): string {
    return process.env.VISUALBRIDGE_RUNTIME_DIR === undefined
      ? path.join(os.tmpdir(), RUNTIME_BRIDGE_DISCOVERY_DIRECTORY)
      : process.env.VISUALBRIDGE_RUNTIME_DIR;
  }

  private async requireLiveInstance(instanceId: string): Promise<RuntimeBridgeDiscoveredInstance> {
    const instances = await enumerateRuntimeInstances(this.discoveryDirectory());
    const instance = instances.find((candidate) => candidate.instanceId === instanceId);
    if (instance === undefined) {
      throw new VisualBridgeMcpError(
        "runtime.instanceNotFound",
        `Runtime instance '${instanceId}' was not found in the discovery directory.`,
      );
    }
    if (instance.staleReason !== undefined) {
      throw new VisualBridgeMcpError(
        "runtime.staleInstance",
        `Runtime instance '${instanceId}' is stale (${instance.staleReason}) and must not be connected.`,
      );
    }
    return instance;
  }

  private async withConnection<T>(
    instance: RuntimeBridgeDiscoveredInstance,
    action: (connection: RuntimeBridgeConnection) => Promise<T>,
  ): Promise<T> {
    const connection = new RuntimeBridgeConnection(instance);
    try {
      await connection.connect();
      return await action(connection);
    } catch (errorValue) {
      if (errorValue instanceof RuntimeBridgeClientError) {
        throw new VisualBridgeMcpError(errorValue.code, errorValue.message);
      }
      throw errorValue;
    } finally {
      connection.dispose();
    }
  }

  /** 漂移计算：sourcePath 为 project root 相对路径；恰一处命中才读字节比对 SHA-256。 */
  private async computeDrift(sources: readonly RuntimeDocumentSource[]): Promise<readonly DocumentSourceDrift[]> {
    const discovery = await this.workspace.discoverProjects();
    const roots = [...new Set(discovery.projects.map((project) => project.projectRoot))].sort();
    const result: DocumentSourceDrift[] = [];
    for (const source of sources) {
      const hits: string[] = [];
      for (const root of roots) {
        const candidate = path.resolve(root, ...source.sourcePath.split("/"));
        if (path.relative(root, candidate).startsWith("..")) continue;
        try {
          if ((await stat(candidate)).isFile()) hits.push(candidate);
        } catch {
          // 该 project root 下不存在此源路径。
        }
      }

      let drift: boolean | "unknown" = "unknown";
      if (hits.length === 1) {
        try {
          const bytes = await readFile(hits[0]!);
          drift = createHash("sha256").update(bytes).digest("hex") !== source.sourceSha256;
        } catch {
          drift = "unknown";
        }
      }
      result.push({
        documentTypeId: source.documentTypeId,
        documentId: source.documentId,
        sourcePath: source.sourcePath,
        sourceSha256: source.sourceSha256,
        drift,
      });
    }
    return result;
  }
}
