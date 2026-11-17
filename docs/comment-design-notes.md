# Comment-Migration Design Notes

This file retains a small set of cross-cutting reasons that were previously embedded in long source comments. It is not a copy of the source documentation; implementation details remain in code and tests.

## Confinement and trust

- `toolchain-access` grants exact writable subtrees from trusted plugin configuration and ambient operator environment only. Project files and agent claims cannot widen grants; implicit paths stay inside known base trees. Unsupported grants and an unfamiliar sandbox argv layout fail closed. The semgrep private-state preset mounts a private directory over the sandbox destination; it does not grant the host's token-bearing state directory. See `packages/toolchain-access/src/grants.ts`, `packages/toolchain-access/src/bwrap.ts`, and their tests.
- `auto-env` evaluates direnv on the host using the user's existing allow records. The confined bash process receives only the resolved environment overlay; it does not run `direnv allow`. A blocked environment is surfaced through the session status variables. See `packages/auto-env/src/direnv.ts` and its smoke tests.
- `session-write-access` canonicalizes and validates grants at admission and enforces them again at the host boundary. The durable group record is the permission commit point; children use the group's frozen workspace, and a workspace-write call with neither session cwd nor configured workspace root is refused rather than derived from process cwd. Protected authorization/profile/plugin paths remain unwritable. See `packages/session-write-access/src/paths.ts`, `access.ts`, `policy.ts`, and `service.ts`.

## Catalog and lifecycle

- `recursive-skills` supplements, rather than replaces, the stock direct-skill provider. Direct skills keep precedence; nested bundles are bounded by `SKILL.md`, traversal deduplicates filesystem targets, and provider watchers reconcile directory targets so symlink changes invalidate the catalog. Skill bodies are read on demand. See `packages/recursive-skills/src/provider.ts` and `watch.ts` and their tests.
- `more-providers` refreshes ChatGPT grants inside `credentials.modifyRecord`'s exclusive write window; concurrent processes recheck expiry before consuming a rotating refresh token. See `packages/more-providers/src/providers/chatgpt/auth.ts` and the credential service contract.
- `config` publishes only validated configuration. Missing or invalid data is unusable; there is no last-known-good fallback. A shared status hub owns one route per path across plugin generations. See `packages/config/src/index.ts` and tests.
- `crew` selects only explicitly approved candidates from one validated policy snapshot and checks the policy revision before creating a child. Changes during preparation refuse that selection rather than silently substituting an unapproved route. See `packages/crew/src/index.ts` and its smoke assertions.

## Quota recovery and resumption

- Auto-continue records one retry chain per turn, step, and provider because the session format numbers attempts per chain. A wait is persisted before sleeping; aborting the turn keeps the record for resumption, while explicit cancellation removes it. The spool assumes a single DSH process; concurrent readers could duplicate a resume. See `packages/auto-continue/src/recovery.ts` and `spool.ts`.
- Pending waits use a `user/message` notice row rather than `llm/retry`: the persistence reader requires retry events to belong to an open step. See `packages/auto-continue/src/notice.ts` and its smoke assertions.
- The resumption adopter ignores records after newer user activity, retries while the agent is busy or its controller is mounting, and removes the record after firing. Restart-resume mirrors running sessions on status transitions and only follows up a turn that did not complete before shutdown. See `packages/auto-continue/src/resume.ts`, `restart.ts`, and their smoke tests.

## Session-log repair

- `auto-continue/repair-llm-retry.py` repairs two persistence violations: retry events outside their matching open step, and attempt counters/retry IDs that do not follow per-policy-chain sequencing. It aligns `llm/retry-started` with the next unstarted attempt, makes sequence numbers contiguous, and writes the store's per-line Zstandard frames. The tool stops before writing valid logs, leaves a backup before the first rewrite, and supports `--dry-run`; run it with DSH stopped or affected sessions closed. See `packages/auto-continue/repair-llm-retry.py`.

## Approval behavior

- `auto-permit` never substitutes an AI denial for the user's explicit decision. Uncertain, failed, or exhausted judge runs fall through to the human approval path. High-risk operations are kept on that path, and command/script results are not reusable as repeat-memory approvals. See `packages/auto-permit/src/index.ts`, `container.ts`, `rules.ts`, and tests.
- `cmd-permit` requires every command segment to match independently; command substitution defers. The development overlay and installed bundle share their permission defaults, pinned by seed-parity tests. See `packages/cmd-permit/src/rules.ts` and `test/seed-parity.test.ts`.
- `rtk-rewrite` decides rewrite usability from stdout rather than relying on an exit-code interpretation that the tested rtk version does not honor. The rewritten command keeps its sandbox and auto-env overlay, while approval evidence continues to identify the original input. See `packages/rtk-rewrite/src/rewrite.ts` and `index.ts`.
- Tool-call/result pairing constrains where approval notices may be appended to session history; preserve the tested notice insertion protocol when changing it. See `packages/auto-permit/src/index.ts` and `notice.test.ts`.

## Tool and workflow boundaries

- `execution-guard` validates the whole native same-step tool-call batch when the session snapshot provides it. One invalid member denies the batch; missing or unsupported schemas remain explicitly unchecked for the host. It does not rewrite tool arguments. See `packages/execution-guard/src/batch.ts` and `preflight.ts`.
- `handoff` remembers model choice per profile, derives the preset from the origin's live composition, and reads the effective model from `agent.model.current()`. A cross-workspace launch copies the full brief into the destination before starting the child. See `packages/handoff/src/preferences.ts`, `presets.ts`, `selection.ts`, and `spawn.ts`.
- `jj-workspace` creates its workspace and bookmark under the calling session's existing sandbox policy, then changes the session directory. It does not advance bookmarks automatically; Git creation stays on the stock isolated runtime. See `packages/jj-workspace/src/process.ts`, `service.ts`, and `jj.ts`.
- `remote-exec` accepts only operator-configured SSH/container targets; the model supplies a target key, working directory, and command. Preparation failures stop before command execution. A timeout or SSH loss only stops the local transport, so remote completion can be unknown and must not trigger blind retries. See `packages/remote-exec/src/exec.ts` and `index.ts`.
- `search-integrator` deduplicates normalized URLs or byte-identical syndication, keeps missing sources and degraded synthesis explicit, and requires an observed model stop before accepting completed output. Citation validation and result shrinking preserve resolvable source references. See `packages/search-integrator/src/evidence.ts`, `llm.ts`, `integrate.ts`, `pipeline.ts`, and `render.ts`.
- `task-anchor` reads the jj working change, parents, and workspace root, re-reads the change to detect a race, then stores a recovery note. It reports drift; it does not rebase, check out, or resume work. See `packages/task-anchor/src/jj.ts`, `checkpoint.ts`, and `index.ts`.
- `triggers` commits a pending signal only when the submitting session's exact turn ends completed. Each run transition persists its pending outbox intents and request IDs in the run record before delivery; the delivery table is a rebuildable UI projection. See `packages/triggers/src/engine.ts`, `service.ts`, `store.ts`, and `replay.ts`.

- `crew` takes one validated route-policy snapshot and refuses to start a child if its revision changes during preparation; candidates and provider choices are constrained by that snapshot. See `packages/crew/src/index.ts` and its revision tests.
- `handoff` resolves the origin's effective model from `agent.model.current()` and carries the origin's composed preset unless the user chooses otherwise. Cross-workspace handoffs copy the brief to the target before spawning because the origin workspace may later be removed. See `packages/handoff/src/selection.ts` and `spawn.ts`.
- `jj-workspace` runs jj and directory preparation under the initiating session's sandbox policy, persists the task record before changing the session cwd, and reports partial creation rather than rolling back the workspace/bookmark. See `packages/jj-workspace/src/service.ts` and `process.ts`.
- `search-integrator` accepts only citation IDs present in the numbered evidence set; claims without valid sources become explicit unknowns. Digest budgeting preserves each source URL so citation IDs remain resolvable. See `packages/search-integrator/src/integrate.ts` and `evidence.ts`.
