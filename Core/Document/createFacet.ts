/**
 * 模块 `create` facet 的共享输入与返回值契约（附录 D.3 的 `create`）。
 *
 * 四个领域的 create facet 此前各声明一份**几乎相同**的 `CreateFacetInput`，宿主侧又各自声明
 * `ModuleCreateFacet` / `McpCreateFacet`，使"创建一份新文档"有三套形状。这里把真正的公共部分
 * 收回 Core：字段是四个领域现有并集，**不做最低公分母**——领域用 `interface XxxCreateInput
 * extends CreateFacetInput` 扩展自己的字段，并以 `satisfies CreateFacet<XxxCreateInput>` 登记，
 * 不再需要 `as` 断言。
 *
 * 边界：facet 只决定"问什么 / 默认文件名 / Lifecycle parameters"和新文档字节；Quick Pick、
 * 保存对话框、preview/apply 与事务写入都在宿主。
 */
import type { JsonValue } from "../Form/field";

/** 宿主读取 + 解析后的 Catalog 视图；facet 只读，不得自行装载文件。 */
export interface CreateCatalogView {
  readonly ready: boolean;
  readonly registry: unknown;
  readonly diagnostics: readonly { readonly severity: string; readonly message: string }[];
}

/** Project File 中与该文档类型相关的只读视图。 */
export interface CreateDocumentTypeView {
  readonly id: string;
  readonly editor: string;
  readonly catalogs: readonly string[];
}

/**
 * `create` facet 两个方法的公共入参。
 *
 * `projectDefinition` 是**逃逸口**：Core 不认识各域的 Project 扩展字段，因此这里是 `unknown`，
 * 使用方必须自行校验（例如 `parseXxxProjectOptions(input.projectDefinition)`），**不得直接信任**。
 */
export interface CreateFacetInput {
  readonly projectId: string;
  readonly projectDefinition: unknown;
  readonly documentType: CreateDocumentTypeView;
  readonly catalog: CreateCatalogView;
  /**
   * 宿主注入的稳定 ID 生成器。
   *
   * facet 不得依赖 Node 内建模块或 `crypto`：ID 的格式与唯一性由宿主保证，facet 只消费。
   */
  readonly newStableId: (prefix: string) => string;
}

/** 创建向导里的一个问题（宿主渲染成 Quick Pick，不解释领域含义）。 */
export interface CreateQuestion {
  readonly id: string;
  readonly title: string;
  readonly placeholder: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly detail?: string;
  }[];
}

/** `prepare` 的结果：要么说明为什么不能创建，要么给出向导与新文档参数。 */
export type CreatePreparation =
  | { readonly kind: "unavailable"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly questions: readonly CreateQuestion[];
      /** 无扩展名的默认落盘扩展名（`vbgraph` / `vbentity` / `xlsx` …）。 */
      readonly fallbackExtension: string;
      readonly defaultFileName: (answers: Readonly<Record<string, string>>) => string;
      /**
       * 把向导答案变成 Lifecycle parameters；宿主原样传给 `visualbridge_lifecycle`。
       *
       * `target` 是宿主已确定的目标文件信息（目前只有物理文件名）：Table 的 CSV 分支需要把
       * 文件名写进 parameters，其余领域忽略它。
       */
      readonly parameters: (
        answers: Readonly<Record<string, string>>,
        target: { readonly name: string },
      ) => Readonly<Record<string, JsonValue>>;
    };

/** `createDocument` 在公共入参之外的额外字段；由宿主在 apply 阶段提供。 */
export interface CreateDocumentRequest {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  /** 相对 Project Root 的 `/` 分隔路径。 */
  readonly targetPath: string;
}

/** `createDocument` 的结果：成功时给出要写盘的源文件字节与新增稳定身份。 */
export type CreateDocumentResult =
  | {
      readonly success: true;
      readonly sources: readonly { readonly path: string; readonly bytes: Uint8Array }[];
      readonly ownedIdentities: readonly import("./documentLifecycle").OwnedStableIdentity[];
    }
  | { readonly success: false; readonly message: string };

/**
 * 一个 editor 的 create facet。
 *
 * 领域按需扩展 `TInput`（例如 Table 需要 `sheets` 视图），宿主只依赖 `CreateFacetInput` 的公共
 * 字段；`prepare` 与 `createDocument` 都必须只用传进来的宿主能力，不得自行读取文件系统。
 */
export interface CreateFacet<TInput extends CreateFacetInput = CreateFacetInput> {
  prepare(input: TInput): CreatePreparation;
  createDocument(input: TInput & CreateDocumentRequest): Promise<CreateDocumentResult>;
}
