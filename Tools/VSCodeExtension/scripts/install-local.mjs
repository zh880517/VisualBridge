// 打包后把 VSIX 安装到本地 VS Code。
// 依赖 code CLI 在 PATH 中；可用 CODE_CLI 环境变量指定其它可执行文件。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsixPath = path.join(packageRoot, "artifacts", "visualbridge.vsix");

if (!existsSync(vsixPath)) {
  console.error("[install-local] artifacts/visualbridge.vsix 不存在；请先执行打包。");
  process.exit(1);
}

const codeCli = process.env.CODE_CLI ?? "code";
// Windows 上 code 是 .cmd 脚本，需要 shell 解析。
const result = spawnSync(codeCli, ["--install-extension", vsixPath, "--force"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error !== undefined) {
  console.error(`[install-local] 无法启动 '${codeCli}'：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
