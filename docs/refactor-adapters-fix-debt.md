# 适配层补丁债：三处可测试的收敛切片

这份文档只建议，不改运行时。公开文档导航是白名单（`apps/www/src/docs.ts` 的 `DOCS_SLUGS`）。不要把本文件加进 `DOCS_NAV`。

核对对象是上游 `elie222/rakazo` 的 `main` `e4e7637bb`（含已合并的 #2821、#2829）。本 fork `earsonlau/rakazo` 的 `main` `e5bf98345` 是该历史的祖先，落后 95 个提交。下面标出的 `underRunLease` 在上游树上，不在本 fork 的 `main` 上。PR 正文与符号都以那次核对为准。

先说结论。跟进 PR 反复出现，是因为同一条规则写在多个可选检查里：没走到的那条路径就再开一个 PR。窗口里几乎没有「修坏了再 revert」——标题含 revert 的合并只有 [#326](https://github.com/elie222/rakazo/pull/326)，撤回的是误合并。下面只保留正文对得上、代码还在的链。14 天内同一 scope 多条 fix 只算共现，不当作因果。

## English

- Recommendation only. Do not add this file to `DOCS_SLUGS` / `DOCS_NAV`.
- Verified on upstream `elie222/rakazo` `main` `e4e7637bb`. This fork's `main` `e5bf98345` is an ancestor, 95 commits behind. `underRunLease` exists on that upstream tree and not on this fork's `main`.
- Follow-ups keep landing because the rule is optional at each call site. Revert-after-fix is not the pattern (#326 reverts an accidental merge).
- Each area below has one first PR: a pure function, two tests, no new harness, no production race.

## 哪些链成立

| 链 | 核对后 |
| --- | --- |
| [#799](https://github.com/elie222/rakazo/pull/799) → [#812](https://github.com/elie222/rakazo/pull/812) | 成立。#812 正文写明两处 Greptile P1 作为 follow-up 合并。代码在 `apps/mobile/lib/api.ts`，不是 adapters。不要并进 lease PR。 |
| [#743](https://github.com/elie222/rakazo/pull/743) | 成立，而且快照已经是对的形状。`stopThreadRuns` 在取消事务里读取 lease。不要再加一层事务后查找。 |
| [#1732](https://github.com/elie222/rakazo/pull/1732) → [#1787](https://github.com/elie222/rakazo/pull/1787) | 成立。#1787 开头即 After #1732。shim 仍是 `injectNovncStorageShim` 一个函数。 |
| [#2517](https://github.com/elie222/rakazo/pull/2517) → [#2694](https://github.com/elie222/rakazo/pull/2694) → [#2817](https://github.com/elie222/rakazo/pull/2817) → [#2821](https://github.com/elie222/rakazo/pull/2821) | 成立。停机改为过期 tombstone；崩溃窗口改为 reclaim；聊天写挡住之后，旁路事务和外部工具又各补一刀。 |
| [#2335](https://github.com/elie222/rakazo/pull/2335) → [#2488](https://github.com/elie222/rakazo/pull/2488) | 成立。同一类「生产里还在被当成服务器错误」分两次打在不同正则上。 |

[#2829](https://github.com/elie222/rakazo/pull/2829) 扫的是机器上的 background marker（`packages/adapters/src/computer-idle.ts` 的 `BACKGROUND_WORK_PROBE`），不是 run fence。不要塞进 lease 切片。

## English

- #799 → #812 is real and mobile-only. Leave it out of the lease PR.
- #743's in-transaction snapshot is the shape to keep.
- #1732 → #1787 thickened one function, `injectNovncStorageShim`.
- #2517 → #2694 → #2817 → #2821 is the lease onion: tombstone, reclaim, then each writer that skipped the check.
- #2335 → #2488 patched two classifiers separately.
- #2829 is a different protocol. Out of scope.

## 照着做的反例

- [#693](https://github.com/elie222/rakazo/pull/693)：打开句柄再校验路径（`packages/adapters/src/file-handle-path.ts`、`home.ts`），用确定性测试锁住，而不是再包一层检测。
- [#2112](https://github.com/elie222/rakazo/pull/2112)：删掉「参数不对就去 desktop 乱点」的 fallback（`packages/adapters/src/browser-tools.ts`）。
- [#1410](https://github.com/elie222/rakazo/pull/1410)：根因在已有的 Postgres 路径上验证（`packages/db/src/steering-replay.postgres.test.ts`）。下面的第一刀不新造这种竞态；lease 只复跑已经存在的那条 Postgres 测试。

## English

- Copy #693: check the real boundary once, and lock it with a deterministic test.
- Copy #2112: delete the bad path instead of wrapping it.
- Copy #1410 only by re-running a Postgres test that already exists. Do not add a new race to validate these slices.

---

## 1. Run lease 与 computer fence

### 中文

**1. 现状**

有两套 fence，不能合成一个计数器。

Run 尝试的所有权在 `Run.leaseOwner` / `leaseFence` / `leaseExpiresAt`（`packages/db/prisma/schema.prisma` 的 `model Run`）。类型是 `packages/db/src/messages.ts` 的 `RunLease`。写历史的判断在 `assertRunCanWriteHistory`：有 lease 时先 `FOR SHARE`，然后比 fence；`leaseOwner === null` 但 fence 相同仍允许写（暂停或结束会清掉 owner、留下 fence）。调用点：

- `packages/db/src/events.ts` 的 `appendEventInTransaction` 把 `input.lease` 传进去。`run.cancelled` 走 `assertRunIsCancelled`，不走这条。
- `packages/adapters/src/run-messages.ts` 的 `withRunLease` 给这一次 attempt 的 `events.append` 带上 lease。`executor.ts` 在领到 fence 之后调用它。`runLeaseFor` 按 runId 取回。
- 上游上的 `packages/adapters/src/run-effects.ts`：`underRunLease` 在同一事务里调用 `assertRunCanWriteHistory`。`recordEffect` 创建 `externalEffect`、`claimEffect` 认领时都走它（#2821）。没有 `deps.runLease` 时它直接写，不检查。
- 另一套合法写门是 compare-and-swap：`where` 里同时带 `leaseOwner` 和 `leaseFence`。`packages/db/src/run-turn-checkpoint.ts` 的 `saveRunTurnCheckpoint`、`packages/adapters/src/run-lifecycle.ts` 的 `renewRunLease` / `finalize` 路径，以及 `events.ts` 的 `finalizeRunOnce` 都是这样。`finalizeRunOnce` 调用 `assertRunCanWriteHistory` 时不传 lease，真正的围栏是后面的 `updateMany`。
- 读检查是另一条规则。`mayOpenModelStream` 要求 status 为 running、owner 等于自己、fence 相等、且未 abort。这比历史写更严，不能并成同一个布尔。

Computer 屏幕的 fence 在 `model ComputerExecutionLease`（`@@unique([computerId, botId])`）。`packages/db/src/computers.ts` 的 `expireComputerExecutionLeases` 把 `expiresAt` 写成 epoch，行留着，下次 `acquireComputerExecutionLease` / `acquireDedicatedScreenLeaseFence`（`packages/adapters/src/computer-lifecycle.ts`）才会 `fence + 1`。`releaseComputerExecutionLease` 的注释写明：删行会把下一任 fence 重置成 1，旧屏幕会话会拒绝新主人（#2517）。#2694 让同一 run 的当前 owner 在 takeover 没提交时也能 reclaim，并递增 fence。

取消拆机已经在事务内快照。`apps/api/src/thread-target.ts` 的 `stopThreadRuns`（#743）先把 run 标成 cancelled，同一事务读出 `computerExecutionLease` 和遗留的 `Computer.executionRunId`，提交后再按快照拆。`packages/db/src/groups.ts` 的 `snapshotRunTeardownTargets` 是同一套规则的另一份拷贝。当前生产代码里搜不到给 `executionRunId` 赋非空值的写入，只有清成 null。`destroyBot`（`packages/adapters/src/child-bots.ts`）在删 bot 时 `computerExecutionLease.deleteMany`：这一对 `(computerId, botId)` 会随 bot 消失，不是停机路径，不要改成 expire 来「统一」。

#2817 写明故意不围栏的路径：`packages/adapters/src/media-generation-tools.ts` 用 effect 行的状态做一次认领，`run-tools-files.ts` 的 `publish` 在同一事务里 `updateMany` effect 再 `persistMessageInTransaction`。按 attempt fence 去挡，会丢掉 run 恢复之后才落地的结果。

**2. 为什么还在长**

`lease` 是可选参数。`underRunLease` 在 `runLeaseFor` 为空时跳过检查。#2817 的正文：上一刀挡住了被取代的 worker 发答案，旁路事务仍能改接管卡、给别的 bot 发消息。#2821：聊天写挡住了，connector / send 仍能跑出去。每发现一个自己开事务的写点，就在那个写点上再接一次 lease。Computer 侧则是删行、过期、长租约、reclaim 各一轮。

**3. 目标**

历史写的允许与拒绝收成一个纯函数。`assertRunCanWriteHistory` 只负责锁和读行，然后调用它。`underRunLease`、`appendEventInTransaction` 继续作为唯一的事务入口，不要再长出第三个 helper。Computer fence 仍由 `expireComputerExecutionLeases` 结束活着的 `(computer, bot)` 行。两套数字不要加在一起：`acquireDedicatedScreenLeaseFence` 已经单独用 `runFence` 算出自己的 fence。

**4. 不要做**

- 不要在工具真正执行前再加一个事务外的预检查。那就是 #2817 到 #2821 的叠法。
- 不要在停机或切换电脑时 `computerExecutionLease.delete`。`apps/api/src/routes/computer.ts` 和 `routes/bots.ts` 已经走 expire。
- 不要在这一刀里把「没带 lease 就拒绝」变成默认。媒体完成那条路是 #2817 留出来的。
- 不要把 `mayOpenModelStream` 和历史写并成一个布尔。
- 不要为了验证去写一个很难复现的双 worker 竞态。现成的 Postgres 测试已经覆盖 superseded lease。

**5. 第一刀**

抽出纯函数，行为不变。新文件 `packages/db/src/run-history-write.ts`：

```ts
export function runHistoryWriteBlock(
  run: { status: string; leaseOwner: string | null; leaseFence: number } | null,
  options?: { allowCancelled?: boolean; lease?: { owner: string; fence: number } },
): "missing" | "cancelled" | "superseded" | null
```

规则与今天的 `assertRunCanWriteHistory` 相同：没有行 → `missing`；`cancelled` 且未 `allowCancelled` → `cancelled`；带了 lease 且 fence 不同，或 owner 非空且不是这个 owner → `superseded`；owner 为空但 fence 相同 → `null`（允许）；没传 lease → 只看取消。`assertRunCanWriteHistory` 在 `findUnique` 之后调用它，`FOR SHARE` 留在原函数里。

不要在这支 PR 里改 `underRunLease`、computer lease、`stopThreadRuns`。

**6. 怎么测**

只加两个 `it`，都在新文件 `packages/db/src/run-history-write.test.ts`。不连数据库。用仓库现成的 vitest（`packages/db` 的单元测试），不要新 harness。

- 行为：`it("allows the holder and a paused owner when the fence matches")`。断言 `runHistoryWriteBlock({ status: "running", leaseOwner: "worker", leaseFence: 2 }, { lease: { owner: "worker", fence: 2 } })` 为 `null`；`leaseOwner: null` 且 fence 仍是 2 时也为 `null`；不传 lease 时 running 为 `null`；`status: "cancelled"` 且 `allowCancelled: true`、fence 匹配时为 `null`。
- 回归：`it("rejects a superseded fence while the run is still running")`。断言 owner 已是别人或 fence 已是 3、请求仍拿 fence 2 时结果为 `"superseded"`；owner 为 `null` 但 fence 不同仍是 `"superseded"`；`cancelled` 且未允许时为 `"cancelled"`；`run === null` 时为 `"missing"`。

接线是否仍和数据库一致：原样重跑 `packages/db/src/run-history-lease.postgres.test.ts` 里已有的 `"rejects writes from a superseded lease and accepts the current one"`。不要往这个文件加新用例。

下一刀（不要和第一刀一起做）：把 `stopThreadRuns` 与 `snapshotRunTeardownTargets` 里「遗留 `executionRunId` 算不算拆机目标」收成纯函数 `legacyTeardownRun`。行为测试放在 `packages/db/src/legacy-teardown-run.test.ts`：`executionRunId` 不在本次取消集合里则返回 `null`。回归测试：`executionBotId` 为空则返回 `null`。然后原样重跑 `apps/api/src/thread-target.test.ts` 已有的 `"does not tear down a stale legacy execution run when the lease owns a cancelled run"`。列删除用单独的 `-- deferred` 迁移，不在这支 PR。

### English

- Two fences stay separate: `Run.leaseFence` (`RunLease`, `assertRunCanWriteHistory`) and `ComputerExecutionLease.fence` (`expireComputerExecutionLeases`).
- History writes allow a null owner when the fence matches. `mayOpenModelStream` does not. Do not merge those booleans.
- `underRunLease` skips the check when `runLeaseFor` is missing. That skip is why #2817 and #2821 exist. Do not flip the default in this PR. Media completion in `media-generation-tools.ts` is an intentional exception from #2817.
- `destroyBot`'s `deleteMany` removes a `(computerId, botId)` pair that is going away. Do not convert it to expire.
- `stopThreadRuns` already snapshots inside the cancel transaction. Do not add a post-commit lookup.
- First PR: add `runHistoryWriteBlock` in `packages/db/src/run-history-write.ts` and call it from `assertRunCanWriteHistory` after the row is loaded. `FOR SHARE` stays put. No behavior change.
- Behavior test, new file `packages/db/src/run-history-write.test.ts`, no database: matching fence allows the write, including `leaseOwner: null`.
- Regression test, same file: a newer fence or a different non-null owner returns `"superseded"` even when status is `"running"`; a null row returns `"missing"`; cancelled without `allowCancelled` returns `"cancelled"`.
- Re-run the existing Postgres test `"rejects writes from a superseded lease and accepts the current one"` in `packages/db/src/run-history-lease.postgres.test.ts`. Add no new case there.
- Later, not this PR: extract `legacyTeardownRun` for the duplicated `executionRunId` branch in `stopThreadRuns` and `snapshotRunTeardownTargets`, with two pure tests, and re-run `"does not tear down a stale legacy execution run when the lease owns a cancelled run"`.

---

## 2. 供应商错误分类

### 中文

**1. 现状**

三套判断对不上就会变成「服务器错误」。

- 重试：`packages/adapter-kit/src/model-errors.ts` 的 `errorFacts`、`isAccountExhaustion`、`isModelCredentialRejected`、`isRetryableProviderUnavailable`、`isTransientModelError`。类是 `TransientModelError`、`ModelAccountError`、`ModelOutputError`。
- 给用户看的句子和 `kind`：`packages/core/src/run-error.ts` 的 `normalizeRunError`。瞬时失败没有 `recovery`。
- 把两边折成一个异常：`packages/adapters/src/pi-runtime-errors.ts` 的 `modelFailure` / `modelFailureClass`。`isTransientModelError` 优先；否则 `terminalOAuthRefreshErrorMarker`（`packages/adapters/src/pi-oauth.ts`）算账户问题；否则看 `normalizeRunError(message).kind`：`output` → `ModelOutputError`，有别的 kind → `ModelAccountError`，没有 kind → 普通 `Error`（服务器故障）。多模型失败取 `MODEL_FAILURE_RANK` 里更严重的那个。

`@rakazo/adapter-kit` 和 `@rakazo/core` 都只依赖 `@rakazo/contracts`，不能互相 import。所以同一句供应商原文今天要改两个包。

#2488 把 OpenAI 的 “An error occurred while processing your request” 放进了 `isRetryableProviderUnavailable` 末尾那条正则（`model-errors.ts` 里能搜到这句）。`normalizeRunError` 没有这句。用 `packages/adapter-kit/src/model-errors.test.ts` 里那条 “server-side processing failure” 夹具调用 `normalizeRunError`，会落到默认句 “The model provider returned an error.”，且没有 `kind`。重试已经当成瞬时，展示层仍是泛化的服务器句。这就是链还没合上的缝。

旁边还有三份不要在第一刀里搬的文本分支：`packages/adapters/src/reported-context-window.ts` 的 `reportedContextWindow`（#2537 那种从拒绝文本读窗口）、`thinking-signatures.ts` 的 `isThinkingSignatureMismatch`、`pi-runtime-models.ts` 的 `acceptedReasoningEfforts`。最后这个用 `modelTargetKey`（provider + model id + connectionId）做 key；#2488 审阅时跨 connection 共享 map 的问题已经按这个 key 修好，不要退回只按 level 名字共享。语音是第三条正则：`packages/adapters/src/voice-http.ts` 的 `voiceAccountIssue` / `BILLING_MESSAGE`（#2335）。

**2. 为什么还在长**

生产里冒出一句新原文时，只改重试或只改展示，另一边仍把 plain `Error` 或默认句子送去上报。#2335 的标题是还在冒，#2488 是仍被报成服务器错误。#2488 还把 `reasoning_effort` 的重试塞进了 fallback，那是请求修补，不是分类。

**3. 目标**

一句原文进一个纯函数，同时决定「重试还是账户问题」和「用户看到的已有句子」。用户可见的英文句子留在 `normalizeRunError` 已有的分支里，不新写一句。请求修补（丢掉 thinking、收窄 reasoning、从 `n_ctx` 读窗口）继续留在各自文件，只消费 kind，不再各自匹配原文。

**4. 不要做**

- 不要在这一刀重写 `normalizeRunError` 或那条巨型正则。
- 不要给 core 加上对 adapter-kit 的依赖，也不要反向依赖。
- 不要新增用户可见的英文句子。过载句已经存在：`"Your OpenAI is overloaded right now. Try again in a moment."`（夹具里有 `help.openai.com`，provider 检测会命中 OpenAI）。
- 不要把语音 `BILLING_MESSAGE`、thinking 签名、context 窗口解析并进同一张表。
- 不要用关键字表去判自由叙述；这里的夹具是供应商返回的固定错误文本。

**5. 第一刀**

在两边都能 import 的叶子包加一个谓词。新文件 `packages/contracts/src/provider-failure.ts`：

```ts
export function isOpenAiRequestProcessingFailure(text: string): boolean
```

实现就是今天那条子串，大小写不敏感：`an error occurred while processing your request`。

- `isRetryableProviderUnavailable` 末尾的正则改成调用它，或保持等价：这个短语仍算可重试。行为相对 `model-errors.test.ts` 里 “server-side processing failure” 不变。
- `normalizeRunError` 增加一个分支，只对这个谓词为真的文本走已经存在的过载句，不新增文案。因为这条夹具含 `help.openai.com`，句子是 “Your OpenAI is overloaded right now. Try again in a moment.”，没有 `kind`、没有 `recovery`（瞬时失败本来就没有 recovery）。

**6. 怎么测**

两个 `it`，放在已有风格的单元测试里，不新造 harness。

- 行为：在 `packages/core/src/run-error.test.ts` 的 overloaded 分组加一个 `it`。输入使用 `model-errors.test.ts` 里 “server-side processing failure” 的整句（含 `help.openai.com` 和全零 request id）。断言 `normalizeRunError` 的 `summary` 为 `"Your OpenAI is overloaded right now. Try again in a moment."`，没有 `kind`，没有 `recovery`。同一句在 `packages/adapter-kit/src/model-errors.test.ts` 已有用例里必须仍是 `isTransientModelError === true`（这是已有测试，改正则时把它保持绿色即可，不要复制第二份夹具）。
- 回归：在 `packages/adapter-kit/src/model-errors.test.ts` 加一个 `it`，用已有的永久配额夹具：`status: 429`，message `"You exceeded your current quota, please check your plan and billing details."`，code `"insufficient_quota"`。断言 `isTransientModelError` 为 false。把同一 message 包成 `normalizeRunError` 能读的 `429: {"message":"...","code":"insufficient_quota"}`，断言 `kind` 为 `"credit"`，且 `summary` 不是过载那句。同一次 `it` 里再断言 #2488 的 TPM 夹具（“tokens per min (TPM)” 且带 billing 链接的那条）仍是 `isTransientModelError === true`，避免新分支把短时限流收成配额。

不要在这支 PR 里改 `voiceAccountIssue`、`reportedContextWindow`、`acceptedReasoningEfforts`。下一刀再按同样的两个测试，把「短时 RPM/TPM」和「配额」收成 contracts 里的第二个谓词；那时候再删 `normalizeRunError` 里重复的 TPM 判断。

### English

- Retry lives in `packages/adapter-kit/src/model-errors.ts`. The user-facing sentence lives in `normalizeRunError`. `modelFailureClass` returns a plain `Error` when neither says what the failure is. adapter-kit and core cannot import each other.
- The processing-failure phrase is already inside `isRetryableProviderUnavailable`. It is not inside `normalizeRunError`, so the same fixture still summarizes as `"The model provider returned an error."`
- First PR adds `isOpenAiRequestProcessingFailure` in `packages/contracts/src/provider-failure.ts` (the shared leaf). `model-errors.ts` keeps treating that phrase as retryable. `normalizeRunError` uses the existing overload sentence for that phrase only. No new user-facing copy. The fixture contains `help.openai.com`, so the sentence is `"Your OpenAI is overloaded right now. Try again in a moment."`
- Behavior test in `packages/core/src/run-error.test.ts`: that full “server-side processing failure” string from `model-errors.test.ts` gets the overload summary, with no `kind` and no `recovery`. The existing transient test for the same string stays green.
- Regression test in `packages/adapter-kit/src/model-errors.test.ts`: the existing `insufficient_quota` / “exceeded your current quota” fixture stays non-transient, `normalizeRunError(...).kind` is `"credit"`, and the summary is not the overload sentence. The same test keeps the TPM-plus-billing-link fixture transient.
- Do not rewrite the big regex, do not add a core → adapter-kit dependency, and do not touch voice, thinking signatures, context-window parsing, or `acceptedReasoningEfforts` in this PR. `modelTargetKey` stays the map key.

---

## 3. noVNC 与厂商页面 shim

### 中文

**1. 现状**

屏幕页被沙箱成不透明源，没有真正的 `localStorage`。根因写在 `packages/adapters/src/kubernetes-sandbox.ts` 的 `screenUrl`：页面用 `sandbox="allow-scripts"`，stock `vnc.html` 读 storage 会抛 `SecurityError`。Kubernetes 因此指向镜像里的 `embed.html`。Web 代理则改写 HTML，而不是放宽沙箱。

改写只发生在 `apps/web/vite.config.ts`：`shouldInjectNovncStorageShim` 为真时读完 body，调用 `injectNovncStorageShim`，再用 `rewrittenNovncHeaders` 标成 `no-store, no-transform`。实现全在 `apps/web/src/novnc-html.ts`。`apps/api/src/screen-proxy.ts` 的 `mountScreenTarget` 只校验 capability，不改 HTML。

`injectNovncStorageShim` 现在一次做完这些事：内存版 `localStorage` 和 `sessionStorage`（#1732 然后 #1787）、拦住 `^[a-z-]+-extension:` 的 `error` 事件（#1787）、删掉 `window.VideoDecoder`、按 noVNC 的 class 用 `postMessage({ rakazoScreen })` 上报、响应 `{ rakazoScreenFocus: true }`、以及用 CSS 藏起 `#noVNC_status`。父页面用 `apps/web/src/lib/computer-screen.ts` 的 `screenFrameMessage` 读，合法状态是 `loading | connecting | connected | failed | disconnected`。移动端 `apps/mobile/lib/computer.ts` 的 `screenPageState` 更严：JSON 只能有一个 key `rakazoScreen`。

厂商页 `apps/web/public/wuying/screen.js` 发同样的 `{ rakazoScreen }`，但焦点判断是 `event.data?.rakazoScreenFocus` 为真即可。noVNC 脚本要求这个对象只有这一个 key 且值为 `true`。两套焦点规则已经分叉。

**2. 为什么还在长**

沙箱策略没变（#1787 正文写了 CSP sandbox is unchanged）。下一则浏览器或扩展的异常继续写进同一个注入脚本。#1732 把 localStorage shim 从 CreateOS 扩到所有代理页，同一天 #1787 补上 sessionStorage 和扩展错误。VideoDecoder、状态栏、焦点又叠在同一个函数里。

**3. 目标**

存储 shim 收束成「两个 storage 都是内存实现」这一件事，正则和屏幕状态各自是可单测的函数，注入脚本只拼接它们。`screenFrameMessage` 仍是父页面唯一的状态合同。不要为了让 storage 可用而去掉沙箱。

**4. 不要做**

- 不要给 iframe 加上 `allow-same-origin`。那会拆掉这次 shim 在保护的隔离。
- 不要把下一个 Web API（又一个 `delete window.…`）塞进 `memoryStorage`。
- 不要放宽 `screenFrameMessage` 或 `screenPageState` 去迁就某一家厂商。Wuying 的焦点判断若要对齐，单独改 `wuying/screen.js`，并在单元测试里断言它仍只接受父页面的焦点消息。
- 不要为这一刀跑 `apps/web/e2e/screen-proxy-isolation.spec.ts`。现有的 `novnc-html.test.ts` 已经会抽出脚本再 eval。

**5. 第一刀**

把扩展错误的正则从脚本字符串里提出来，脚本用同一份 source 拼出来。在 `apps/web/src/novnc-html.ts`：

```ts
export const NOVNC_EXTENSION_ERROR = /^[a-z-]+-extension:/;
export function isNovncExtensionError(filename: string): boolean
```

`injectNovncStorageShim` 的模板使用 `NOVNC_EXTENSION_ERROR.source`，不再手写第二份正则。存储对象、VideoDecoder、屏幕上报这一刀不动。

**6. 怎么测**

都在已有的 `apps/web/src/novnc-html.test.ts`。

- 行为：新 `it("treats extension URLs as frame errors and leaves page errors alone")`。断言 `isNovncExtensionError("chrome-extension://abc")` 和 `isNovncExtensionError("moz-extension://abc")` 为 true；`""` 和 `"https://screens.example/vnc.html"` 为 false。
- 回归：扩展已有的 `it("keeps extension script errors away from noVNC's error page")`。在原有「扩展事件被 `stopImmediatePropagation`、页面 URL 和空 filename 不拦截」之上，加一条 `expect(injectNovncStorageShim("<head>")).toContain(NOVNC_EXTENSION_ERROR.source)`。这样脚本不能再漂移出第二份正则。

下一刀（不要和第一刀一起做）：把 `sync` 里的状态选择收成纯函数 `novncFrameState`，输入是布尔（connected、connecting、failure、statusError、hasCanvas、last）。行为测试用表覆盖「connected 压过 connecting」「有 failure 则为 failed」「只有 canvas、还没有 class 则为 connecting」。回归仍是同文件已有的 `it("posts loading at once, then follows noVNC's connection classes")`。注入脚本调用这个函数的逻辑，或者用一份序列化的规则表，不能手写第二份 if。

### English

- The opaque sandbox is the constraint. `mountScreenTarget` does not rewrite HTML. Injection is `injectNovncStorageShim`, called from `apps/web/vite.config.ts`.
- That function now shims both storages, filters extension errors, deletes `VideoDecoder`, posts `rakazoScreen`, handles focus, and hides the status bar. Parent parsing is `screenFrameMessage`. Mobile `screenPageState` accepts only the one key `rakazoScreen`.
- `apps/web/public/wuying/screen.js` posts the same shape but accepts any truthy `rakazoScreenFocus`. Do not loosen the parent parser to match it.
- First PR: export `NOVNC_EXTENSION_ERROR` and `isNovncExtensionError` from `apps/web/src/novnc-html.ts`. Build the injected script with `NOVNC_EXTENSION_ERROR.source`. Leave storage, VideoDecoder, and screen reporting as they are.
- Behavior test in `apps/web/src/novnc-html.test.ts`: `chrome-extension:` and `moz-extension:` are errors; `""` and an `https:` page URL are not.
- Regression: extend `"keeps extension script errors away from noVNC's error page"` with `expect(injectNovncStorageShim("<head>")).toContain(NOVNC_EXTENSION_ERROR.source)`. Do not run the Playwright screen-proxy spec for this slice.
- Later, not this PR: extract `novncFrameState` and keep `"posts loading at once, then follows noVNC's connection classes"` as the regression. Do not add `allow-same-origin`.

---

## 不要并进这三支 PR 的链

`apps/mobile/lib/api.ts` 的 `spaceSelectionGeneration` 和 `spaceSelectionRequestGeneration` 是 #812 用来关上 #799 推迟的竞态的。`selectSpace` 用它们认领内存和 SecureStore。`adoptDeletedSpaceFallback` 会 `bumpSpaceSelectionGeneration`，但不占用 `spaceSelectionRequestGeneration`。若要补，只在 `apps/mobile/lib/api.test.ts` 加一个纯顺序测试：`selectSpace` 进行中时 `adoptDeletedSpaceFallback` 不能把活着的选择写回旧 id。不要把数据库 lease 引进移动端。

`packages/adapters/src/computer-idle.ts` 的 marker 清扫（#2829）保持独立。

## English

- Mobile Space selection stays in `apps/mobile/lib/api.ts`. A follow-up, if any, is one ordering test in `api.test.ts`, not a database lease.
- #2829's background-marker sweep stays in `computer-idle.ts`.

## 建议的合并顺序

三支第一刀互不依赖，可以并行。每支只含上面那两个测试，加上点名的那条已有测试原样重跑。

1. `runHistoryWriteBlock`（行为不变）。
2. `isOpenAiRequestProcessingFailure`（只改这一句原文的展示，重试结果不变）。
3. `isNovncExtensionError`（行为不变）。

做完一支，下一句供应商原文或下一个写点才允许再改对应的那一个函数。不要在同一支 PR 里加新的正则、新的 lease 参数和新的 shim 分支。

## English

- The three first PRs do not depend on each other.
- Ship `runHistoryWriteBlock` with no behavior change.
- Ship `isOpenAiRequestProcessingFailure` so that one phrase uses the existing overload sentence. Retry stays as it is.
- Ship `isNovncExtensionError` with no behavior change.
- After that, the next vendor string or the next writer changes that one function. Do not add a new regex, a new lease argument, and a new shim branch in the same PR.
