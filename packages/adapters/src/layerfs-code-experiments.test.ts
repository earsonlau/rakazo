import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayerFSExperimentClient } from "./layerfs-code-experiments.js";
import {
  createCodeExperimentConnection,
  LayerFSCodeExperimentProvider,
  verifiedPatch,
} from "./layerfs-code-experiments.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => {
      if (
        path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
        !path.basename(directory).startsWith("rakazo-experiments-")
      ) {
        throw new Error("Refusing cleanup outside the test temporary directory");
      }
      return rm(directory, { recursive: true, force: true });
    }),
  );
});
const context = (botId = "bot-a"): AdapterContext => ({
  spaceId: "space-a",
  userId: "owner-a",
  botId,
  operationId: "call-a",
  traceId: "trace-a",
  signal: new AbortController().signal,
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rakazo-experiments-"));
  temporary.push(directory);
  const files = new Map<string, Map<string, string>>([["main", new Map([["/file", "base"]])]]);
  let nextSandbox = 0;
  const client = {
    service: vi.fn(async () => "service-sandbox"),
    project: { list_branches: vi.fn(async () => ({ items: [...files.keys()], hasMore: false })) },
    fs: {
      read: vi.fn(async (ref: string, file: string) => ({ text: files.get(ref)?.get(file) })),
      write: vi.fn(async (ref: string, file: string, content: string) => {
        files.get(ref)!.set(file, content);
        return { head: "checkpoint-1" };
      }),
    },
    branch: {
      fork: vi.fn(async (name: string, from = "main") => {
        files.set(name, new Map(files.get(from)));
        return { head: "base" };
      }),
      merge: vi.fn(async () => ({ head: "merged" })),
      list_commits: vi.fn(async () => ({ items: [], hasMore: false })),
      diff_branches: vi.fn(async () => ({ items: [], hasMore: false })),
    },
    sandbox: {
      create: vi.fn(async () => `sandbox-${++nextSandbox}`),
      mount: vi.fn(async () => ({ path: "/workspace" })),
      exec: vi.fn<LayerFSExperimentClient["sandbox"]["exec"]>(async () => ({
        stdout: "test output",
        stderr: "",
        exitCode: 0,
      })),
      commit: vi.fn(async () => ({ kind: "Committed" })),
      unmount: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  };
  const options = {
    spaceId: "space-a",
    userId: "owner-a",
    project: "sample",
    gitBase: "a".repeat(40),
    stateDir: directory,
    client: async () => client,
  };
  return {
    directory,
    files,
    client,
    options,
    provider: new LayerFSCodeExperimentProvider(options),
  };
}
async function journals(directory: string) {
  const entries = await readdir(directory, { recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => JSON.parse(await readFile(path.join(directory, entry), "utf8"))),
  );
}

describe("LayerFS adapter conformance (offline SDK double)", () => {
  it("queues project discovery mutations across instances without serializing test execution", async () => {
    const { provider, options, client } = await fixture();
    const other = new LayerFSCodeExperimentProvider(options);
    await provider.execute({ action: "list" }, context());
    await other.execute({ action: "list" }, context("bot-b"));
    let creating = 0;
    let largestCreate = 0;
    let executing = 0;
    let largestExec = 0;
    let next = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.sandbox.create.mockImplementation(async () => {
      creating++;
      largestCreate = Math.max(largestCreate, creating);
      await delay(20);
      creating--;
      return `sandbox-${++next}`;
    });
    client.sandbox.exec.mockImplementation(async () => {
      executing++;
      largestExec = Math.max(largestExec, executing);
      if (executing === 2) release();
      await Promise.race([
        both,
        delay(1500).then(() => {
          throw new Error("Commands did not overlap");
        }),
      ]);
      executing--;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const results = await Promise.all([
      provider.execute({ action: "run", experiment: "fix", command: "test" }, context()),
      other.execute({ action: "run", experiment: "fix", command: "test" }, context("bot-b")),
    ]);
    expect(results.every((result) => result.checkpoint)).toBe(true);
    expect(largestCreate).toBe(1);
    expect(largestExec).toBe(2);
  });

  it("retains an uncertain allocation and does not replay it for another experiment", async () => {
    const { provider, client, directory } = await fixture();
    client.sandbox.create.mockRejectedValue(new Error("Unknown create outcome"));
    expect(
      await provider.execute({ action: "checkpoint", experiment: "first" }, context()),
    ).toHaveProperty("uncertain", true);
    expect(await journals(directory)).toEqual(
      expect.arrayContaining([expect.objectContaining({ operation: "create" })]),
    );
    await provider.execute(
      { action: "checkpoint", experiment: "second" },
      { ...context(), signal: AbortSignal.timeout(100) },
    );
    expect(client.sandbox.create).toHaveBeenCalledOnce();
  });
  it("is off by default and validates explicit setup without loading an SDK", () => {
    expect(createCodeExperimentConnection("data", {})).toBeNull();
    expect(() =>
      createCodeExperimentConnection("data", { CODE_EXPERIMENT_PROVIDER: "typo" }),
    ).toThrow();
    expect(() =>
      createCodeExperimentConnection("data", { CODE_EXPERIMENT_PROVIDER: "layerfs" }),
    ).toThrow("SPACE_ID");
    const configured = {
      CODE_EXPERIMENT_PROVIDER: "layerfs",
      CODE_EXPERIMENT_SPACE_ID: "space-a",
      CODE_EXPERIMENT_USER_ID: "owner-a",
      CODE_EXPERIMENT_GIT_BASE: "a".repeat(40),
      LAYERFS_PROJECT: "sample",
      LAYERFS_SDK_MODULE: path.resolve("not-loaded-sdk.mjs"),
    };
    expect(createCodeExperimentConnection("data", configured)).not.toBeNull();
    expect(() =>
      createCodeExperimentConnection("data", {
        ...configured,
        CODE_EXPERIMENT_GIT_BASE: "HEAD; exit 0",
      }),
    ).toThrow("full Git base");
    expect(() =>
      createCodeExperimentConnection("data", { ...configured, LAYERFS_SDK_MODULE: "relative.js" }),
    ).toThrow("absolute local path");
  });

  it("rejects another scope before touching the backend", async () => {
    const { provider, client } = await fixture();
    await expect(
      provider.execute({ action: "list" }, { ...context(), userId: "owner-b" }),
    ).rejects.toThrow("owner and space");
    await expect(
      provider.execute({ action: "list" }, { ...context(), spaceId: "space-b" }),
    ).rejects.toThrow();
    await expect(
      provider.execute({ action: "list" }, { ...context(), botId: undefined }),
    ).rejects.toThrow();
    expect(client.project.list_branches).not.toHaveBeenCalled();
  });

  it("gives bots distinct branches, checkpoints writes, and permits explicit handoff forks", async () => {
    const { provider, client, files } = await fixture();
    const a = await provider.execute({ action: "fork", experiment: "fix" }, context());
    const b = await provider.execute({ action: "fork", experiment: "fix" }, context("bot-b"));
    expect(a.ref).not.toBe(b.ref);
    await provider.execute(
      { action: "write", experiment: "fix", path: "/file", content: "A" },
      context(),
    );
    expect(files.get(String(a.ref))?.get("/file")).toBe("A");
    expect(files.get(String(b.ref))?.get("/file")).toBe("base");
    expect(files.get("main")?.get("/file")).toBe("base");
    await provider.execute(
      { action: "fork", experiment: "retry", from: String(a.ref) },
      context("bot-b"),
    );
    expect(client.branch.fork).toHaveBeenLastCalledWith(expect.any(String), a.ref);
    await provider.execute(
      { action: "fork", experiment: "rewind", from: "saved-checkpoint-id" },
      context(),
    );
    expect(client.branch.fork).toHaveBeenLastCalledWith(expect.any(String), "saved-checkpoint-id");
  });

  it("saves failed tests before releasing the workspace and uses the tagged SDK signatures", async () => {
    const { provider, client, directory } = await fixture();
    client.sandbox.exec.mockResolvedValue({
      stdout: "failed test",
      stderr: "assertion",
      exitCode: 1,
    });
    const result = await provider.execute(
      {
        action: "run",
        experiment: "fix",
        command: "printf '%s' \"a'b\"; exit 1",
        message: "Try fix",
      },
      context(),
    );
    expect(result).toMatchObject({ execution: { exitCode: 1 }, checkpoint: { kind: "Committed" } });
    expect(client.sandbox.exec).toHaveBeenCalledWith(
      "sandbox-1",
      "/workspace",
      expect.stringContaining("timeout --signal=TERM --kill-after=5s 120s bash -c '"),
      "Try fix",
    );
    expect(client.sandbox.commit).toHaveBeenCalledWith("sandbox-1", "/workspace", {
      message: "Try fix",
    });
    expect(client.sandbox.commit.mock.invocationCallOrder[0]).toBeLessThan(
      client.sandbox.unmount.mock.invocationCallOrder[0]!,
    );
    expect(client.sandbox.unmount.mock.invocationCallOrder[0]).toBeLessThan(
      client.sandbox.close.mock.invocationCallOrder[0]!,
    );
    expect(await journals(directory)).toEqual([]);
  });

  it("blocks overlapping operations across provider instances but not different bots", async () => {
    const { provider, options, client } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.sandbox.exec.mockImplementationOnce(async () => {
      started();
      await gate;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const first = provider.execute(
      { action: "run", experiment: "fix", command: "test" },
      context(),
    );
    await ready;
    const otherProcess = new LayerFSCodeExperimentProvider(options);
    expect(
      await otherProcess.execute({ action: "checkpoint", experiment: "fix" }, context()),
    ).toHaveProperty("error");
    expect(
      await otherProcess.execute({ action: "checkpoint", experiment: "fix" }, context("bot-b")),
    ).toHaveProperty("checkpoint");
    release();
    await first;
  });

  it("retains a conflicting workspace and journal, never forces or replays", async () => {
    const { provider, client, directory } = await fixture();
    client.sandbox.commit.mockRejectedValue(new Error("Conflict"));
    expect(
      await provider.execute({ action: "run", experiment: "fix", command: "edit" }, context()),
    ).toMatchObject({
      uncertain: true,
      recovery: { sandbox: "sandbox-1", workspace: "/workspace" },
    });
    expect(client.sandbox.unmount).not.toHaveBeenCalled();
    expect(client.sandbox.close).not.toHaveBeenCalled();
    expect(await journals(directory)).toMatchObject([
      { ref: expect.any(String), sandbox: "sandbox-1" },
    ]);
    expect(
      await provider.execute({ action: "run", experiment: "fix", command: "edit" }, context()),
    ).toHaveProperty("error");
    expect(client.sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it("retains teardown failures instead of closing a mounted workspace", async () => {
    const { provider, client, directory } = await fixture();
    client.sandbox.unmount.mockRejectedValue(new Error("Busy"));
    expect(
      await provider.execute({ action: "checkpoint", experiment: "fix" }, context()),
    ).toHaveProperty("uncertain", true);
    expect(client.sandbox.close).not.toHaveBeenCalled();
    expect(await journals(directory)).toHaveLength(1);
  });

  it("does no work after pre-cancellation and saves an acknowledged command after mid-command cancellation", async () => {
    const { provider, client } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.execute(
        { action: "run", experiment: "fix", command: "edit" },
        { ...context(), signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(client.sandbox.create).not.toHaveBeenCalled();
    const running = new AbortController();
    client.sandbox.exec.mockImplementationOnce(async () => {
      running.abort();
      return { stdout: "done", stderr: "", exitCode: 0 };
    });
    expect(
      await provider.execute(
        { action: "run", experiment: "fix", command: "edit" },
        { ...context(), signal: running.signal },
      ),
    ).toHaveProperty("checkpoint");
    expect(client.sandbox.close).toHaveBeenCalledOnce();
  });

  it("fails closed for the incompatible main-branch mount contract", async () => {
    const { provider, client } = await fixture();
    client.sandbox.mount.mockResolvedValue("/workspace" as unknown as { path: string });
    expect(
      await provider.execute({ action: "run", experiment: "fix", command: "edit" }, context()),
    ).toHaveProperty("uncertain", true);
    expect(client.sandbox.exec).not.toHaveBeenCalled();
  });

  it("keeps pagination and merge arguments bounded and never exposes publish", async () => {
    const { provider, client } = await fixture();
    await provider.execute({ action: "list", offset: 50 }, context());
    expect(client.project.list_branches).toHaveBeenCalledWith(50, 50);
    await provider.execute({ action: "history", ref: "main", offset: 100 }, context());
    expect(client.branch.list_commits).toHaveBeenCalledWith("main", 50, 100);
    await provider.execute({ action: "diff", left: "a", right: "b", offset: 50 }, context());
    expect(client.branch.diff_branches).toHaveBeenCalledWith("a", "b", 50, 50);
    await provider.execute(
      { action: "merge", experiment: "combined", left: "a", right: "b" },
      context(),
    );
    expect(client.branch.merge).toHaveBeenCalledWith(
      "a",
      "b",
      expect.stringContaining("combined"),
      "Merge experiments",
    );
  });

  it("verifies export output rather than silently saving a truncated patch", async () => {
    const { provider, client } = await fixture();
    const patch = "diff --git a/a b/a\n";
    const output = `${createHash("sha256").update(patch).digest("hex")}\n${patch}`;
    client.sandbox.exec.mockResolvedValue({ stdout: output, stderr: "", exitCode: 0 });
    expect(
      await provider.execute({ action: "export", experiment: "fix" }, context()),
    ).toHaveProperty("patch", patch);
    expect(() => verifiedPatch(output.slice(0, -1))).toThrow("integrity");
    client.sandbox.exec.mockResolvedValue({ stdout: output.slice(0, -1), stderr: "", exitCode: 0 });
    expect(
      await provider.execute({ action: "export", experiment: "fix" }, context()),
    ).toHaveProperty("error");
    client.sandbox.exec.mockResolvedValue({
      stdout: "",
      stderr: "Commit pending changes",
      exitCode: 2,
    });
    expect(
      await provider.execute({ action: "export", experiment: "fix" }, context()),
    ).toMatchObject({ error: "Commit pending changes", exitCode: 2 });
  });
});

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
it.skipIf(!existsSync(bash))(
  "exports a real Git patch that applies to the base, including a new file",
  async () => {
    const { options, client, directory } = await fixture();
    const run = promisify(execFile);
    const git = (...args: string[]) =>
      run("git", args, {
        cwd: directory,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        },
      });
    await git("init", "--quiet");
    await git("config", "user.name", "Test Agent");
    await git("config", "user.email", "agent@example.invalid");
    await writeFile(path.join(directory, "file.txt"), "base\n");
    await git("add", "file.txt");
    await git("commit", "--quiet", "-m", "Base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(directory, "file.txt"), "winner\n");
    await writeFile(path.join(directory, "new.txt"), "new file\n");
    const binary = Buffer.from([0, 1, 2, 255, 0, 128]);
    await writeFile(path.join(directory, "new.bin"), binary);
    await git("add", "file.txt", "new.txt", "new.bin");
    await git("commit", "--quiet", "-m", "Winning experiment");
    client.sandbox.exec.mockImplementation(
      async (_id: string, _workspace: string, command: string) => {
        try {
          const result = await run(bash, ["-c", command], { cwd: directory });
          return { ...result, exitCode: 0 };
        } catch (error) {
          const failure = error as { stdout: string; stderr: string; code: number };
          return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.code };
        }
      },
    );
    const sdk: LayerFSExperimentClient = client;
    const provider = new LayerFSCodeExperimentProvider({
      ...options,
      gitBase: base,
      stateDir: path.join(directory, ".git", "experiment-locks"),
      client: async () => sdk,
    });
    const exported = await provider.execute({ action: "export", experiment: "winner" }, context());
    expect(exported.error).toBeUndefined();
    expect(exported.patch).toContain("new.txt");
    await git("checkout", "--quiet", "--detach", base);
    const patchFile = path.join(directory, "result.patch");
    await writeFile(patchFile, String(exported.patch));
    await git("apply", "--check", patchFile);
    await git("apply", patchFile);
    expect(await readFile(path.join(directory, "file.txt"), "utf8")).toBe("winner\n");
    expect(await readFile(path.join(directory, "new.txt"), "utf8")).toBe("new file\n");
    expect(await readFile(path.join(directory, "new.bin"))).toEqual(binary);
  },
);

it("initializes only an explicit clean, sanitized source at the configured Git base", async () => {
  const { directory } = await fixture();
  const run = promisify(execFile);
  const source = path.join(directory, "source");
  await run("git", ["init", "--quiet", source]);
  const git = (...args: string[]) => run("git", ["-C", source, ...args]);
  await git("config", "user.name", "Test Agent");
  await git("config", "user.email", "agent@example.invalid");
  await writeFile(path.join(source, ".gitignore"), ".env.local\n");
  await git("add", ".gitignore");
  await git("commit", "--quiet", "-m", "Base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  const module = path.join(directory, "sdk.mjs");
  const receipt = path.join(directory, "receipt.json");
  await writeFile(
    module,
    `import {writeFile} from 'node:fs/promises';
export class LayerFS { constructor(project) { this.project = { init: async source => writeFile(process.env.TEST_RECEIPT, JSON.stringify({project,source})) }; } }`,
  );
  const env = {
    ...process.env,
    LAYERFS_PROJECT: "sample",
    LAYERFS_SDK_MODULE: module,
    CODE_EXPERIMENT_GIT_BASE: base,
    TEST_RECEIPT: receipt,
  };
  const initialize = (overrides = {}) =>
    run(process.execPath, ["scripts/init-code-experiments.mjs", source], {
      env: { ...env, ...overrides },
    });
  await expect(initialize({ CODE_EXPERIMENT_GIT_BASE: "0".repeat(40) })).rejects.toThrow(
    "HEAD does not match",
  );
  await writeFile(path.join(source, "pending.txt"), "pending");
  await expect(initialize()).rejects.toThrow("clean source clone");
  await git("add", "pending.txt");
  await git("commit", "--quiet", "-m", "Prepare source");
  env.CODE_EXPERIMENT_GIT_BASE = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(source, ".env.local"), "EXAMPLE=not-a-secret\n");
  await expect(initialize()).rejects.toThrow("credential/environment files");
  await rm(path.join(source, ".env.local"));
  await initialize();
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ project: "sample" });
  expect((await git("status", "--porcelain")).stdout).toBe("");
});
