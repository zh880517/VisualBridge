import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEBUG_ARTIFACTS_ROOT_DEFAULT,
  DebugContractRegistry,
  normalizeProjectRelativePath,
  resolveArtifactsRoot,
  selectDebugConfigFile,
} from "../../src/bridge/debugContractRegistry";

// .test-dist 比源码深一层：按编译输出深度解析仓库根，复用 TestData 的共享 fixture。
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const fixtures = path.join(repositoryRoot, "TestData", "DebugContracts");
const unityProject = path.join(fixtures, "UnityProject");
const unityArtifacts = path.join(unityProject, "Assets", "VisualBridgeGenerated", "Debug");
const customProject = path.join(fixtures, "CustomProject");
const supplementalDirectory = path.join(fixtures, "Supplemental");

test("locates the conventional ArtifactsRoot contract from a Project root inside a Unity project", async () => {
  const registry = new DebugContractRegistry();
  // Project 根可以是 Unity 工程里的任意深目录：向上找到 ProjectSettings/ProjectVersion.txt 即为工程根。
  const set = await registry.load({ projectRoots: [path.join(unityProject, "Assets", "VisualBridgeGenerated")] });

  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.unityRoot, unityProject);
  assert.equal(snapshot.primary?.directory, unityArtifacts);
  assert.deepEqual(set.hashes, ["9f1c2d3e4a5b6c7d"]);
  assert.equal(snapshot.skipped.length, 0);
  assert.equal(set.warnings.length, 0);
});

test("parses the generated contract shape into method declarations", async () => {
  const registry = new DebugContractRegistry();
  const set = await registry.load({ projectRoots: [unityProject] });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.contractHash, "9f1c2d3e4a5b6c7d");
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.primary?.role, "primary");
  assert.equal(snapshot.primary?.directory, unityArtifacts);
  assert.equal(snapshot.primary?.methods, 3);
  assert.equal(snapshot.loaded, true);
  assert.deepEqual(set.hashes, ["9f1c2d3e4a5b6c7d"]);

  const nodeStarted = snapshot.resolveByMethodId("graph", 10);
  assert.ok(nodeStarted !== undefined);
  assert.equal(nodeStarted.name, "NodeStarted");
  assert.equal(nodeStarted.interfaceId, "IGraphDebuger");
  assert.equal(nodeStarted.interfaceFullName, "Sample.Graph.IGraphDebuger");
  assert.equal(nodeStarted.kind, "Event");
  assert.deepEqual(
    nodeStarted.parameters.map((parameter) => [parameter.tag, parameter.name, parameter.wireType, parameter.enumWidth]),
    [
      [1, "nodeId", "int", undefined],
      [2, "label", "string", undefined],
      [3, "mode", "enum", 2],
    ],
  );
  assert.equal(nodeStarted.parameters[1]?.optional, true);
  assert.equal(nodeStarted.parameters[2]?.enumName, "Sample.Graph.Mode");
  assert.equal(snapshot.resolveEnumWidth("graph", 10, 3), 2);
  assert.equal(snapshot.resolveEnumWidth("graph", 10, 1), undefined);

  // instance / request 参数不进入载荷，也就没有 tag（B.5）。
  const query = snapshot.resolveByMethodName("graph", "IGraphQuery", "Query");
  assert.ok(query !== undefined);
  assert.equal(query.methodId, 12);
  assert.equal(query.kind, "Query");
  assert.equal(query.parameters.length, 1);
  assert.equal(query.parameters[0]?.declaredType, "long");
  assert.deepEqual(query.result, {
    tag: 0,
    name: "matched",
    declaredType: "bool",
    wireType: "bool",
    enumName: undefined,
    enumWidth: undefined,
    optional: false,
  });

  assert.equal(snapshot.resolveMessage("graph", 10, undefined, undefined).state, "matched");
  assert.equal(snapshot.resolveMessage("graph", 99, undefined, undefined).state, "unknown-interface");
  assert.equal(snapshot.resolveMessage("graph", 0, "IGraphDebuger", "NodeStarted").state, "matched");
});

test("reads an explicit ArtifactsRoot from VisualBridgeDebugConfig.asset", async () => {
  assert.equal((await resolveArtifactsRoot(customProject)).value, "Assets/SampleArtifacts/Debug");
  // 没有配置资产时回落到 D2 默认值（附录 A.8 的 "" 即取此值）。
  assert.equal((await resolveArtifactsRoot(unityProject)).value, DEBUG_ARTIFACTS_ROOT_DEFAULT);

  const set = await new DebugContractRegistry().load({ projectRoots: [customProject] });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.contractHash, "0123456789abcdef");
  assert.equal(snapshot.primary?.directory, path.join(customProject, "Assets", "SampleArtifacts", "Debug"));
  const record = snapshot.resolveByMethodId("audit", 10);
  assert.equal(record?.parameters[1]?.wireType, "long", "uint 在线上按 8 字节 long 编码（A.4）");
});

test("a non-Unity Project root with no supplemental directory loads no contract and does not throw", async () => {
  const set = await new DebugContractRegistry().load({
    projectRoots: [path.join(repositoryRoot, "TestData", "EntitySemanticProject")],
  });

  assert.equal(set.hashes.length, 0);
  assert.equal(set.snapshots.length, 1);
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.empty, true);
  assert.equal(snapshot.loaded, false);
  assert.equal(snapshot.contractHash, "");
  assert.equal(snapshot.skipped.length, 0, "没进 Unity 工程就没有可定位的约定目录，不该产生噪音");
  assert.equal(set.warnings.length, 0);
});

test("a contract directory with another schemaVersion is not loaded at all", async () => {
  const set = await new DebugContractRegistry().load({
    projectRoots: [path.join(fixtures, "LegacyProject", "Assets")],
  });

  assert.equal(set.hashes.length, 0);
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.primary, undefined);
  assert.equal(snapshot.empty, true);
  assert.deepEqual(snapshot.skipped.map((skip) => [skip.reason, skip.directory]), [
    ["schemaVersion", path.join(fixtures, "LegacyProject", "Assets", "VisualBridgeGenerated", "Debug")],
  ]);
});

test("a supplemental directory adds interfaces but never overrides the conventional artifact", async () => {
  const set = await new DebugContractRegistry().load({
    projectRoots: [unityProject],
    supplementalDirectories: [supplementalDirectory],
  });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);

  // 指纹取主来源（C.8）；补充来源自己的指纹照原样暴露，供界面提示两侧 hash。
  assert.equal(snapshot.contractHash, "9f1c2d3e4a5b6c7d");
  assert.equal(snapshot.primary?.contractHash, "9f1c2d3e4a5b6c7d");
  assert.deepEqual(snapshot.supplemental.map((source) => [source.directory, source.contractHash]), [
    [supplementalDirectory, "aabbccddeeff0011"],
  ]);

  assert.equal(snapshot.conflicts.length, 1);
  const conflict = snapshot.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.kind, "interface");
  assert.equal(conflict.key, "Sample.Graph.IGraphDebuger");
  assert.equal(conflict.primaryDirectory, unityArtifacts);
  assert.equal(conflict.supplementalDirectory, supplementalDirectory);

  // 冲突接口保留主来源（id 11），界面标红通过 contractState 表达。
  assert.equal(snapshot.resolveByMethodId("graph", 11)?.name, "Ticked");
  assert.equal(snapshot.resolveByMethodId("graph", 21), undefined, "补充目录的同名接口不得覆盖主来源");
  assert.equal(snapshot.resolveMessage("graph", 11, undefined, undefined).state, "contract-conflict");
  assert.equal(snapshot.isConflicted("Sample.Graph.IGraphDebuger"), true);

  // 补充来源独有的接口照常合入。
  const ping = snapshot.resolveByMethodId("sample", 10);
  assert.equal(ping?.name, "Ping");
  assert.equal(ping?.interfaceFullName, "Sample.Extra.ISampleDebuger");
  assert.equal(snapshot.resolveMessage("sample", 10, undefined, undefined).state, "matched");
});

test("a supplemental-only workspace publishes the supplemental fingerprint", async () => {
  const set = await new DebugContractRegistry().load({
    projectRoots: [path.join(repositoryRoot, "TestData", "GraphSemanticProject")],
    supplementalDirectories: [supplementalDirectory],
  });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.primary, undefined);
  assert.equal(snapshot.contractHash, "aabbccddeeff0011");
  assert.equal(snapshot.loaded, true);
  assert.deepEqual(set.hashes, ["aabbccddeeff0011"]);
});

test("every Project root resolves its own Unity project instead of sharing one answer", async () => {
  const set = await new DebugContractRegistry().load({ projectRoots: [unityProject, customProject] });

  const unitySnapshot = set.byProjectRoot.get(path.resolve(unityProject));
  const customSnapshot = set.byProjectRoot.get(path.resolve(customProject));
  assert.ok(unitySnapshot !== undefined && customSnapshot !== undefined);
  assert.equal(unitySnapshot.contractHash, "9f1c2d3e4a5b6c7d");
  assert.equal(customSnapshot.contractHash, "0123456789abcdef");
  assert.deepEqual(set.hashes, ["0123456789abcdef", "9f1c2d3e4a5b6c7d"]);
  assert.equal(set.snapshotForHash("0123456789abcdef")?.contractHash, "0123456789abcdef");
  assert.equal(set.snapshotForHash("ffffffffffffffff"), undefined);

  // 不串台：graph 的方法只出现在第一个工程里。
  assert.equal(unitySnapshot.resolveByMethodId("graph", 10)?.name, "NodeStarted");
  assert.equal(customSnapshot.resolveByMethodId("graph", 10), undefined);
  assert.equal(customSnapshot.resolveByMethodId("audit", 10)?.name, "Record");
});

test("a missing supplemental directory warns exactly once per registry", async () => {
  const registry = new DebugContractRegistry();
  const missing = path.join(fixtures, "DoesNotExist");
  const projectRoots = [path.join(repositoryRoot, "TestData", "GraphSemanticProject")];

  const first = await registry.load({ projectRoots, supplementalDirectories: [missing] });
  assert.equal(first.hashes.length, 0);
  assert.equal(first.warnings.length, 1);
  assert.equal(first.warnings[0]?.directory, path.resolve(missing));
  assert.deepEqual(
    first.snapshots[0]?.skipped.map((skip) => skip.reason),
    ["missing"],
  );

  const second = await registry.load({ projectRoots, supplementalDirectories: [missing] });
  assert.equal(second.warnings.length, 0, "目录不存在只警告一次（C.8）");
});

test("hot reload swaps the snapshot without mutating the one already handed out", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "visualbridge-contract-"));
  try {
    await writeUnityProject(temporaryRoot, "aaaaaaaaaaaaaaaa", "graph", 10);
    const registry = new DebugContractRegistry();
    const first = await registry.load({ projectRoots: [temporaryRoot] });
    const firstSnapshot = first.snapshots[0];
    assert.ok(firstSnapshot !== undefined);
    assert.equal(firstSnapshot.contractHash, "aaaaaaaaaaaaaaaa");
    assert.equal(firstSnapshot.resolveByMethodId("graph", 10)?.name, "NodeStarted");

    await writeUnityProject(temporaryRoot, "bbbbbbbbbbbbbbbb", "graph", 10);
    const second = await registry.load({ projectRoots: [temporaryRoot] });
    const secondSnapshot = second.snapshots[0];
    assert.ok(secondSnapshot !== undefined);
    assert.equal(secondSnapshot.contractHash, "bbbbbbbbbbbbbbbb");
    assert.equal(registry.current.snapshots[0]?.contractHash, "bbbbbbbbbbbbbbbb");

    // 旧快照不可变：已按旧契约解出的记录不会被回溯重解（C.8/评审 P0）。
    assert.equal(firstSnapshot.contractHash, "aaaaaaaaaaaaaaaa");
    assert.equal(firstSnapshot.resolveByMethodId("graph", 10)?.name, "NodeStarted");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("malformed contracts are skipped with an explicit reason", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "visualbridge-contract-bad-"));
  try {
    const directory = path.join(temporaryRoot, "Assets", "VisualBridgeGenerated", "Debug");
    await fs.mkdir(path.join(temporaryRoot, "ProjectSettings"), { recursive: true });
    await fs.writeFile(path.join(temporaryRoot, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.10f1\n");
    await fs.mkdir(directory, { recursive: true });

    await fs.writeFile(path.join(directory, "debug-contracts.json"), "{ not json");
    const broken = await new DebugContractRegistry().load({ projectRoots: [temporaryRoot] });
    assert.equal(broken.hashes.length, 0);
    assert.equal(broken.snapshots[0]?.skipped[0]?.reason, "malformed");

    await fs.writeFile(
      path.join(directory, "debug-contracts.json"),
      JSON.stringify({ manifest: { schemaVersion: 2 }, contractHash: "XYZ", categories: [], enums: [] }),
    );
    const badHash = await new DebugContractRegistry().load({ projectRoots: [temporaryRoot] });
    assert.equal(badHash.hashes.length, 0);
    assert.equal(badHash.snapshots[0]?.skipped[0]?.reason, "contractHash");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("ArtifactsRoot values must stay project-relative", () => {
  assert.equal(normalizeProjectRelativePath("Assets\\VisualBridgeGenerated\\Debug"), "Assets/VisualBridgeGenerated/Debug");
  assert.equal(normalizeProjectRelativePath("./Assets/Debug/"), "Assets/Debug");
  assert.equal(normalizeProjectRelativePath("C:/Absolute/Debug"), undefined);
  assert.equal(normalizeProjectRelativePath("/Absolute/Debug"), undefined);
  assert.equal(normalizeProjectRelativePath("Assets/../../Outside"), undefined);
  assert.equal(normalizeProjectRelativePath("   "), undefined);
});

test("selects the lexicographically first VisualBridgeDebugConfig.asset regardless of walk order", () => {
  const alpha = "C:/project/Assets/Alpha/VisualBridgeDebugConfig.asset";
  const zeta = "C:/project/Assets/Zeta/VisualBridgeDebugConfig.asset";
  assert.equal(selectDebugConfigFile([zeta, alpha]), alpha);
  assert.equal(selectDebugConfigFile([alpha, zeta]), alpha);
  assert.equal(selectDebugConfigFile([]), undefined);
});

test("an invalid explicit ArtifactsRoot falls back to the default path and stays visible", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visualbridge-contract-artifacts-"));
  try {
    const contractHash = "abcdef0123456789";
    const artifactsDirectory = path.join(root, "Assets", "VisualBridgeGenerated", "Debug");
    await writeUnityProjectRoot(root);
    await writeDebugContract(artifactsDirectory, contractHash, [
      graphInterface({
        interfaceName: "IGraphDebuger",
        fullName: "Sample.Graph.IGraphDebuger",
        method: "NodeStarted",
        parameter: "nodeId",
        type: "int",
      }),
    ]);

    const configDirectory = path.join(root, "Assets", "Config");
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.writeFile(
      path.join(configDirectory, "VisualBridgeDebugConfig.asset"),
      [
        "%YAML 1.1",
        "--- !u!114 &11400000",
        "MonoBehaviour:",
        "  m_Name: VisualBridgeDebugConfig",
        "  artifactsRoot: C:/Outside/Debug",
        "",
      ].join("\n"),
    );

    const set = await new DebugContractRegistry().load({ projectRoots: [root] });
    const snapshot = set.snapshots[0];
    assert.ok(snapshot !== undefined);
    // "改了配置反而没契约"是更坏的失败：非法值回退 D2 默认路径继续加载。
    assert.equal(snapshot.contractHash, contractHash);
    assert.equal(snapshot.primary?.directory, artifactsDirectory);
    assert.equal(snapshot.resolveByMethodId("graph", 10)?.name, "NodeStarted");

    // 回退必须可见：快照里有 artifactsRoot skip，warnings 里有可读告警。
    assert.ok(
      snapshot.skipped.some((skip) => skip.reason === "artifactsRoot" && skip.detail.includes("C:/Outside/Debug")),
      `expected an artifactsRoot skip, received ${JSON.stringify(snapshot.skipped)}`,
    );
    assert.equal(set.warnings.length, 1);
    assert.match(set.warnings[0]?.message ?? "", /C:\/Outside\/Debug/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a supplemental method reusing a primary (category, methodId) is skipped with a method-level conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visualbridge-contract-collision-"));
  try {
    // 两种名字顺序都测：主方法名排序在前/在后都不得改变"主来源优先"。
    const cases = [
      {
        label: "primary sorts first",
        primary: { interfaceName: "IAlphaDebuger", fullName: "Sample.Graph.IAlphaDebuger", method: "Alpha", parameter: "alphaArg", type: "int" },
        supplemental: { interfaceName: "IZetaDebuger", fullName: "Sample.Graph.IZetaDebuger", method: "Zeta", parameter: "zetaArg", type: "string" },
      },
      {
        label: "primary sorts last",
        primary: { interfaceName: "IZetaDebuger", fullName: "Sample.Graph.IZetaDebuger", method: "Zeta", parameter: "zetaArg", type: "string" },
        supplemental: { interfaceName: "IAlphaDebuger", fullName: "Sample.Graph.IAlphaDebuger", method: "Alpha", parameter: "alphaArg", type: "int" },
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const unityRoot = path.join(root, `project-${index}`);
      const supplementalDirectory = path.join(root, `supplemental-${index}`);
      const primaryHash = `${index}`.repeat(16);
      const primaryDirectory = path.join(unityRoot, "Assets", "VisualBridgeGenerated", "Debug");
      await writeUnityProjectRoot(unityRoot);
      await writeDebugContract(primaryDirectory, primaryHash, [
        graphInterface(entry.primary),
        graphInterface({
          interfaceName: "IExtraDebuger",
          fullName: "Sample.Extra.IExtraDebuger",
          method: "Extra",
          parameter: "extraArg",
          type: "bool",
        }, 30),
      ]);
      await writeDebugContract(supplementalDirectory, "aabbccddeeff0011", [graphInterface(entry.supplemental)]);

      const set = await new DebugContractRegistry().load({
        projectRoots: [unityRoot],
        supplementalDirectories: [supplementalDirectory],
      });
      const snapshot = set.snapshots[0];
      assert.ok(snapshot !== undefined, entry.label);

      const resolved = snapshot.resolveByMethodId("graph", 10);
      assert.equal(resolved?.interfaceFullName, entry.primary.fullName, `${entry.label}: 主来源方法号不得被补充顶替`);
      assert.equal(resolved?.name, entry.primary.method, entry.label);
      assert.equal(resolved?.parameters[0]?.name, entry.primary.parameter, `${entry.label}: 参数名必须来自主来源`);
      assert.equal(resolved?.parameters[0]?.wireType, entry.primary.type === "int" ? "int" : "string", entry.label);

      // 冲突是 method 级、键是 category#methodId，两个目录都记下来。
      assert.equal(snapshot.conflicts.length, 1, entry.label);
      const conflict = snapshot.conflicts[0];
      assert.equal(conflict?.kind, "method", entry.label);
      assert.equal(conflict?.key, "graph#10", entry.label);
      assert.equal(conflict?.category, "graph", entry.label);
      assert.equal(conflict?.methodId, 10, entry.label);
      assert.equal(conflict?.primaryDirectory, primaryDirectory, entry.label);
      assert.equal(conflict?.supplementalDirectory, supplementalDirectory, entry.label);

      // 每个方法号只留一份声明（确定性构建，不靠"排序后 last-wins"）。
      assert.equal(
        snapshot.methods.filter((method) => method.category === "graph" && method.methodId === 10).length,
        1,
        entry.label,
      );
      assert.equal(
        snapshot.resolveByMethodName("graph", entry.supplemental.interfaceName, entry.supplemental.method),
        undefined,
        `${entry.label}: 被跳过的补充方法不得按名字解析到`,
      );

      // 补充来源独有的方法号照常合入（冲突只影响撞号的那个方法）。
      assert.equal(snapshot.resolveByMethodId("graph", 30)?.name, "Extra", entry.label);
      assert.equal(snapshot.resolveByMethodId("graph", 30)?.interfaceFullName, "Sample.Extra.IExtraDebuger", entry.label);
      // 主来源声明保留解码正确，但该号段有竞争声明 ⇒ 与接口冲突一样标红（C.8）。
      assert.equal(snapshot.resolveMessage("graph", 10, undefined, undefined).state, "contract-conflict", entry.label);
      assert.equal(snapshot.contractHash, primaryHash, entry.label);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeUnityProject(
  root: string,
  contractHash: string,
  category: string,
  methodId: number,
): Promise<void> {
  const directory = path.join(root, "Assets", "VisualBridgeGenerated", "Debug");
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.10f1\n");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "debug-contracts.json"),
    JSON.stringify({
      manifest: { schemaVersion: 2 },
      contractHash,
      categories: [{
        name: category,
        interfaces: [{
          name: "IGraphDebuger",
          fullName: "Sample.Graph.IGraphDebuger",
          kind: "Event",
          methods: [{
            name: "NodeStarted",
            id: methodId,
            returnType: "bool",
            parameters: [
              { name: "instanceId", type: "string", role: "instance", optional: false },
              { name: "nodeId", type: "int", tag: 1, role: "payload", optional: false },
            ],
          }],
        }],
      }],
      enums: [],
    }, undefined, 2),
  );
}

interface ContractMethodSpec {
  readonly interfaceName: string;
  readonly fullName: string;
  readonly method: string;
  readonly parameter: string;
  readonly type: string;
}

/** 一条 `graph` 分类下的单方法接口声明（P1-3 的撞号用例与 P2-1 的回退用例共用）。 */
function graphInterface(spec: ContractMethodSpec, methodId = 10): Record<string, unknown> {
  return {
    name: spec.interfaceName,
    fullName: spec.fullName,
    kind: "Event",
    methods: [{
      name: spec.method,
      id: methodId,
      returnType: "bool",
      parameters: [
        { name: "instanceId", type: "string", role: "instance", optional: false },
        { name: spec.parameter, type: spec.type, tag: 1, role: "payload", optional: false },
      ],
    }],
  };
}

async function writeUnityProjectRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await fs.writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.10f1\n");
}

async function writeDebugContract(
  directory: string,
  contractHash: string,
  interfaces: readonly unknown[],
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "debug-contracts.json"),
    JSON.stringify({
      manifest: { schemaVersion: 2 },
      contractHash,
      categories: [{ name: "graph", interfaces }],
      enums: [],
    }, undefined, 2),
  );
}
