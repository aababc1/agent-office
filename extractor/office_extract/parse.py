"""Claude Code transcript (JSONL) → Agent Office events (schema v1).

Version tolerance
- Unknown top-level `type` values are ignored (the file carries housekeeping
  records like attachment/queue-operation/mode/system/last-prompt).
- `message.content` may be a string or a list of blocks; both are handled.
- Every record's `version` is remembered so a snapshot can say which Claude
  Code versions produced it. If a new version changes a field we rely on,
  the failure shows up in tests against fixtures, not in production silence.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator

from .rooms import caption_for, room_for
from .sanitize import clean_text, short_path

INTERRUPT_MARKERS = ("[Request interrupted by user",)
SPAWN_TOOLS = {"Agent", "Task"}
FILE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
_COMMIT_MSG = re.compile(r"""-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')""")


def parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class _OpenTool:
    name: str
    started: float
    room: str


@dataclass
class TranscriptParser:
    """Stateful: feed records in file order; yields events. One per transcript file."""

    session: str
    actor: str = "claude"            # "claude" for the main transcript, "agent:<id>" for sub-agents
    include_user_text: bool = True   # the user's own prompts, truncated+masked
    seq: int = 0
    versions: list[str] = field(default_factory=list)
    open_tools: dict[str, _OpenTool] = field(default_factory=dict)
    last_ts: float | None = None
    first_ts: float | None = None
    cwd: str | None = None
    git_branch: str | None = None

    # ---- public --------------------------------------------------------
    def feed_lines(self, lines: Iterable[str]) -> Iterator[dict[str, Any]]:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                yield from self.feed_record(rec)

    def feed_record(self, rec: dict[str, Any]) -> Iterator[dict[str, Any]]:
        rtype = rec.get("type")
        if rtype not in ("user", "assistant"):
            return
        ts = parse_ts(rec.get("timestamp")) or self.last_ts or 0.0
        self._note_context(rec, ts)
        msg = rec.get("message")
        if not isinstance(msg, dict):
            return
        blocks = self._blocks(msg.get("content"))
        if rtype == "assistant":
            yield from self._assistant(rec, blocks, ts)
        else:
            yield from self._user(rec, blocks, ts)

    # ---- internals -----------------------------------------------------
    def _note_context(self, rec: dict[str, Any], ts: float) -> None:
        v = rec.get("version")
        if isinstance(v, str) and v not in self.versions:
            self.versions.append(v)
        if rec.get("cwd"):
            self.cwd = rec["cwd"]
        if rec.get("gitBranch"):
            self.git_branch = rec["gitBranch"]
        if self.first_ts is None:
            self.first_ts = ts
        self.last_ts = ts

    @staticmethod
    def _blocks(content: Any) -> list[dict[str, Any]]:
        if isinstance(content, str):
            return [{"type": "text", "text": content}]
        if isinstance(content, list):
            return [b for b in content if isinstance(b, dict)]
        return []

    def _emit(self, ts: float, kind: str, **extra: Any) -> dict[str, Any]:
        ev: dict[str, Any] = {"v": 1, "seq": self.seq, "t": iso(ts), "ses": self.session,
                              "actor": self.actor, "kind": kind}
        for k, v in extra.items():
            if v is None or v == "" or v == {}:
                continue
            ev[k] = v
        self.seq += 1
        return ev

    def _assistant(self, rec: dict[str, Any], blocks: list[dict[str, Any]], ts: float) -> Iterator[dict[str, Any]]:
        for b in blocks:
            bt = b.get("type")
            if bt == "thinking":
                dur = rec.get("thinkingDurationMs")
                yield self._emit(ts, "think", dur_ms=int(dur) if isinstance(dur, (int, float)) else None)
            elif bt == "text":
                text = clean_text(str(b.get("text", "")))
                if text:
                    yield self._emit(ts, "say", caption=text)
            elif bt == "tool_use":
                name = str(b.get("name", ""))
                tin = b.get("input") if isinstance(b.get("input"), dict) else {}
                tid = str(b.get("id", ""))
                room = room_for(name, tin)
                cap = caption_for(name, tin, self.cwd)
                meta = self._tool_meta(name, tin)
                if tid:
                    self.open_tools[tid] = _OpenTool(name, ts, room)
                yield self._emit(ts, "tool", tool=name, room=room, caption=cap, ref=tid or None, meta=meta)

    def _user(self, rec: dict[str, Any], blocks: list[dict[str, Any]], ts: float) -> Iterator[dict[str, Any]]:
        texts: list[str] = []
        for b in blocks:
            bt = b.get("type")
            if bt == "tool_result":
                tid = str(b.get("tool_use_id", ""))
                opened = self.open_tools.pop(tid, None)
                is_err = bool(b.get("is_error"))
                dur = int((ts - opened.started) * 1000) if opened and ts >= opened.started else None
                cap = None
                meta: dict[str, Any] = {}
                if is_err:
                    cap = clean_text(self._result_text(b.get("content")), 90) or "오류"
                elif opened and opened.name == "TaskCreate":
                    # Allow-listed: the only tool result we look at, and only for its "#<id>".
                    m = re.search(r"#(\d+)", self._result_text(b.get("content")))
                    if m:
                        meta = {"op": "created", "taskId": m.group(1)}
                yield self._emit(ts, "tool_err" if is_err else "tool_done",
                                 tool=opened.name if opened else None, ref=tid or None,
                                 dur_ms=dur, caption=cap, meta=meta)
            elif bt == "text":
                texts.append(str(b.get("text", "")))
        if not texts or rec.get("isMeta"):
            return
        raw = "\n".join(texts)
        if any(m in raw for m in INTERRUPT_MARKERS):
            yield self._emit(ts, "interrupt", actor="user", caption="잠깐, 멈춰!")
            return
        text = clean_text(raw)
        if not text:
            return  # system-reminder-only turns
        yield self._emit(ts, "prompt", actor="user", caption=text if self.include_user_text else "…")

    @staticmethod
    def _result_text(content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    return str(c.get("text", ""))
        return ""

    def _tool_meta(self, name: str, tin: dict[str, Any]) -> dict[str, Any]:
        """Small, non-sensitive facts the progress model needs."""
        meta: dict[str, Any] = {}
        if name in FILE_TOOLS:
            meta["file"] = short_path(str(tin.get("file_path") or tin.get("notebook_path") or ""), self.cwd)
        elif name == "Bash":
            cmd = str(tin.get("command", ""))
            if "git commit" in cmd:
                meta["git"] = "commit"
                m = _COMMIT_MSG.search(cmd)
                if m:
                    meta["msg"] = clean_text(m.group(1) or m.group(2) or "", 80)
            elif "git push" in cmd:
                meta["git"] = "push"
        elif name == "TodoWrite":
            todos = tin.get("todos") or []
            meta["tasks"] = [
                {"id": str(t.get("id") or i), "text": clean_text(str(t.get("content", "")), 60),
                 "status": str(t.get("status", "pending"))}
                for i, t in enumerate(todos) if isinstance(t, dict)
            ]
        elif name == "TaskCreate":
            meta["op"] = "create"
            meta["text"] = clean_text(str(tin.get("subject", "")), 60)
        elif name == "TaskUpdate":
            meta["op"] = "update"
            meta["taskId"] = str(tin.get("taskId", ""))
            if tin.get("status"):
                meta["status"] = str(tin["status"])
            if tin.get("subject"):
                meta["text"] = clean_text(str(tin["subject"]), 60)
        elif name in SPAWN_TOOLS:
            meta["agentType"] = str(tin.get("subagent_type") or "general-purpose")
            meta["text"] = clean_text(str(tin.get("description", "")), 60)
        return meta
