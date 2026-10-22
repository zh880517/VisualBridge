// Runs the host-independent suites that exercise the shared runtime with
// Node's built-in test coverage and writes a plain-text report per target.
// `output/` is gitignored; CI uploads `output/coverage/` as an artifact.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputRoot = path.join(repositoryRoot, "output", "coverage");
// Minimum line coverage percentages, keyed by target name. Raise these as the
// suites improve; a missing threshold is treated as a configuration error.
const MINIMUM_LINE_COVERAGE = {
  core: 80,
  "node-host": 50,
  mcp: 40,
};
// Invoke npm through its JavaScript entry point when available: spawning
// `npm.cmd` directly is rejected on Windows unless a shell is involved.
const npmCommand = process.env.npm_execpath
  ? { executable: process.execPath, prefix: [process.env.npm_execpath], shell: false }
  : { executable: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: process.platform === "win32" };

const targets = [
  {
    name: "core",
    workspace: "@visualbridge/core",
    directory: "Core",
  },
  {
    name: "node-host",
    workspace: "@visualbridge/node-host",
    directory: "Tools/NodeHost",
  },
  {
    name: "mcp",
    workspace: "@visualbridge/mcp",
    directory: "Tools/VisualBridgeMcp",
  },
];

const failures = [];
const coverageRows = [];
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const summaryLines = ["VisualBridge test coverage", ""];

for (const target of targets) {
  const threshold = MINIMUM_LINE_COVERAGE[target.name];
  if (typeof threshold !== "number") {
    throw new Error(`Missing MINIMUM_LINE_COVERAGE entry for target '${target.name}'.`);
  }
  const build = runCommand(
    npmCommand.executable,
    [...npmCommand.prefix, "run", "build", "--workspace", target.workspace],
    repositoryRoot,
    npmCommand.shell,
  );
  if (build.status !== 0) {
    failures.push(`${target.name} build`);
    coverageRows.push({ name: target.name, lines: null, threshold, passed: false, reason: "build failed" });
    summaryLines.push(`${target.name}: build FAILED (exit ${build.status ?? "unknown"})`);
    process.stdout.write(`\n===== ${target.name} build FAILED =====\n${build.output}`);
    continue;
  }

  const testFiles = await findTests(path.join(repositoryRoot, target.directory));
  if (testFiles.length === 0) {
    failures.push(`${target.name} tests`);
    coverageRows.push({ name: target.name, lines: null, threshold, passed: false, reason: "no tests" });
    summaryLines.push(`${target.name}: no test files found`);
    continue;
  }

  const workingDirectory = path.join(repositoryRoot, target.directory);
  const report = runCommand(
    process.execPath,
    // Serial workers keep V8 coverage files from concurrent workers from
    // racing each other ("Could not report code coverage" on some suites).
    ["--experimental-test-coverage", "--test-concurrency=1", "--test", ...testFiles],
    workingDirectory,
  );
  const header = [
    `target: ${target.name}`,
    `workspace: ${target.workspace}`,
    `tests: ${testFiles.length}`,
    `exit: ${report.status ?? "unknown"}`,
    "",
  ].join("\n");
  const output = `${header}${report.output}`;
  await writeFile(path.join(outputRoot, `${target.name}.txt`), output, "utf8");

  const lineCoverage = parseLineCoverage(report.output);
  const coveragePassed = report.status === 0 && lineCoverage !== null && lineCoverage >= threshold;
  coverageRows.push({
    name: target.name,
    lines: lineCoverage,
    threshold,
    passed: coveragePassed,
    reason: report.status !== 0 ? "tests failed" : lineCoverage === null ? "coverage unavailable" : undefined,
  });

  if (report.status !== 0) {
    failures.push(`${target.name} tests`);
    summaryLines.push(`${target.name}: tests FAILED (exit ${report.status ?? "unknown"})`);
  } else if (lineCoverage === null) {
    failures.push(`${target.name} coverage`);
    summaryLines.push(`${target.name}: coverage report unavailable`);
  } else if (lineCoverage < threshold) {
    failures.push(`${target.name} line coverage`);
    summaryLines.push(`${target.name}: line coverage ${lineCoverage.toFixed(2)}% is below ${threshold}%`);
  } else {
    summaryLines.push(
      `${target.name}: passed (${testFiles.length} test files, line coverage ${lineCoverage.toFixed(2)}%)`,
    );
  }
  process.stdout.write(`\n===== ${target.name} =====\n${output}`);
}

summaryLines.push("", "Coverage thresholds:", "workspace   lines      threshold   result");
for (const row of coverageRows) {
  const lines = row.lines === null ? "n/a" : `${row.lines.toFixed(2)}%`;
  const result = row.passed ? "PASS" : `FAIL${row.reason ? ` (${row.reason})` : ""}`;
  summaryLines.push(`${row.name.padEnd(11)} ${lines.padEnd(10)} ${`${row.threshold}%`.padEnd(11)} ${result}`);
}

summaryLines.push("", failures.length === 0 ? "status: passed" : `status: failed (${failures.join(", ")})`);
await writeFile(path.join(outputRoot, "summary.txt"), `${summaryLines.join("\n")}\n`, "utf8");
process.stdout.write(`\n${summaryLines.slice(summaryLines.indexOf("Coverage thresholds:")).join("\n")}\n`);
process.stdout.write(`\nCoverage reports written to ${path.relative(repositoryRoot, outputRoot).replaceAll("\\", "/")}\n`);

if (failures.length > 0) {
  process.exitCode = 1;
}

async function findTests(workspaceDirectory) {
  // Reuse the exact file list from the workspace's own `test` script so this
  // runner cannot silently pick up stale compiled tests.
  const manifest = JSON.parse(await readFile(path.join(workspaceDirectory, "package.json"), "utf8"));
  const testScript = manifest.scripts?.test;
  if (typeof testScript !== "string") {
    throw new Error(`${workspaceDirectory}/package.json must declare a test script.`);
  }
  const testCommand = testScript.split(/\s*&&\s*/u).find((command) => command.startsWith("node --test "));
  if (!testCommand) {
    throw new Error(`${workspaceDirectory}/package.json test script must invoke 'node --test'.`);
  }
  const files = testCommand.slice("node --test ".length).split(/\s+/u).filter(Boolean);
  if (files.length === 0) {
    throw new Error(`${workspaceDirectory}/package.json test script does not list test files.`);
  }
  return files;
}

function parseLineCoverage(output) {
  // Node prints "# all files | line % | branch % | funcs % | uncovered lines".
  const match = /^#\s+all files\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)/mu.exec(output);
  return match ? Number.parseFloat(match[1]) : null;
}

function runCommand(executable, args, cwd, shell = false) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    shell,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    return { status: typeof result.status === "number" ? result.status : 1, output: `${output}${result.error.stack ?? result.error.message}` };
  }
  return { status: result.status, output };
}
