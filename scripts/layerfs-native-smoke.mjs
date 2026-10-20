import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Native integration proof with deterministic actors, not a model or full API/DB test.
const { LayerFS } = await import(pathToFileURL(process.env.LAYERFS_SDK_MODULE).href);
const { LayerFSCodeExperimentProvider } = await import("./production/layerfs-code-experiments.js");
const { executeCodeExperimentTool } = await import("./production/code-experiment-tools.js");
const run = promisify(execFile);
const root = "/work/proof";
const output = "/out";
const source = path.join(root, "source");
const report = {
  scope:
    "Native LayerFS v0.1.7 + Rakazo adapter; two deterministic bot contexts; no model, API server, or database",
  sourceRevision: "e7713d034b029c358c657959b7737e8d23c9d1e7",
  startedAt: new Date().toISOString(),
  checks: [],
  passed: false,
};
await mkdir(output, { recursive: true });
await mkdir(source, { recursive: true });
const git = (cwd, ...args) => run("git", args, { cwd });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseCode = "export const clamp = (value, min, max) => value;\n";
const codeA = "export const clamp = (value, min, max) => Math.max(min, value);\n";
const codeB = "export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));\n";
const testCode = `import assert from 'node:assert/strict';
import test from 'node:test';
import {clamp} from './clamp.mjs';
console.log('EXPERIMENT_START', Date.now());
await new Promise(resolve => setTimeout(resolve, 3000));
test('lower bound', () => assert.equal(clamp(-5, 0, 10), 0));
test('upper bound', () => assert.equal(clamp(15, 0, 10), 10));
test('inside range', () => assert.equal(clamp(5, 0, 10), 5));
process.on('beforeExit', () => console.log('EXPERIMENT_END', Date.now()));
`;
const check = (name, condition) => {
  report.checks.push({ name, passed: Boolean(condition) });
  process.stdout.write(`${condition ? "PASS" : "FAIL"}: ${name}\n`);
  assert.ok(condition, name);
};
const scope = (botId) => ({
  spaceId: "smoke-space",
  userId: "smoke-owner",
  botId,
  operationId: `${botId}-${Date.now()}`,
  traceId: "native-smoke",
  signal: AbortSignal.timeout(180_000),
});
const parallel = async (calls) => {
  const results = await Promise.allSettled(calls);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      failed.map((result) => String(result.reason)).join("; "),
    );
  return results.map((result) => result.value);
};
let client;
try {
  await git(source, "init", "--quiet", "--initial-branch=main");
  await git(source, "config", "user.name", "Smoke Agent");
  await git(source, "config", "user.email", "agent@example.invalid");
  await git(source, "config", "core.autocrlf", "false");
  await git(source, "config", "core.hooksPath", "/dev/null");
  await writeFile(path.join(source, "clamp.mjs"), baseCode);
  await writeFile(path.join(source, "clamp.test.mjs"), testCode);
  await git(source, "add", "clamp.mjs", "clamp.test.mjs");
  await git(source, "commit", "--quiet", "-m", "Prepare clamp experiment");
  const base = (await git(source, "rev-parse", "HEAD")).stdout.trim();
  report.gitBase = base;
  report.runtimeImage = process.env.LAYERFS_IMAGE;
  report.node = process.version;
  report.architecture = process.arch;
  report.daemonSha256 = hash(await readFile(process.env.LAYERFS_DAEMON));
  report.addonSha256 = hash(await readFile("/opt/layerfs/sdk/js/native/layerfs.node"));

  client = new LayerFS("native-code-lab");
  await client.project.init(source);
  check("native project initialized", true);
  const provider = new LayerFSCodeExperimentProvider({
    spaceId: "smoke-space",
    userId: "smoke-owner",
    project: "native-code-lab",
    gitBase: base,
    stateDir: path.join(root, "state"),
    client: async () => client,
  });
  const connection = { spaceId: "smoke-space", userId: "smoke-owner", provider };
  const call = async (bot, args) => {
    const value = await executeCodeExperimentTool(
      connection,
      scope(bot),
      args,
      async (_name, patch) => {
        const file = path.join(output, "winner.patch");
        await writeFile(file, patch, { flag: "wx" });
        return { path: "winner.patch", bytes: Buffer.byteLength(patch) };
      },
    );
    if (value.error) throw new Error(`${args.action}: ${JSON.stringify(value)}`);
    return value;
  };

  const [a, b] = await parallel([
    call("agent-a", { action: "fork", experiment: "bounds" }),
    call("agent-b", { action: "fork", experiment: "bounds" }),
  ]);
  report.branches = { a: a.ref, b: b.ref };
  check("two bot contexts have distinct experiment branches", a.ref !== b.ref);
  const [writeA, writeB] = await parallel([
    call("agent-a", {
      action: "write",
      experiment: "bounds",
      path: "/clamp.mjs",
      content: codeA,
      message: "Try lower-bound-only fix",
    }),
    call("agent-b", {
      action: "write",
      experiment: "bounds",
      path: "/clamp.mjs",
      content: codeB,
      message: "Try both bounds",
    }),
  ]);
  report.writeCheckpoints = { a: writeA.checkpoint, b: writeB.checkpoint };
  const [viewA, viewB, viewMain] = await Promise.all([
    client.fs.read(a.ref, "/clamp.mjs"),
    client.fs.read(b.ref, "/clamp.mjs"),
    client.fs.read("main", "/clamp.mjs"),
  ]);
  check("agent A sees only candidate A at the same path", viewA.text === codeA);
  check("agent B sees only candidate B at the same path", viewB.text === codeB);
  check("LayerFS main remains unchanged", viewMain.text === baseCode);

  const [testA, testB] = await parallel([
    call("agent-a", {
      action: "run",
      experiment: "bounds",
      command: "node --test clamp.test.mjs",
      message: "Test candidate A",
    }),
    call("agent-b", {
      action: "run",
      experiment: "bounds",
      command: "node --test clamp.test.mjs",
      message: "Test candidate B",
    }),
  ]);
  report.tests = { a: testA, b: testB };
  check("candidate A fails the upper-bound test", testA.execution.exitCode !== 0);
  check("candidate B passes every test", testB.execution.exitCode === 0);
  const interval = (result) => {
    const text = result.execution.stdout;
    return {
      start: Number(text.match(/EXPERIMENT_START (\d+)/)?.[1]),
      end: Number(text.match(/EXPERIMENT_END (\d+)/)?.[1]),
    };
  };
  report.executionIntervals = { a: interval(testA), b: interval(testB) };
  const intervals = Object.values(report.executionIntervals);
  check(
    "native test processes actually overlap",
    Math.max(...intervals.map((i) => i.start)) < Math.min(...intervals.map((i) => i.end)),
  );
  check(
    "failed tests still return an acknowledged checkpoint",
    ["Committed", "UpToDate"].includes(testA.checkpoint.kind),
  );

  const history = await client.branch.list_commits(a.ref, 10, 0);
  const saved = history.items[0].id;
  const revisit = await call("agent-a", { action: "fork", experiment: "revisit", from: saved });
  check(
    "forking a saved file checkpoint preserves candidate A",
    (await client.fs.read(revisit.ref, "/clamp.mjs")).text === codeA,
  );
  report.revisitedCheckpoint = saved;
  await call("agent-b", {
    action: "run",
    experiment: "bounds",
    command:
      "git add -- clamp.mjs && git -c user.name='Smoke Agent' -c user.email='agent@example.invalid' commit -m 'Clamp values to both bounds'",
    message: "Commit winning code for Git delivery",
  });
  report.export = await call("agent-b", { action: "export", experiment: "bounds" });
  const patch = await readFile(path.join(output, "winner.patch"));
  check("a nonempty Git patch was exported", patch.length > 0);
  report.patchSha256 = hash(patch);
  const delivery = path.join(root, "delivery");
  await git(root, "clone", "--quiet", "--no-hardlinks", source, delivery);
  await git(delivery, "apply", "--check", path.join(output, "winner.patch"));
  check("Git apply --check accepts the patch on the original base", true);
  await git(delivery, "apply", path.join(output, "winner.patch"));
  const deliveryTests = await run(process.execPath, ["--test", "clamp.test.mjs"], {
    cwd: delivery,
  });
  report.deliveryTests = deliveryTests.stdout;
  check("tests pass in the independent Git delivery clone", true);
  check(
    "delivery clone contains the winning file",
    (await readFile(path.join(delivery, "clamp.mjs"), "utf8")) === codeB,
  );
  check(
    "original source file is unchanged",
    (await readFile(path.join(source, "clamp.mjs"), "utf8")) === baseCode,
  );
  check(
    "original source Git HEAD and working tree are unchanged",
    (await git(source, "rev-parse", "HEAD")).stdout.trim() === base &&
      (await git(source, "status", "--porcelain")).stdout === "",
  );
  check(
    "LayerFS main is still unchanged after Git delivery",
    (await client.fs.read("main", "/clamp.mjs")).text === baseCode,
  );
  for (const sandbox of [...client.sandboxes]) await client.sandbox.close(sandbox);
  check("the fresh project's SDK sandboxes closed without forced cleanup", true);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  report.recovery =
    "The dedicated runner/engine and their data are retained. Inspect discovery records and adapter journals; do not blindly retry the failed operation.";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, checks: report.checks, error: report.error ?? null }, null, 2)}\n`,
  );
}
