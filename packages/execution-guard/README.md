# dsh-execution-guard

DSH plugin bundle: argument preflight before approval/side effects, plus repeated-failure correction hints. One Cordis plugin row (`id: execution-guard`), consuming only public host seams.

> The recovery anchor (`checkpoint_task` + the resume comparison) used to live here and now ships as the sibling bundle [**dsh-task-anchor**](../task-anchor/). It is session continuity, not execution guarding, and shares no runtime state with this package.

## What it does

### 1. `tools/pre-execute` argument preflight (prepended listener)

Re-validates the pending call's arguments against the **public** registry surface (`ctx.tools.schemas(exec.agent)`) using the host's own enforced-subset validators (`assertSupportedJsonSchema` + `validateJsonSchemaValue`) — the same contract `defineTool` enforces at execution time, moved in front of approval and side effects.

Why it is not redundant with the host's own check: the host validates inside `dispatchToolBody`, i.e. **after** the `tools/pre-execute` gate and **after** the approval ask. A malformed call that also requests a sandbox escalation would otherwise prompt the human first and only then report `INVALID_ARGS`.

- **Native same-step batches** are validated as a whole (an EMPTY model argument string is the legal no-arguments form and reads as `{}`, mirroring the host's raw parse). The host appends `tool/call` events one call at a time as it starts each execution, so the batch is read from the current step's settled `assistant/message` — its `message.content` `tool-call` blocks (id, name, raw arguments) are complete before dispatch begins. Every member is checked; any invalid member denies **every** member with per-tool/callId violated fields, so no child body — and no approval prompt — runs under an invalid batch-mate. This is a **whole-step output denial** (each member's own gate denies the same batch), not a scheduler concurrency group. When no assistant tool-call message can be found, only the live execution is checked and whole-batch atomicity is explicitly **not** claimed.
- **`run_code` (PTC) sub-dispatches** are checked alone via the binding-time schema on `exec.schema` — the *dynamic current sub-call* only. No claim is made that the enclosing program is atomic.
- **Unknown tools and unsupported schemas defer to the host**: an unknown native tool is already `UNKNOWN_TOOL` before the policy pipeline, and `assertSupportedJsonSchema` rejects (rather than trusts) out-of-subset schemas — the plugin logs a diagnostic and steps aside instead of inventing a verdict. Nothing is ever allowed *because* we could not check.
- Arguments are **never rewritten or auto-filled**; the scheduler is untouched; no `multi_tool_use.parallel` tool is registered (that name belongs to outer transports, not the host).
- The schema set is cached per scope and invalidated on `tools/change`.
- The plugin's own bugs degrade to `next()` (host pipeline), never to a phantom verdict.

### 2. Repeated `INVALID_ARGS` correction hints (`tools/result` final-outcome observer)

The host's own `@deepseek-ai/dsh-repeat-tool-reminder` only catches **identical** arguments at 3/5/8 consecutive calls, and it never inspects the result, so a model that keeps changing values while missing the same field never trips it. It also carries no notion of the tool's expected shape. This plugin covers that gap; the host reminder is untouched.

All counting/reset/hint delivery happens on the **`tools/result` final-outcome observer** — post-execute cannot serve that role because the host may cancel after it and pipeline-failure results bypass it, while `tools/result` fires once for every frozen final outcome.

On the **second same-shape** final `INVALID_ARGS` (normalized fingerprint: paths/keywords stay, indices and quoted values collapse) a hint notice is delivered carrying the error code and the expected argument shape (`describeShape`), with the standard `execution-guard` source — the notice itself never resets the tracker. Two occurrences is the threshold because the first failure already hands the model the per-field violations; only a repeat with the *same shape* proves the problem is the interface, not the values.

The hint is delivered through `agent.inject()`, never a bare surface append: this observer fires per call from inside the agent loop's `runGroup`, which for a parallel batch is *between* two `tool/result` events — appending a `user/message` there would split the batch's call/result pairing and get the session rejected (HTTP 400) by OpenAI-compatible endpoints. See «notice 的投递通道» in [dsh-auto-permit](../auto-permit/) for the full failure mode.

Every final `INVALID_ARGS` counts, including host-origin ones (message-line fingerprints); a valid sibling denied by its batch-mate is distinguished at deny time and never counts its parameters as faulty. A genuine final success of the tool resets its failure shapes (a cancelled call settles as `ABORTED`, an error — no reset), as does a new human turn. Still-invalid calls keep being denied — as they should be. State is per-agent, weakly held, bounded (64 fingerprints; per-call markers capped at 256). Legitimate same-tool repeats are never suppressed and no permission is ever widened.

## Config

Plugin-row config (all optional; the schema supplies the defaults):

- **preflight** (default true) — validate tool arguments before approval/side effects.
- **repeatHints** (default true) — attach correction hints on repeated `INVALID_ARGS`.

## Public API (pure, testable)

`checkCall` / `checkBatch` / `describeShape` (preflight), `currentStepCalls` / `lastHumanSeq` (batch fold from the assistant message), `RepeatTracker` / `fingerprint` / `hintableCalls`, `buildHintMessage` / `deliverNotice`, plus `apply(ctx, config)`.

## Limits

- PTC: only the current sub-call is validated; the enclosing program is not (and cannot be) claimed atomic.
- Outer-wrapper batches (e.g. transports named like `multi_tool_use.parallel`) are not visible here and are not fabricated.
- Input limits use the host-supported schema subset (no `minLength`-style keywords).

## Install / dev (commands are run by the human)

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
dsh plugin --profile <profile> add ./packages/execution-guard
# or development overlay:
dsh --profile web --patch ./packages/execution-guard/dev.patch.yml --no-open --port <port>
```

Nix hosts mount the bundle layer declaratively (flake/profile overlay) — this package only ships `cordis.patch.yml`; no real Nix configuration is touched by building or testing here.
