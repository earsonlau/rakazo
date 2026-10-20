import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Pass the clean, sparse-checkout LayerFS v0.1.7 source directory");
const revision = "e7713d034b029c358c657959b7737e8d23c9d1e7";
const git = (...args) =>
  execFileSync("git", ["-c", "core.protectNTFS=false", "-C", source, ...args], {
    encoding: "utf8",
  });
assert.equal(git("rev-parse", "HEAD").trim(), revision, "Use the exact pinned upstream source");
git(
  "diff",
  "HEAD",
  "--exit-code",
  "--",
  "core/crates",
  "core/vendor",
  "core/Cargo.toml",
  "core/Cargo.lock",
  "sdk/js",
  ".cargo",
);
const directory = path.join(repository, ".tmp", "layerfs-native", "runs");
await mkdir(directory, { recursive: true });
const work = await mkdtemp(path.join(directory, "smoke-"));
const bundle = path.join(work, "bundle");
const output = path.join(work, "output");
await mkdir(path.join(bundle, "production"), { recursive: true });
await mkdir(output);
for (const name of ["code-experiment-tools", "layerfs-code-experiments"]) {
  const code = await readFile(
    path.join(repository, "packages", "adapters", "src", `${name}.ts`),
    "utf8",
  );
  await writeFile(
    path.join(bundle, "production", `${name}.js`),
    stripTypeScriptTypes(code, { mode: "transform" }),
  );
}
await writeFile(path.join(bundle, "production", "package.json"), '{"type":"module"}\n');
await writeFile(
  path.join(bundle, "layerfs-native-smoke.mjs"),
  await readFile(path.join(repository, "scripts", "layerfs-native-smoke.mjs")),
);
const suffix = path.basename(work).toLowerCase();
const resources = {
  engine: `rakazo-layerfs-engine-${suffix}`,
  runner: `rakazo-layerfs-runner-${suffix}`,
  socketVolume: `rakazo-layerfs-socket-${suffix}`,
  dataVolume: `rakazo-layerfs-data-${suffix}`,
  runtimeTag: "rakazo-layerfs-native:v0.1.7",
  output,
};
await writeFile(path.join(work, "resources.json"), `${JSON.stringify(resources, null, 2)}\n`);
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    cwd: repository,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
let engineStarted = false;
let runnerCreated = false;
try {
  docker(
    [
      "build",
      "--progress",
      "plain",
      "-f",
      "infra/experiments/layerfs/Dockerfile",
      "-t",
      resources.runtimeTag,
      source,
    ],
    { stdio: "inherit", timeout: 1_200_000 },
  );
  const image = docker(["image", "inspect", resources.runtimeTag, "--format", "{{.Id}}"]).trim();
  docker([
    "volume",
    "create",
    "--label",
    "io.rakazo.purpose=layerfs-native-smoke",
    resources.socketVolume,
  ]);
  docker([
    "volume",
    "create",
    "--label",
    "io.rakazo.purpose=layerfs-native-smoke",
    resources.dataVolume,
  ]);
  // Dedicated nested Engine: no host Engine socket, user home, credentials, or published ports.
  docker([
    "run",
    "-d",
    "--name",
    resources.engine,
    "--privileged",
    "--cpus",
    "3",
    "--memory",
    "3g",
    "--pids-limit",
    "4096",
    "--label",
    "io.rakazo.purpose=layerfs-native-smoke",
    "-e",
    "DOCKER_TLS_CERTDIR=",
    "--mount",
    `type=volume,source=${resources.socketVolume},target=/var/run`,
    "--mount",
    `type=volume,source=${resources.dataVolume},target=/var/lib/docker`,
    "docker:29.4.0-dind",
    "dockerd",
    "--host=unix:///var/run/docker.sock",
    "--storage-driver=overlay2",
  ]);
  engineStarted = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      docker(["exec", resources.engine, "docker", "info", "--format", "{{.ServerVersion}}"], {
        timeout: 2000,
        stdio: "ignore",
      });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert.ok(ready, "The dedicated Docker Engine did not become ready");
  const archive = path.join(work, "runtime.tar");
  docker(["save", "--output", archive, resources.runtimeTag]);
  // DinD mounts /tmp inside its own namespace; docker cp cannot see that private mount.
  docker(["cp", archive, `${resources.engine}:/runtime.tar`]);
  docker(["exec", resources.engine, "docker", "load", "--input", "/runtime.tar"], {
    stdio: "inherit",
  });
  await unlink(archive);
  docker(["exec", resources.engine, "rm", "/runtime.tar"]);
  // Docker Desktop's containerd store can return an OCI index ID, unlike the nested Engine.
  const sandboxImage = docker([
    "exec",
    resources.engine,
    "docker",
    "image",
    "inspect",
    resources.runtimeTag,
    "--format",
    "{{.Id}}",
  ]).trim();
  docker(["exec", resources.engine, "docker", "volume", "create", "smoke-store"]);
  docker([
    "create",
    "--name",
    resources.runner,
    "--network",
    `container:${resources.engine}`,
    "--cpus",
    "2",
    "--memory",
    "1g",
    "--label",
    "io.rakazo.purpose=layerfs-native-smoke",
    "--mount",
    `type=volume,source=${resources.socketVolume},target=/var/run`,
    "--mount",
    `type=bind,source=${bundle},target=/smoke,readonly`,
    "--mount",
    `type=bind,source=${output},target=/out`,
    "-e",
    `LAYERFS_IMAGE=${sandboxImage}`,
    "-e",
    "LAYERFS_VOLUME=smoke-store",
    image,
  ]);
  runnerCreated = true;
  docker(["start", "--attach", resources.runner], { stdio: "inherit", timeout: 600_000 });
  assert.equal(
    docker(["inspect", resources.runner, "--format", "{{.State.ExitCode}}"]).trim(),
    "0",
    "Native runner failed; inspect report.json",
  );
  const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  assert.equal(report.passed, true, "Native proof did not pass");
  process.stdout.write(`Native proof passed. Patch and report: ${output}\n`);
} catch (error) {
  process.stderr.write(`Native proof stopped. State retained under ${work}\n`);
  throw error;
} finally {
  // Stop compute, retain this run's containers and volumes for diagnosis. No prune/reset.
  try {
    if (runnerCreated)
      docker(["stop", "--timeout", "10", resources.runner], { stdio: "ignore", timeout: 30_000 });
  } finally {
    if (engineStarted)
      docker(["stop", "--timeout", "10", resources.engine], { stdio: "ignore", timeout: 30_000 });
  }
}
