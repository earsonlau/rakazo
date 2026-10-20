# Isolated code experiments (experimental)

Git owns final code delivery. An optional filesystem provider owns temporary
experiment branches and file checkpoints. The first adapter targets **LayerFS
v0.1.7**, source commit `e7713d034b029c358c657959b7737e8d23c9d1e7`.
It does not require or create Git worktrees.

This is an experimental integration, not a production-ready sandbox. Offline
adapter tests and a real Docker/native LayerFS smoke test passed for a small
fixture: independent same-file edits, overlapping test processes, checkpoint
forking and Git patch delivery. This is not full-product or model qualification.
Upstream 1.0 is unreleased, its main branch is incompatible
with this adapter, and v0.1.7 excludes daemon/container restart recovery and
durability qualification. Do not use it as the only copy of valuable work.

## Execution model

```text
Prepared, sanitized Git clone
        |
        +-- explicit operator import --> LayerFS project main (unchanged by bots)
                                               |
                      +------------------------+-----------------------+
                      |                                                |
               bot A / experiment                           bot B / experiment
               private file overlay                         private file overlay
               edit -> test -> checkpoint                   edit -> test -> checkpoint
                      |                                                |
                      +--> compare / fork a checkpoint / merge <--------+
                                               |
                                    choose a winning experiment
                                               |
                                     Git add + Git commit
                                               |
                                 export a checked, binary-capable patch
                                               |
                                     ordinary bot computer
                                               |
                              human review -> Git apply -> commit / PR
```

Each bot's experiment name maps to a distinct LayerFS branch. Other bots can read
that branch or fork from its returned ref; they cannot address it as their own
write target through this tool. A same-bot helper must use its own experiment
name. An atomic lock on shared Rakazo storage rejects concurrent mutations of the
same experiment across API/worker processes. Different experiments can proceed
concurrently. The v0.1.7 SDK also has a nonblocking project discovery lock, so
service startup, Sandbox creation and Sandbox closing are admitted through a
second shared lock. Only these lifecycle calls are queued; test commands still
run concurrently. Waiting for admission does not retry an SDK operation. This is
coordination, not protection against hostile code.

Each `run` creates a LayerFS Sandbox, mounts the experiment, runs a bounded command,
checkpoints acknowledged results (including nonzero test exits), unmounts and
closes it. `write` creates a checkpoint directly. No checkpoint calls Git commit.
No tool publishes LayerFS `main`, updates the original clone, applies patches,
pushes a remote or creates a PR automatically.

## Operator setup

This first version binds **one prepared project to one owner in one Space**.
It is not a self-service multi-tenant project registry. All bots executing for
that owner in that Space may inspect that project. Other owners and Spaces do
not receive the tool and are rejected by the adapter if they call it directly.
Messaging-channel runs do not receive it. Existing approval rules and disabled
built-in tools also apply.

1. Use a dedicated Linux deployment with a local Docker Engine. Build the SDK
   native addon, Linux daemon and runtime image from the **same v0.1.7 source**.
   Follow the [pinned SDK setup](https://github.com/Ephemeral-AI-Lab/layerfs/blob/e7713d034b029c358c657959b7737e8d23c9d1e7/sdk/js/README.md#builds-and-compatibility).
   Do not install a similarly named npm package: this release is source-only.
   The runtime image must contain Bash, Git and GNU coreutils (`timeout`,
   `mktemp`, `sha256sum`, `cut`, `cat`, `wc`).
2. Prepare a standalone, clean Git clone at the desired base commit. Review its
   **entire tree and history**, not just Git-tracked files. LayerFS imports
   ignored files and dependencies too. Do not include production data, API keys,
   `.env` files, credential stores, or symlinks to private data. Prefer a disposable
   clone without credentials or credential-helper configuration.
3. Configure the same values for the API, worker and initialization process:

   ```dotenv
   CODE_EXPERIMENT_PROVIDER=layerfs
   CODE_EXPERIMENT_SPACE_ID=<authorized-space-id>
   CODE_EXPERIMENT_USER_ID=<authorized-owner-id>
   CODE_EXPERIMENT_GIT_BASE=<full-40-character-source-HEAD>
   LAYERFS_PROJECT=code-lab
   LAYERFS_SDK_MODULE=/opt/layerfs/sdk/js/src/index.js
   LAYERFS_HOME=/srv/layerfs-home
   LAYERFS_DOCKER=/var/run/docker.sock
   LAYERFS_IMAGE=sha256:<built-runtime-image-digest>
   LAYERFS_VOLUME=<dedicated-existing-volume>
   LAYERFS_DAEMON=/opt/layerfs/core/target/cluster2-linux/release/layerfs-daemon
   ```

   Build the native addon on the host that loads it. API and worker need the same
   SDK, discovery home, Engine access, volume, and shared `DATA_DIR/code-experiments`
   directory. Use a dedicated volume per project. Do not bind the same project to
   different owners. The standard Rakazo computer image and Compose configuration
   do **not** build or mount this SDK or grant the API/worker Engine access; provision
   these explicitly in a dedicated environment. Docker Engine access is a powerful
   host privilege, not a new permission to grant to untrusted deployments.
4. With that environment loaded, initialize once, before starting agent work:

   ```sh
   node scripts/init-code-experiments.mjs /srv/prepared-source
   ```

   The script verifies the source Git HEAD, a clean working tree, a standalone
   `.git` directory and common top-level credential files. It is **not a secret
   scanner**. The operator must review nested files, ignored content and history.
   It never retries initialization. Do not reinitialize a live project.
5. Restart the API and worker. The tool is shared backend behavior, so web,
   Electron and mobile chats use the same workflow without a platform-specific UI.
   Set `CODE_EXPERIMENT_PROVIDER=none` to stop offering it; this does not delete
   checkpoints or stop an already executing command.

## Agent workflow

Ask two bots in the same authorized Space to try distinct fixes, explicitly using
`code_experiment` rather than the ordinary `shell` and file tools. The latter
still operate on the Team/Private Computer and are **not redirected** into LayerFS.
This feature does not automatically spawn bots or choose a winning implementation.

Example calls (JSON tool arguments):

```json
{"action":"fork","experiment":"cache-fix"}
{"action":"read","ref":"<returned-branch-ref>","path":"/src/cache.ts"}
{"action":"write","experiment":"cache-fix","path":"/src/cache.ts","content":"<replacement source>","message":"Try cache invalidation fix"}
{"action":"run","experiment":"cache-fix","command":"npm test","message":"Test cache fix"}
{"action":"history","ref":"<returned-branch-ref>"}
{"action":"diff","left":"main","right":"<returned-branch-ref>"}
{"action":"fork","experiment":"retry","from":"<checkpoint-id>"}
{"action":"merge","experiment":"combined","left":"<bot-A-branch>","right":"<bot-B-branch>"}
```

`list`, `history` and `diff` return SDK pages of at most 50 entries. When `hasMore`
is true, advance `offset` by the returned `items.length`. Reads accept `startLine`
and `endLine`; preserve the SDK's truncation/next-line information. `checkpoint`
with an experiment name explicitly saves a mounted workspace without executing
a command. An unchanged workspace may return `UpToDate` rather than a new Commit.
Use `fork` from a checkpoint for non-destructive rewind; there is no forced reset.

LayerFS merges can conflict, including on Git metadata if agents committed Git
changes in both branches. Prefer merging experimental file changes **before**
making Git commits. Conflicts and uncertain operations stop; they are not forced.

After choosing a winner, commit only the intended delivery files **inside that
experiment**, using an explicitly configured non-production Git identity:

```json
{"action":"run","experiment":"cache-fix","command":"git add -- src/cache.ts && git -c user.name='Code Agent' -c user.email='agent@example.invalid' commit -m 'Fix cache invalidation'"}
{"action":"export","experiment":"cache-fix"}
```

Export requires a clean Git working tree and HEAD descended from the configured
base. It returns the path of a new `.patch` file in the bot's ordinary computer
folder (`experiments/...patch`). It includes the net committed Git diff, not
ignored dependencies, experiment checkpoints, commit authorship or commit history.
Binary changes are supported; patches are capped at 250,000 bytes and checked
against a SHA-256 digest to reject truncated command output. Use `attach_file`
on the returned path to share it. Empty net changes produce an empty patch.

In a separate delivery clone at the recorded base, review the patch, then use
`git apply --check`, `git apply`, tests, Git commit and the normal PR workflow.
Do not apply a patch to a dirty checkout or automatically push it. Committing
inside an experiment is not itself delivery to the original repository.

## Failure handling and boundaries

- Each command is wrapped in a 120-second GNU `timeout`, with a five-second kill
  grace period. The public v0.1.7 SDK has no cancellation API: stopping a Rakazo
  run does not immediately cancel that native call. An acknowledged result is
  checkpointed and cleaned up before returning. Do not run background servers or
  deliberately escape the timeout; this is a trusted-workload adapter.
- Checkpoints capture project files only. They do not capture RAM, running
  processes, OS packages outside the mounted project, external databases, network
  requests or browser actions. No Rakazo model credentials or command-secret
  environment is injected into these sandboxes. Commands can still access whatever
  the operator put in the source or runtime image.
- An exec/commit/teardown error preserves the workspace when known and keeps a
  journal/lock under `DATA_DIR/code-experiments/<binding-hash>/`. The tool returns
  the branch ref and known Sandbox/mount handles. A subsequent mutation of that
  experiment is refused. Other experiments may continue.
- `allocation.json` records an active or uncertain project lifecycle operation.
  Its admission wait is bounded at 35 seconds; it is never expired or stolen.
  An uncertain create/close blocks new allocations until the operator has
  inspected both this journal and LayerFS discovery records. Existing file reads
  may still work through an already connected service.
- An operator must inspect that journal with the same pinned SDK and deployment.
  If a workspace remains mounted, inspect its `sandbox.status`, read or fix it
  with `sandbox.exec`, then explicitly commit (without force), unmount and close.
  For conflicts, inspect markers before any resolution. On uncertain create,
  mount, commit or close, inspect discovery/state first; never repeat the operation
  just because no response arrived. Remove the exact lock file only after the
  outcome and cleanup are confirmed. There is no automatic stale-lock expiry,
  retry, discard, restart recovery or destructive reset.
- Filesystem views, bot-prefixed names and locks are not security boundaries.
  Sandboxes share a project Store. Use a dedicated deployment for mutually trusted
  experiments; use stronger compute and storage isolation for hostile agents.
- LayerFS's own checkpoints are not Git commits, backups or a guarantee of crash
  durability. Keep the original Git repository and delivery artifacts separately.

## Verification

Run the targeted offline adapter tests, tool-permission test and normal checks:

```sh
pnpm exec vitest run packages/adapters/src/code-experiment-tools.test.ts packages/adapters/src/layerfs-code-experiments.test.ts packages/adapters/src/executor.test.ts
pnpm check
pnpm lint
```

Adapter tests use an explicit SDK double; the delivery test uses real Git and
Bash, and skips when Bash is unavailable. These tests do not establish native
LayerFS isolation, storage durability, FUSE compatibility or multi-agent throughput.
Before using valuable projects, run a disposable Linux smoke: fork two bot
experiments, change the same file differently, run both tests, read both refs and
`main`, fork a checkpoint, export one winner and apply it to a fresh Git clone.

### Reproduce the native Docker proof

Use Node 22.22+ and a local Docker Engine in Linux-container mode. This proof
builds the real Rust daemon and Node native addon; it does not use the offline
SDK double. It runs two deterministic bot contexts through the production Rakazo
adapter, not two autonomous LLM sessions and not the API/database/UI stack.

Acquire only the pinned compilation inputs (the full upstream archive contains
many unrelated reports). On Windows, the per-command `core.protectNTFS=false`
allows the sparse index to contain upstream POSIX-only document names; those
documents are not checked out. It does not change global Git configuration.

```sh
git -c core.protectNTFS=false clone --filter=blob:none --no-checkout --depth 1 --branch v0.1.7 https://github.com/Ephemeral-AI-Lab/layerfs.git .tmp/layerfs-v017
git -c core.protectNTFS=false -C .tmp/layerfs-v017 sparse-checkout set --no-cone /.cargo/ /core/Cargo.toml /core/Cargo.lock /core/crates/ /core/vendor/ /sdk/js/
git -c core.protectNTFS=false -C .tmp/layerfs-v017 checkout --detach e7713d034b029c358c657959b7737e8d23c9d1e7
node scripts/run-layerfs-native-smoke.mjs .tmp/layerfs-v017
```

Use PowerShell rather than Git Bash on Windows, which can rewrite the sparse
patterns beginning with `/`. The launcher checks the source revision and tracked
build inputs before building. Its Docker build context excludes the upstream
reports, working targets and `.git` directory.

The launcher builds `infra/experiments/layerfs/Dockerfile` and creates a dedicated
**privileged Docker-in-Docker Engine** to support real FUSE mounts. It does not
mount the host Engine socket, personal directories or credentials and does not
publish ports. A separate unprivileged runner shares only that Engine's network
and socket volume, the explicitly staged adapter modules, and the output folder.
This is a trusted local smoke environment, not a security boundary for hostile
code. Do not run it on an untrusted shared Docker host.

The fixture starts with a broken `clamp` function. Candidate A fixes only the
lower bound; B fixes both bounds. Both modify `/clamp.mjs` in separate LayerFS
branches and run the same tests. The proof asserts that their actual test process
intervals overlap, A fails, B passes, and `main` plus the original source remain
unchanged. It then makes a Git commit in B, exports a digest-checked patch and
checks/applies it in an independent clone where the tests must pass again.

Each invocation has a fresh run directory under `.tmp/layerfs-native/runs/`:

- `output/report.json`: checks, native binary hashes, test output and execution intervals;
- `output/winner.patch`: the winning net Git diff;
- `resources.json`: exact names of this run's containers and volumes;
- `bundle/`: the exact staged adapter JavaScript used by the runner.

The launcher stops its runner and nested Engine in `finally`. It retains their
containers and data volumes, especially on failure, and never prunes other Docker
resources. Do not restart a failed LayerFS project and replay the same operation;
inspect its discovery records and journals. A new launcher invocation creates a
new environment instead of reusing an uncertain project.

The first successful proof on Linux/AMD64 with Docker Desktop passed 18 native
assertions. Earlier setup attempts exposed the DinD private `/tmp` mount and
Docker Desktop OCI index versus nested Engine image-ID differences; both are
handled by the launcher. A real parallel run exposed discovery `Busy` on concurrent
creation; the adapter now coordinates lifecycle mutations and has offline
regression tests that require test execution to remain parallel. Failed attempt
reports are retained, not relabeled as passes. This result is not a throughput,
durability, restart-recovery or autonomous-agent benchmark.
