"use strict";

// 测试与工具共用的 Project File v2 构造器：避免每个用例各写一遍 formatVersion、modules 与
// tableLayout 的位置细节。源码侧解析与序列化仍以 @visualbridge/core 为准。

const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const PROJECT_FILE_NAME = "VisualBridge.project.vbjson";
const PROJECT_FORMAT_VERSION = 2;

/**
 * 生成 Project File 定义对象。缺省值只保证结构合法（modules 为空数组），调用方按需覆盖；
 * `extra` 用于负向用例附加未知顶层键。
 */
function createTestProject(options = {}) {
  const {
    formatVersion = PROJECT_FORMAT_VERSION,
    projectId = "test.project",
    documentRoots = ["Config"],
    modules = [],
    documentTypes = [],
    providers,
    extra,
  } = options;
  return {
    formatVersion,
    projectId,
    documentRoots,
    modules,
    documentTypes,
    ...(providers === undefined ? {} : { providers }),
    ...(extra === undefined ? {} : extra),
  };
}

/**
 * 在 `directory` 下写入 `VisualBridge.project.vbjson`，返回定义、文本与实际路径。
 */
async function writeTestProject(directory, options = {}) {
  const project = createTestProject(options);
  // 与仓库惯例一致的序列化：两空格缩进 + 末尾换行。
  const text = `${JSON.stringify(project, undefined, 2)}\n`;
  const filePath = path.join(directory, PROJECT_FILE_NAME);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, text, "utf8");
  return { project, text, path: filePath };
}

module.exports = { createTestProject, writeTestProject };
