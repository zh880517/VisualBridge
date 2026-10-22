# VisualBridge Unity Editor 接入架构

> 本页是 Unity Editor 接入架构的索引与总览。完整内容按主题拆分到三份子文档；原有章节标题与锚点保留在文末「原章节锚点索引」，旧链接继续可解析。

本文定义 VisualBridge 在 Unity 接入前 Authoring 基线之后的 Unity Editor 集成架构，并记录当前已落地的 C# contract、UPM Package、Catalog Export/Compile、Editor Bridge 与本机 Runtime Bridge。Authoring 源文件仍是唯一权威数据；Unity 导入结果、编译产物、索引、缓存和映射都是可删除、可重建的派生数据。

当前已落地的范围：

- 从现有 JSON Schema 与 contract manifest 确定性生成 Unity C# wire/data bags，并由 strict `JObject` validator 执行语义校验。
- Structured、Entity、Graph 三域 Catalog Export，以及 Structured、Entity、Table（CSV family）、Graph 四域离线 Compile。
- 本机回环 Editor Bridge（Unity 请求 VS Code 打开/定位文档）与 Runtime Bridge（实例发现、快照、事件、调试租约、Source 映射、Graph 执行观察）。
- 断点、调用栈、变量求值与执行控制不进入协议；Player 产物接线与远程/设备连接仍未实现，见 [Backlog](Backlog.md)。

## 子文档

- [C# 契约与离线 Catalog/Compile](UnityIntegrationArchitectureContracts.md)：首期范围、冻结交接面、Package 边界、C# contract、Profile、Field 映射、三域 Catalog Export、四域 Compile 与领域扩展记录。
- [Editor Bridge 与冻结决策](UnityIntegrationArchitectureEditorBridge.md)：Editor Bridge spike/冻结设计、Unity Adapter API 决策、命令与验证层级、已冻结与待关闭决策。
- [Runtime Bridge 与 Graph 执行观察](UnityIntegrationArchitectureRuntime.md)：Runtime 产物形态、实例发现、Runtime Bridge 协议、DAP 检查适配器与 Graph 执行过程可视化。

## 原章节锚点索引

以下标题保留原有 GitHub 锚点，并指向迁移后的完整内容。

### [1. 文档定位](UnityIntegrationArchitectureContracts.md#1-文档定位)

### [2. 首期范围](UnityIntegrationArchitectureContracts.md#2-首期范围)

### [3. 权威数据与冻结交接面](UnityIntegrationArchitectureContracts.md#3-权威数据与冻结交接面)

### [4. 分层依赖](UnityIntegrationArchitectureContracts.md#4-分层依赖)

### [5. Unity Package 边界](UnityIntegrationArchitectureContracts.md#5-unity-package-边界)

### [6. C# contract generation](UnityIntegrationArchitectureContracts.md#6-c-contract-generation)

#### [6.1 单一事实来源](UnityIntegrationArchitectureContracts.md#61-单一事实来源)

#### [6.2 确定性](UnityIntegrationArchitectureContracts.md#62-确定性)

#### [6.3 严格语义](UnityIntegrationArchitectureContracts.md#63-严格语义)

### [7. Unity Integration Profile](UnityIntegrationArchitectureContracts.md#7-unity-integration-profile)

#### [7.1 所有权](UnityIntegrationArchitectureContracts.md#71-所有权)

#### [7.2 路由](UnityIntegrationArchitectureContracts.md#72-路由)

### [8. 普通 C# 类型与共享 Field 映射](UnityIntegrationArchitectureContracts.md#8-普通-c-类型与共享-field-映射)

### [9. Structured Catalog Exporter](UnityIntegrationArchitectureContracts.md#9-structured-catalog-exporter)

### [10. Structured Import / Compile](UnityIntegrationArchitectureContracts.md#10-structured-import--compile)

#### [10.1 离线服务](UnityIntegrationArchitectureContracts.md#101-离线服务)

#### [10.2 派生产物](UnityIntegrationArchitectureContracts.md#102-派生产物)

#### [10.3 确定性与并发](UnityIntegrationArchitectureContracts.md#103-确定性与并发)

### [11. 信任与安全边界](UnityIntegrationArchitectureContracts.md#11-信任与安全边界)

### [12. Editor Bridge](UnityIntegrationArchitectureEditorBridge.md#12-editor-bridge)

#### [12.1 Spike 证据](UnityIntegrationArchitectureEditorBridge.md#121-spike-证据)

#### [12.2 冻结设计](UnityIntegrationArchitectureEditorBridge.md#122-冻结设计)

#### [12.3 威胁模型边界](UnityIntegrationArchitectureEditorBridge.md#123-威胁模型边界)

#### [12.4 实施与验证（2026-08-31）](UnityIntegrationArchitectureEditorBridge.md#124-实施与验证2026-08-31)

### [13. 领域扩展边界](UnityIntegrationArchitectureContracts.md#13-领域扩展边界)

#### [13.1 Entity Catalog Export 落地记录（VB-UX-01，2026-08-31）](UnityIntegrationArchitectureContracts.md#131-entity-catalog-export-落地记录vb-ux-012026-08-31)

#### [13.2 Entity Import / Compile 落地记录（VB-UX-02，2026-08-31）](UnityIntegrationArchitectureContracts.md#132-entity-import--compile-落地记录vb-ux-022026-08-31)

#### [13.3 Unity Adapter API 复核决策（VB-UX-03，2026-08-31）](UnityIntegrationArchitectureEditorBridge.md#133-unity-adapter-api-复核决策vb-ux-032026-08-31)

#### [13.4 Table Import / Compile 设计记录（VB-UX-04，2026-08-31）](UnityIntegrationArchitectureContracts.md#134-table-import--compile-设计记录vb-ux-042026-08-31)

#### [13.5 Graph Catalog V4 Export 设计记录（VB-UX-05，2026-08-31）](UnityIntegrationArchitectureContracts.md#135-graph-catalog-v4-export-设计记录vb-ux-052026-08-31)

#### [13.6 Graph Import / Compile 设计记录（VB-UX-06，2026-08-31）](UnityIntegrationArchitectureContracts.md#136-graph-import--compile-设计记录vb-ux-062026-08-31)

#### [13.7 Runtime 产物形态冻结决策（VB-UX-07，2026-08-31）](UnityIntegrationArchitectureRuntime.md#137-runtime-产物形态冻结决策vb-ux-072026-08-31)

### [14. 命令与验证层级](UnityIntegrationArchitectureEditorBridge.md#14-命令与验证层级)

### [15. 已冻结决策](UnityIntegrationArchitectureEditorBridge.md#15-已冻结决策)

### [16. 已关闭与仍待关闭的决策](UnityIntegrationArchitectureEditorBridge.md#16-已关闭与仍待关闭的决策)

### [17. Runtime 实例发现（冻结设计，VB-UX-08，2026-08-31）](UnityIntegrationArchitectureRuntime.md#17-runtime-实例发现冻结设计vb-ux-082026-08-31)

#### [17.1 注册记录](UnityIntegrationArchitectureRuntime.md#171-注册记录)

#### [17.2 生命周期语义（实测冻结）](UnityIntegrationArchitectureRuntime.md#172-生命周期语义实测冻结)

#### [17.3 威胁模型（本机信任边界）](UnityIntegrationArchitectureRuntime.md#173-威胁模型本机信任边界)

#### [17.4 工程告示](UnityIntegrationArchitectureRuntime.md#174-工程告示)

### [18. Runtime Bridge 协议（冻结设计，VB-UX-09，2026-08-31）](UnityIntegrationArchitectureRuntime.md#18-runtime-bridge-协议冻结设计vb-ux-092026-08-31)

#### [18.1 共享协议核的实现方式](UnityIntegrationArchitectureRuntime.md#181-共享协议核的实现方式)

#### [18.2 消息集](UnityIntegrationArchitectureRuntime.md#182-消息集)

#### [18.3 调试语义与权限模型（VB-UX-10 增补，2026-08-31）](UnityIntegrationArchitectureRuntime.md#183-调试语义与权限模型vb-ux-10-增补2026-08-31)

#### [18.4 实现边界](UnityIntegrationArchitectureRuntime.md#184-实现边界)

#### [18.5 VS Code DAP 检查适配器（VB-UX-11，2026-08-31）](UnityIntegrationArchitectureRuntime.md#185-vs-code-dap-检查适配器vb-ux-112026-08-31)

### [19. Graph 执行过程可视化（冻结设计，VB-UX-13~16，2026-08-31）](UnityIntegrationArchitectureRuntime.md#19-graph-执行过程可视化冻结设计vb-ux-13162026-08-31)

#### [19.1 范围与定位](UnityIntegrationArchitectureRuntime.md#191-范围与定位)

#### [19.2 事件与实例模型](UnityIntegrationArchitectureRuntime.md#192-事件与实例模型)

#### [19.3 协议扩展（Runtime Bridge 纯增量）](UnityIntegrationArchitectureRuntime.md#193-协议扩展runtime-bridge-纯增量)

#### [19.4 Unity 侧采集缝](UnityIntegrationArchitectureRuntime.md#194-unity-侧采集缝)

#### [19.5 VS Code 页面交互](UnityIntegrationArchitectureRuntime.md#195-vs-code-页面交互)
