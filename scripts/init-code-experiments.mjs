import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Explicit operator action only. Agent runs must never reacquire a live project's source.
const source = process.argv[2];
const project = process.env.LAYERFS_PROJECT;
const modulePath = process.env.LAYERFS_SDK_MODULE;
const base = process.env.CODE_EXPERIMENT_GIT_BASE;
if (
  !source ||
  !project ||
  !modulePath ||
  !path.isAbsolute(modulePath) ||
  !/^[a-f0-9]{40}$/.test(base ?? "")
) {
  throw new Error(
    "Provide a source directory, LAYERFS_PROJECT, absolute LAYERFS_SDK_MODULE, and full CODE_EXPERIMENT_GIT_BASE. Load the deployment environment before running this script.",
  );
}
const directory = await realpath(source);
const gitDirectory = await lstat(path.join(directory, ".git"));
if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
  throw new Error("Use a standalone Git clone, not a linked worktree or an external Git directory");
}
const run = promisify(execFile);
const git = (...args) => run("git", args, { cwd: directory });
const head = (await git("rev-parse", "HEAD")).stdout.trim();
if (head !== base) throw new Error("Source HEAD does not match CODE_EXPERIMENT_GIT_BASE");
if ((await git("status", "--porcelain=v1", "--untracked-files=normal")).stdout.trim()) {
  throw new Error("Prepare a clean source clone before importing it");
}
const names = await readdir(directory);
if (
  names.some(
    (name) =>
      name === ".ssh" ||
      name === ".aws" ||
      name === ".gnupg" ||
      (name.startsWith(".env") && !name.endsWith(".example") && !name.endsWith(".sample")),
  )
) {
  throw new Error(
    "Remove local credential/environment files before import. Review nested and ignored files too: the whole project tree is imported.",
  );
}
const { LayerFS } = await import(pathToFileURL(modulePath).href);
const client = new LayerFS(project);
await client.project.init(directory);
process.stdout.write(
  "Experiment project initialized. Source files and Git history were imported; no Git remote was changed.\n",
);
