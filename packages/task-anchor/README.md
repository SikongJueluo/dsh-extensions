# dsh-task-anchor

DSH plugin bundle: a persistent **recovery anchor** for long tasks — where the task believes it is, compared against where the repository and goal actually are when the session comes back. One Cordis plugin row (`id: task-anchor`), consuming only public host seams.

> Split out of [dsh-execution-guard](../execution-guard/) (2026-10-14). The two packages share a source kind and a storage directory by design, but no runtime state; the guard keeps argument preflight and repeat hints, this one keeps `checkpoint_task` and the resume comparison.

## What it does

### `checkpoint_task`

Persists (via `writeFileAtomic` + `withFileLock` from `@deepseek-ai/dsh-atomic-write`, under `storagePath`, default `$DSH_HOME/storages/execution-guard`):

| field | source |
|---|---|
| repo root | realpath of the jj **workspace root** (`jj workspace root`, run from `session.header.cwd`) — correct even when the session cwd is a repo subdirectory; `expectRepoRoot` compares against this |
| jj change id & parents | THREE fixed-argv read-only invocations (`--ignore-working-copy --no-pager`): one combined `log -r @ -T 'change_id ++ "\n" ++ parents.map(\|p\| p.change_id()).join(" ")'` reading the working change AND its parents in a single process with FULL change ids (`.short()` abbreviations vary and collide), the workspace-root read, and a second light re-read of the same combined template as a stability check. The processes are not atomic — a `jj new`/rebase landing mid-read yields mixed facts, and the re-read turns that into an explicit `drift` failure (no retry; the checkpoint fails and is re-issued). Multi-parent merges are stored as an ordered `parentChangeIds` list, so a rebase that rewires parents reads as drift even when the change id survives. Hard timeout, signal-forwarded, read-only — no git fallback, no snapshots. |
| goal id / revision | **durable `goal/change` events only** (see below); model-asserted ids without durable proof are recorded `args-only-unverified` |
| phase, owned files, verification | tool arguments (bounded: 64 files × 512 chars, 2000-char verification) |

Call it when a phase completes and **again after switching working layers** (`jj new`) so the anchor tracks the layer actually being edited.

### Resume comparison

On `agent/created` (startup/resume), the anchor is compared against the live repo/goal and a notice is appended to the session reporting consistency or drift (root / working change / parent / goal id + revision + still-active — change drift is expected after `jj new`; goal drift is a warning only), plus owned files and the verification summary. One notice per session; `resumeNotice: false` disables it.

`agent/created` fires while the agent is still idle (before any turn opens), so the plain surface append there is safe — there is no tool-call/result batch to split. Contrast the repeat hint in dsh-execution-guard, which fires mid-batch and must go through `agent.inject()`.

**Goal evidence is authoritative or absent.** Tool-call *requests* prove nothing: `update_goal`'s `revision` is the pre-update CAS value, the request may fail, and `get_goal`/`create_goal` carry no id. Only durable `goal/change` events (the `dsh-goal` domain's session records, duck-typed until its types ship locally) are folded; the fold compares id AND revision (a new goal reusing a revision number is a mismatch), remembers `clear`, and marks completed goals as no longer active. When no goal events exist at all (or they are unreadable), an asserted goal is stored as `args-only-unverified` — the anchor explicitly never claims CAS proof it cannot make. A **cleared** fold is counter-evidence: asserting a goal then is a conflict, not an unknown.

**This is a recovery anchor, not a repository write lock.** It never rebases, checks out, resumes goals (`goals.resume`), or forks sessions, and a session-name match is not treated as a lock. Goal re-arm/activation is deliberately NOT equated with recovery.

Non-jj roots fail loudly (`not-jj` — git fallback intentionally absent, no sneaky git commands), as do timeouts.

## Config

Plugin-row config (all optional; the schema supplies the defaults):

- **storagePath** (default `$DSH_HOME/storages/execution-guard`) — anchor directory. The pre-split path is kept on purpose so anchors written before the split stay readable.
- **jjTimeoutMs** (default 5000, clamped to 1s–30s) — per-invocation budget for the read-only `jj` fact reads.
- **resumeNotice** (default true) — compare the anchor on agent resume/startup.

## Public API (pure, testable)

`AnchorStore` / `parseAnchor` / `compareAnchor` / `resolveRoot` / `ANCHOR_SCHEMA_VERSION`, `foldGoalEvents` / `mergeGoal` / `decodeGoalChangeV1`, `readJjFacts` / `workingLayerArgv` / `workspaceRootArgv` (injectable `ExecFile`), `buildResumeNotice`, plus `apply(ctx, config, deps?)` with injectable `exec`/`jjPath` seams for adapter tests.

## Install / dev (commands are run by the human)

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
dsh plugin --profile <profile> add ./packages/task-anchor
# or development overlay:
dsh --profile web --patch ./packages/task-anchor/dev.patch.yml --no-open --port <port>
```

Mount it **together with** `dsh-execution-guard` if you want the pre-split behaviour: they are two independent rows now, and forgetting one silently drops that half (no error, no warning). Nix hosts mount the bundle layer declaratively (flake/profile overlay) — this package only ships `cordis.patch.yml`; no real Nix configuration is touched by building or testing here.
