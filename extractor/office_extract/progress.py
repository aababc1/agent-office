"""Fold events into a progress snapshot (schema v1).

Two axes of progress, as decided:
  1. tasks  — Claude Code's own task list (TodoWrite / TaskCreate / TaskUpdate)
  2. git    — commits made and files touched during the session
Plus sub-agent lifecycle and plain counters.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from .parse import iso, parse_ts

ACTIVE_WINDOW_S = 120


@dataclass
class ProgressModel:
    project: str
    session: str
    user: str | None = None
    started_at: str | None = None
    last_at: str | None = None
    ended: bool = False
    versions: list[str] = field(default_factory=list)
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    commits: list[dict[str, Any]] = field(default_factory=list)
    files: dict[str, int] = field(default_factory=dict)
    agents: dict[str, dict[str, Any]] = field(default_factory=dict)
    counters: dict[str, int] = field(default_factory=lambda: {
        "prompts": 0, "say": 0, "think_ms": 0, "toolCalls": 0, "errors": 0, "agents": 0, "interrupts": 0})
    rooms: dict[str, int] = field(default_factory=dict)
    last: dict[str, Any] | None = None
    _next_task_id: int = 1
    _pending_create: list[str] = field(default_factory=list)

    def _reconcile_task_id(self, real_id: str, t: str | None) -> None:
        if not real_id or not self._pending_create:
            return
        tmp = self._pending_create.pop(0)
        task = self.tasks.pop(tmp, None)
        if task is None:
            return
        task["id"] = real_id
        existing = self.tasks.get(real_id)
        if existing:                      # an update arrived before the id was known; merge
            task["status"] = existing.get("status", task["status"])
            task["updatedAt"] = existing.get("updatedAt", t)
        self.tasks[real_id] = task

    # ---- feed ----------------------------------------------------------
    def apply(self, ev: dict[str, Any]) -> None:
        t = ev.get("t")
        if self.started_at is None:
            self.started_at = t
        self.last_at = t
        kind = ev.get("kind")
        meta = ev.get("meta") or {}
        if kind == "prompt":
            self.counters["prompts"] += 1
        elif kind == "say":
            self.counters["say"] += 1
        elif kind == "think":
            self.counters["think_ms"] += int(ev.get("dur_ms") or 0)
        elif kind == "interrupt":
            self.counters["interrupts"] += 1
        elif kind == "tool":
            self.counters["toolCalls"] += 1
            room = ev.get("room")
            if room:
                self.rooms[room] = self.rooms.get(room, 0) + 1
            self._apply_tool_meta(ev, meta)
        elif kind == "tool_err":
            self.counters["errors"] += 1
        elif kind == "tool_done" and meta.get("op") == "created":
            self._reconcile_task_id(str(meta.get("taskId", "")), t)
        elif kind == "spawn":
            aid = ev.get("ref") or ""
            self.counters["agents"] += 1
            self.agents[aid] = {"id": aid, "type": meta.get("agentType"), "text": meta.get("text") or ev.get("caption"),
                                "startedAt": t, "finishedAt": None, "status": "running"}
        elif kind == "finish":
            aid = ev.get("ref") or ""
            a = self.agents.setdefault(aid, {"id": aid, "type": meta.get("agentType"), "text": None,
                                             "startedAt": t, "finishedAt": None, "status": "running"})
            a["finishedAt"] = t
            a["status"] = "done"
            if ev.get("caption"):
                a["result"] = ev["caption"]
        elif kind == "session_end":
            self.ended = True
        if kind in ("say", "tool", "prompt", "spawn", "finish", "tool_err", "interrupt"):
            self.last = {"kind": kind, "actor": ev.get("actor"), "caption": ev.get("caption"), "t": t}

    def _apply_tool_meta(self, ev: dict[str, Any], meta: dict[str, Any]) -> None:
        t = ev.get("t")
        if "file" in meta and meta["file"]:
            self.files[meta["file"]] = self.files.get(meta["file"], 0) + 1
        if meta.get("git") == "commit":
            self.commits.append({"t": t, "msg": meta.get("msg") or ""})
        if "tasks" in meta:  # TodoWrite: the array is the whole truth
            seen = set()
            for task in meta["tasks"]:
                tid = str(task.get("id"))
                seen.add(tid)
                prev = self.tasks.get(tid)
                changed = prev is None or prev.get("status") != task.get("status") or prev.get("text") != task.get("text")
                self.tasks[tid] = {"id": tid, "text": task.get("text", ""), "status": task.get("status", "pending"),
                                   "updatedAt": t if changed else (prev or {}).get("updatedAt", t), "source": "todo"}
            for tid in [k for k, v in self.tasks.items() if v.get("source") == "todo" and k not in seen]:
                self.tasks.pop(tid)
        elif meta.get("op") == "create":
            tid = f"tmp{self._next_task_id}"          # provisional until TaskCreate's result says "#<id>"
            self._next_task_id += 1
            self._pending_create.append(tid)
            self.tasks[tid] = {"id": tid, "text": meta.get("text", ""), "status": "pending", "updatedAt": t, "source": "task"}
        elif meta.get("op") == "update":
            tid = str(meta.get("taskId", ""))
            task = self.tasks.setdefault(tid, {"id": tid, "text": "", "status": "pending", "updatedAt": t, "source": "task"})
            if meta.get("status"):
                task["status"] = meta["status"]
            if meta.get("text"):
                task["text"] = meta["text"]
            task["updatedAt"] = t

    # ---- snapshot ------------------------------------------------------
    def snapshot(self, now: float | None = None) -> dict[str, Any]:
        now = now if now is not None else time.time()
        last_ts = parse_ts(self.last_at) or 0.0
        if self.ended:
            status = "ended"
        elif now - last_ts <= ACTIVE_WINDOW_S:
            status = "active"
        else:
            status = "idle"
        tasks = sorted(self.tasks.values(), key=lambda x: (x.get("source") != "todo", _int_or(x["id"])))
        done = sum(1 for x in tasks if x.get("status") == "completed")
        return {
            "v": 1,
            "project": self.project,
            "session": self.session,
            "user": self.user,
            "status": status,
            "startedAt": self.started_at,
            "lastAt": self.last_at,
            "generatedAt": iso(now),
            "versions": list(self.versions),
            "progress": {"tasksDone": done, "tasksTotal": len(tasks),
                         "ratio": round(done / len(tasks), 3) if tasks else None},
            "tasks": tasks,
            "git": {"commits": self.commits[-50:],
                    "filesChanged": sorted(self.files, key=lambda f: -self.files[f])[:100]},
            "agents": list(self.agents.values()),
            "counters": dict(self.counters),
            "rooms": dict(self.rooms),
            "last": self.last,
        }


def _int_or(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 10**9
