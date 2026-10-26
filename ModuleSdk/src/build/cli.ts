#!/usr/bin/env node
/**
 * 模块打包 CLI。
 *
 * 用法：`visualbridge-build-module <config.json>`
 * 配置中的相对路径相对于配置文件所在目录；输出 JSON 供脚本消费。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildModule, ModuleBuildError, readModuleBuildConfig } from "./index";

async function main(argv: readonly string[]): Promise<number> {
  const configArgument = argv[0];
  if (configArgument === undefined || configArgument === "--help" || configArgument === "-h") {
    process.stderr.write("Usage: visualbridge-build-module <config.json>\n");
    return configArgument === undefined ? 2 : 0;
  }

  const configPath = path.resolve(configArgument);
  let configText: string;
  try {
    configText = await readFile(configPath, "utf8");
  } catch (errorValue) {
    process.stderr.write(`Failed to read module build config '${configPath}': ${describeError(errorValue)}\n`);
    return 1;
  }

  let configValue: unknown;
  try {
    configValue = JSON.parse(configText);
  } catch (errorValue) {
    process.stderr.write(`Invalid JSON in module build config '${configPath}': ${describeError(errorValue)}\n`);
    return 1;
  }

  try {
    const config = readModuleBuildConfig(configValue);
    const result = await buildModule({
      ...config,
      workingDirectory: path.dirname(configPath),
    });
    process.stdout.write(`${JSON.stringify({
      outfile: result.outfile,
      hash: result.hash,
      byteLength: result.byteLength,
      manifest: result.manifest,
      webviews: Object.keys(result.webviews).sort(),
    }, undefined, 2)}\n`);
    return 0;
  } catch (errorValue) {
    if (errorValue instanceof ModuleBuildError) {
      process.stderr.write(`[${errorValue.code}] ${errorValue.message}\n`);
    } else {
      process.stderr.write(`Module build failed: ${describeError(errorValue)}\n`);
    }
    return 1;
  }
}

function describeError(errorValue: unknown): string {
  return errorValue instanceof Error ? `${errorValue.name}: ${errorValue.message}` : String(errorValue);
}

void main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
