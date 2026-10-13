#!/usr/bin/env python3
"""Repair session logs corrupted by malformed `llm/retry` events.

Two corruption classes, both written by past dsh-auto-continue releases and
both fatal at load time (the persistence reader refuses the whole log):

1. Events outside their matching open step — a 2026-10-04 release appended
   adoption notices as `llm/retry` outside a live open step
   ("llm/retry does not match the current turn and step").
2. Chain-numbering violations — a release numbered attempts with a
   turn-scoped counter while the format chains them per
   (turn, step, provider, policyKey), each chain starting at 1 and keeping
   one retryId ("llm/retry skips its policy attempt sequence" / "must keep
   one retryId per policy chain"). This fires when a turn retries at one
   step, advances, and hits the limit again at a later step.

This script walks every `session.v*.jsonl.zstd` under `$DSH_HOME/sessions`,
drops any `llm/retry` event that does not sit inside its matching open step,
renumbers the remaining chains (retry from 1, the chain's first retryId
reused by later attempts), aligns every `llm/retry-started` with its chain's
next unstarted attempt, renumbers the events' `seq` contiguously, and
rewrites the log with per-line Zstandard frames (the store's framing). A
`.bak-ac-repair` backup is left next to the first rewrite of every file;
logs without offenders are untouched. Normalization is a no-op on valid
logs, so running it over all sessions is safe.

Run it with the dsh service stopped (or at least the affected sessions
closed): python3 repair-llm-retry.py [--dry-run]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

DRY = "--dry-run" in sys.argv[1:]
ROOT = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")) / "sessions"


def zstd_read(path: Path) -> list[str]:
    out = subprocess.run(["zstd", "-dc", str(path)], capture_output=True, check=True)
    return out.stdout.decode("utf-8").splitlines()


def zstd_write(path: Path, lines: list[str]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("wb") as fh:
        for line in lines:
            data = subprocess.run(["zstd", "-q", "-c"], input=(line + "\n").encode(), capture_output=True, check=True)
            fh.write(data.stdout)
    tmp.replace(path)


def repair_log(path: Path) -> tuple[int, int, int]:
    """Fix invalid llm/retry rows; returns (removed, renumbered, normalized)."""
    lines = zstd_read(path)
    if not lines:
        return (0, 0, 0)
    try:
        header = json.loads(lines[0])
    except json.JSONDecodeError:
        return (0, 0, 0)  # not a session log
    if header.get("type") != "session":
        return (0, 0, 0)

    events: list[dict] = []
    for line in lines[1:]:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            return (0, 0, 0)  # unexpected shape: leave alone

    kept: list[dict] = []
    removed = normalized = 0
    open_step: tuple[int, int] | None = None
    # One policy chain's state, keyed by (turn, step, provider, policyKey).
    chains: dict[tuple, dict] = {}

    def chain_key(data: dict) -> tuple:
        return (data.get("turn"), data.get("step"), data.get("provider"), data.get("policyKey"))

    for event in events:
        kind = event.get("type")
        data = event.get("data", {}) if isinstance(event.get("data"), dict) else {}
        if kind == "step/start":
            open_step = (data.get("turn"), data.get("step"))
        elif kind in ("step/end", "turn/end"):
            open_step = None

        if kind == "llm/retry":
            if open_step != (data.get("turn"), data.get("step")):
                removed += 1
                continue
            key = chain_key(data)
            chain = chains.get(key)
            if chain is None:
                # Fresh chain keeps its own retryId and starts at attempt 1.
                chain = {"retryId": data.get("retryId"), "count": 0}
                chains[key] = chain
            chain["count"] += 1
            if data.get("retryId") != chain["retryId"] or data.get("retry") != chain["count"]:
                data["retryId"] = chain["retryId"]
                data["retry"] = chain["count"]
                event["data"] = data
                normalized += 1
            chain.setdefault("started", 0)
            kept.append(event)
            continue

        if kind == "llm/retry-started":
            # Pair this start with its chain's next unstarted attempt.
            matches = [k for k, c in chains.items()
                       if k[0] == data.get("turn") and k[1] == data.get("step") and c["retryId"] == data.get("retryId")]
            key = matches[0] if matches else None
            chain = chains.get(key) if key is not None else None
            if chain is None or chain.get("started", 0) >= chain["count"]:
                removed += 1  # pairs no scheduled attempt: unrepairable here
                continue
            chain["started"] = chain.get("started", 0) + 1
            if data.get("retry") != chain["started"]:
                data["retry"] = chain["started"]
                event["data"] = data
                normalized += 1
            kept.append(event)
            continue

        kept.append(event)

    if removed == 0 and normalized == 0:
        return (0, 0, 0)

    # Renumber seq contiguously (first event keeps its original first seq).
    base = kept[0]["seq"] if kept and isinstance(kept[0].get("seq"), int) else 1
    renumbered = 0
    for i, event in enumerate(kept):
        wanted = base + i
        if event.get("seq") != wanted:
            event["seq"] = wanted
            renumbered += 1

    if not DRY:
        backup = path.with_name(path.name + ".bak-ac-repair")
        if not backup.exists():
            path.replace(backup)
        zstd_write(path, [lines[0]] + [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in kept])
    return (removed, renumbered, normalized)


def main() -> int:
    if not ROOT.is_dir():
        print(f"no sessions dir at {ROOT}")
        return 1
    total_files = total_removed = total_normalized = 0
    for path in sorted(ROOT.glob("*/*/session.v*.jsonl.zstd")):
        try:
            removed, renumbered, normalized = repair_log(path)
        except Exception as exc:  # noqa: BLE001 — report and continue with others
            print(f"ERROR {path}: {exc}")
            continue
        if removed or normalized:
            total_files += 1
            total_removed += removed
            total_normalized += normalized
            suffix = " (dry-run)" if DRY else ""
            print(f"repaired{suffix}: {path.relative_to(ROOT)} removed={removed} normalized={normalized} renumbered={renumbered}")
    print(f"done: {total_files} log(s), {total_removed} event(s) removed, {total_normalized} field(s) normalized")
    return 0


if __name__ == "__main__":
    sys.exit(main())
