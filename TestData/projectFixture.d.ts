// 测试与工具共用的 Project File v2 构造器类型声明（实现见同目录 projectFixture.js）。
// 返回值默认为宽类型；需要强类型时显式传入泛型，例如
// createTestProject<VisualBridgeProjectDefinition>({ documentRoots: ["Config"] })。

export interface TestProjectOptions {
  readonly formatVersion?: number;
  readonly projectId?: string;
  readonly documentRoots?: readonly string[];
  readonly modules?: readonly unknown[];
  readonly documentTypes?: readonly unknown[];
  readonly providers?: readonly unknown[];
  /** 负向用例附加的未知顶层键。 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface WrittenTestProject<TProject> {
  readonly project: TProject;
  readonly text: string;
  readonly path: string;
}

export declare function createTestProject<TProject = Readonly<Record<string, unknown>>>(
  options?: TestProjectOptions,
): TProject;

export declare function writeTestProject<TProject = Readonly<Record<string, unknown>>>(
  directory: string,
  options?: TestProjectOptions,
): Promise<WrittenTestProject<TProject>>;
