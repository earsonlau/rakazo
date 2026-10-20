import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type {
  AdapterContext,
  CodeExperimentProvider,
  CodeExperimentRequest,
} from "@rakazo/adapter-kit";
import type { CodeExperimentConnection } from "./code-experiment-tools.js";
import { parseCodeExperimentRequest } from "./code-experiment-tools.js";

/** The v0.1.7 SDK contract. main has incompatible mount/commit signatures. */
export interface LayerFSExperimentClient {
  service(): Promise<string>;
  project: { list_branches(size: number, offset: number): Promise<unknown> };
  fs: {
    read(ref: string, file: string, start?: number, end?: number): Promise<unknown>;
    write(branch: string, file: string, content: string, message?: string): Promise<unknown>;
  };
  branch: {
    fork(name: string, from?: string): Promise<unknown>;
    merge(left: string, right: string, name: string, message?: string): Promise<unknown>;
    list_commits(ref: string, size: number, offset: number): Promise<unknown>;
    diff_branches(left: string, right: string, size: number, offset: number): Promise<unknown>;
  };
  sandbox: {
    create(): Promise<string>;
    mount(id: string, branch: string): Promise<{ path: string }>;
    exec(
      id: string,
      workspace: string,
      command: string,
      message?: string,
    ): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>;
    commit(id: string, workspace: string, options: { message?: string }): Promise<{ kind: string }>;
    unmount(id: string, workspace: string): Promise<unknown>;
    close(id: string): Promise<unknown>;
  };
}

type Options = {
  spaceId: string;
  userId: string;
  project: string;
  gitBase: string;
  stateDir: string;
  client: () => Promise<LayerFSExperimentClient>;
};

export const CODE_EXPERIMENT_PATCH_MAX_BYTES = 250_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class LayerFSCodeExperimentProvider implements CodeExperimentProvider {
  private serviceReady?: Promise<void>;
  constructor(private readonly options: Options) {
    if (!/^[a-f0-9]{40}$/.test(options.gitBase))
      throw new Error("A full Git base commit is required");
  }

  async execute(
    input: CodeExperimentRequest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    if (
      context.spaceId !== this.options.spaceId ||
      context.userId !== this.options.userId ||
      !context.botId
    ) {
      throw new Error("Code experiments are not connected for this owner and space");
    }
    context.signal.throwIfAborted();
    const request = parseCodeExperimentRequest(input as unknown as Record<string, unknown>);
    const client = await this.options.client();
    context.signal.throwIfAborted();
    const directory = path.join(
      this.options.stateDir,
      sha(JSON.stringify([this.options.spaceId, this.options.userId, this.options.project])),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.serviceReady ??= this.projectMutation(directory, context, "service", async () => {
      await client.service();
    });
    await this.serviceReady;
    if (request.action === "list")
      return { branches: await client.project.list_branches(50, request.offset ?? 0) };
    if (request.action === "read") {
      return {
        file: await client.fs.read(request.ref, request.path, request.startLine, request.endLine),
      };
    }
    if (request.action === "history") {
      return { history: await client.branch.list_commits(request.ref, 50, request.offset ?? 0) };
    }
    if (request.action === "diff") {
      return {
        diff: await client.branch.diff_branches(
          request.left,
          request.right,
          50,
          request.offset ?? 0,
        ),
      };
    }

    const branch = `bot-${sha(context.botId).slice(0, 16)}-${request.experiment}`;
    // Shared API/worker storage makes this lock cross-process. Never expire an uncertain operation.
    const lockPath = path.join(directory, `${branch}.json`);
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          error: "Experiment is busy or needs operator recovery. Do not retry blindly.",
          ref: branch,
        };
      }
      throw error;
    }
    const recovery = { ref: branch, operation: context.operationId, sandbox: "", workspace: "" };
    const saveRecovery = async () => {
      await lock.truncate(0);
      await lock.write(JSON.stringify(recovery), 0, "utf8");
      await lock.sync();
    };
    let completed = false;
    try {
      await saveRecovery();
      context.signal.throwIfAborted();
      if (request.action === "fork") {
        const result = await client.branch.fork(branch, request.from ?? "main");
        completed = true;
        return { ref: branch, result };
      }
      if (request.action === "merge") {
        const result = await client.branch.merge(
          request.left,
          request.right,
          branch,
          "Merge experiments",
        );
        completed = true;
        return { ref: branch, result };
      }
      if (request.action === "write") {
        const checkpoint = await client.fs.write(
          branch,
          request.path,
          request.content,
          request.message,
        );
        completed = true;
        return { ref: branch, checkpoint };
      }

      recovery.sandbox = await this.projectMutation(directory, context, "create", () =>
        client.sandbox.create(),
      );
      await saveRecovery();
      const mounted = await client.sandbox.mount(recovery.sandbox, branch);
      if (!mounted || typeof mounted.path !== "string" || !mounted.path.startsWith("/")) {
        throw new Error("Unsupported LayerFS SDK: expected v0.1.7 Workspace description");
      }
      recovery.workspace = mounted.path;
      await saveRecovery();
      context.signal.throwIfAborted();
      let execution: Awaited<ReturnType<LayerFSExperimentClient["sandbox"]["exec"]>> | undefined;
      if (request.action === "run" || request.action === "export") {
        const command =
          request.action === "run" ? request.command : exportCommand(this.options.gitBase);
        execution = await client.sandbox.exec(
          recovery.sandbox,
          recovery.workspace,
          `timeout --signal=TERM --kill-after=5s 120s bash -c ${quote(command)}`,
          request.action === "run" ? request.message : "Export committed Git changes",
        );
        if (
          typeof execution.stdout !== "string" ||
          typeof execution.stderr !== "string" ||
          !Number.isInteger(execution.exitCode)
        ) {
          throw new Error("Unsupported LayerFS execution result");
        }
      }
      // Save nonzero test runs too. A thrown/uncertain exec keeps its mount for explicit recovery.
      const checkpoint = await client.sandbox.commit(recovery.sandbox, recovery.workspace, {
        message: "message" in request ? request.message : "Export Git patch",
      });
      if (!["Committed", "UpToDate"].includes(checkpoint.kind)) {
        throw new Error("LayerFS did not confirm a checkpoint");
      }
      await client.sandbox.unmount(recovery.sandbox, recovery.workspace);
      recovery.workspace = "";
      await saveRecovery();
      // Cleanup still runs after acknowledged exec cancellation; only admission to new work is aborted.
      await this.projectMutation(
        directory,
        { ...context, signal: AbortSignal.timeout(35_000) },
        "close",
        () => client.sandbox.close(recovery.sandbox),
      );
      recovery.sandbox = "";
      completed = true;
      if (request.action === "export") {
        if (execution!.exitCode !== 0)
          return { ref: branch, error: execution!.stderr, exitCode: execution!.exitCode };
        try {
          return {
            ref: branch,
            base: this.options.gitBase,
            patch: verifiedPatch(execution!.stdout),
          };
        } catch (error) {
          return {
            ref: branch,
            error: error instanceof Error ? error.message : "Invalid Git patch",
          };
        }
      }
      return { ref: branch, checkpoint, ...(execution ? { execution } : {}) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "LayerFS operation failed",
        uncertain: true,
        recovery: { ...recovery },
        notice:
          "No retry or forced cleanup was attempted. Ask the operator to inspect the saved operation.",
      };
    } finally {
      await lock.close();
      if (completed) await unlink(lockPath);
    }
  }

  private async projectMutation<T>(
    directory: string,
    context: AdapterContext,
    operation: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    // v0.1.7 discovery uses a nonblocking project lock. Queue BEFORE calling the SDK, never replay it.
    const filename = path.join(directory, "allocation.json");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(35_000)]);
    let lock: FileHandle;
    for (;;) {
      signal.throwIfAborted();
      try {
        lock = await open(filename, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(50, undefined, { signal });
      }
    }
    let acknowledged = false;
    try {
      await lock.writeFile(JSON.stringify({ operation, operationId: context.operationId }));
      await lock.sync();
      const value = await execute();
      acknowledged = true;
      return value;
    } finally {
      await lock.close();
      if (acknowledged) await unlink(filename);
    }
  }
}

function exportCommand(base: string): string {
  return `set -eu
test -z "$(git status --porcelain=v1 --untracked-files=normal)" || { echo 'Commit or remove pending Git changes before export' >&2; exit 2; }
git merge-base --is-ancestor ${base} HEAD || { echo 'Git HEAD must descend from the configured base' >&2; exit 2; }
patch=$(mktemp)
trap 'rm -f "$patch"' EXIT
git diff --no-color --src-prefix=a/ --dst-prefix=b/ --binary --full-index --no-ext-diff --no-textconv ${base} HEAD -- > "$patch"
test "$(wc -c < "$patch")" -le ${CODE_EXPERIMENT_PATCH_MAX_BYTES} || { echo 'Git patch exceeds export limit' >&2; exit 2; }
sha256sum "$patch" | cut -d ' ' -f 1
cat "$patch"`;
}

export function verifiedPatch(output: string): string {
  const newline = output.indexOf("\n");
  const digest = output.slice(0, newline);
  const patch = output.slice(newline + 1);
  if (
    newline !== 64 ||
    digest !== sha(patch) ||
    Buffer.byteLength(patch) > CODE_EXPERIMENT_PATCH_MAX_BYTES
  ) {
    throw new Error("Git patch output was truncated or failed its integrity check");
  }
  return patch;
}

export function createCodeExperimentConnection(
  dataDir: string,
  source: NodeJS.ProcessEnv = process.env,
): CodeExperimentConnection | null {
  // shortcut: one operator-bound project; add a registry before enabling multiple projects.
  const kind = source.CODE_EXPERIMENT_PROVIDER?.trim() || "none";
  if (kind === "none") return null;
  if (kind !== "layerfs") throw new Error("Unknown code experiment provider");
  const required = (key: string) => {
    const value = source[key]?.trim();
    if (!value) throw new Error(`Code experiments require ${key}`);
    return value;
  };
  const spaceId = required("CODE_EXPERIMENT_SPACE_ID");
  const userId = required("CODE_EXPERIMENT_USER_ID");
  const project = required("LAYERFS_PROJECT");
  const sdkPath = required("LAYERFS_SDK_MODULE");
  if (!path.isAbsolute(sdkPath))
    throw new Error("LAYERFS_SDK_MODULE must be an absolute local path");
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(project))
    throw new Error("Invalid LayerFS project name");
  let client: Promise<LayerFSExperimentClient> | undefined;
  return {
    spaceId,
    userId,
    provider: new LayerFSCodeExperimentProvider({
      spaceId,
      userId,
      project,
      gitBase: required("CODE_EXPERIMENT_GIT_BASE"),
      stateDir: path.join(dataDir, "code-experiments"),
      client: () => {
        // The unpublished SDK is loaded only when enabled; the module path is operator-owned.
        client ??= import(pathToFileURL(sdkPath).href).then(
          (module) => new module.LayerFS(project),
        );
        return client;
      },
    }),
  };
}
