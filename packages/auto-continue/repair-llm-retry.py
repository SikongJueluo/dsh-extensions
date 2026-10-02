#!/usr/bin/env python3
"""Repair session logs corrupted by out-of-step `llm/retry` events.

A dsh-auto-continue release (2026-10-04) appended adoption notices as
`llm/retry` session events outside a live open step; the persistence reader
validates those events against the current turn/step and refuses to load the
whole log afterwards ("stored log is corrupt: llm/retry does not match the
current turn and step").

This script walks every `session.v*.jsonl.zstd` under `$DSH_HOME/sessions`,
drops any `llm/retry` event that does not sit inside its matching open step,
renumbers the remaining events' `seq` contiguously, and rewrites the log with
per-line Zstandard frames (the store's framing). A `.bak-ac-repair` backup is
left next to every rewritten file; logs without offenders are untouched.

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


def repair_log(path: Path) -> tuple[int, int]:
    """Drop invalid llm/retry rows; returns (removed, renumbered)."""
    lines = zstd_read(path)
    if not lines:
        return (0, 0)
    try:
        header = json.loads(lines[0])
    except json.JSONDecodeError:
        return (0, 0)  # not a session log
    if header.get("type") != "session":
        return (0, 0)

    events: list[dict] = []
    for line in lines[1:]:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            return (0, 0)  # unexpected shape: leave alone

    kept: list[dict] = []
    removed = 0
    open_step: tuple[int, int] | None = None
    for event in events:
        kind = event.get("type")
        data = event.get("data", {}) if isinstance(event.get("data"), dict) else {}
        if kind == "step/start":
            open_step = (data.get("turn"), data.get("step"))
        elif kind in ("step/end", "turn/end"):
            open_step = None
        if kind == "llm/retry" and open_step != (data.get("turn"), data.get("step")):
            removed += 1
            continue
        kept.append(event)

    if removed == 0:
        return (0, 0)

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
        else:
            zstd_write(path, [lines[0]] + [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in kept])
    return (removed, renumbered)


def main() -> int:
    if not ROOT.is_dir():
        print(f"no sessions dir at {ROOT}")
        return 1
    total_files = total_removed = 0
    for path in sorted(ROOT.glob("*/*/session.v*.jsonl.zstd")):
        try:
            removed, renumbered = repair_log(path)
        except Exception as exc:  # noqa: BLE001 — report and continue with others
            print(f"ERROR {path}: {exc}")
            continue
        if removed:
            total_files += 1
            total_removed += removed
            suffix = " (dry-run)" if DRY else ""
            print(f"repaired{suffix}: {path.relative_to(ROOT)} removed={removed} renumbered={renumbered}")
    print(f"done: {total_files} log(s), {total_removed} invalid event(s) removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
