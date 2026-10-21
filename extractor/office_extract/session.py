"""SessionTracker: one Claude Code transcript (+ its sub-agent sidecar files) → output files.

Output layout (DATA_DIR is what gets pushed to GitHub):
  DATA_DIR/index.json                              floors: every project + its sessions
  DATA_DIR/<project>/project.json                  name, sessions, lastAt
  DATA_DIR/<project>/<session>.events.jsonl        appended, schema events.v1
  DATA_DIR/<project>/<session>.progress.json       rewritten atomically, schema progress.v1

Incremental: file offsets are kept in memory, so `follow` only parses new bytes.
"""
from __future__ import annotations

import glob
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

from .parse import TranscriptParser, iso
from .progress import ProgressModel
from .sanitize import basename, clean_text


@dataclass
class _Tail:
    path: str
    offset: int = 0
    buffer: str = ""

    def read_new_lines(self) -> list[str]:
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return []
        if size < self.offset:            # truncated / rewritten (handoff) → restart
            self.offset, self.buffer = 0, ""
        if size == self.offset:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            chunk = f.read(size - self.offset)
        self.offset = size
        text = self.buffer + chunk.decode("utf-8", errors="replace")
        lines = text.split("\n")
        self.buffer = lines.pop()         # last element is a partial line (or "")
        return lines


@dataclass
class _AgentState:
    id: str
    tail: _Tail
    parser: TranscriptParser
    meta_path: str
    spawned: bool = False
    finished: bool = False
    last_say: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class SessionTracker:
    def __init__(self, transcript: str, out_dir: str, project: str | None = None,
                 user: str | None = None, include_user_text: bool = True) -> None:
        self.transcript = os.path.abspath(transcript)
        self.session = basename(self.transcript).removesuffix(".jsonl")
        self.sidecar_dir = os.path.join(os.path.dirname(self.transcript), self.session)
        self.out_dir = os.path.abspath(out_dir)
        self.user = user
        self.include_user_text = include_user_text
        self.main = _Tail(self.transcript)
        self.parser = TranscriptParser(self.session, "claude", include_user_text)
        self.agents: dict[str, _AgentState] = {}
        self._project = project
        self.progress: ProgressModel | None = None
        self._events_path: str | None = None
        self._started = False
        self._seq = 0

    # ---- naming --------------------------------------------------------
    @property
    def project(self) -> str:
        if self._project:
            return self._project
        if self.parser.cwd:
            return basename(self.parser.cwd) or "project"
        return basename(os.path.dirname(self.transcript)).lstrip("-") or "project"

    # ---- one pass ------------------------------------------------------
    def poll(self) -> list[dict[str, Any]]:
        """Parse whatever is new, write outputs, return the new events."""
        new: list[dict[str, Any]] = []
        for line in self.main.read_new_lines():
            for ev in self.parser.feed_lines([line]):
                if not self._started:
                    new.append(self._session_start(ev))
                new.append(ev)
        new.extend(self._poll_agents())
        if new:
            self._write(new)
        return new

    def follow(self, interval: float = 0.5, stop_after_idle: float | None = None) -> Iterator[list[dict[str, Any]]]:
        idle_since = time.time()
        while True:
            new = self.poll()
            if new:
                idle_since = time.time()
                yield new
            elif stop_after_idle and time.time() - idle_since > stop_after_idle:
                return
            time.sleep(interval)

    # ---- sub-agents ----------------------------------------------------
    def _poll_agents(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        pattern = os.path.join(self.sidecar_dir, "subagents", "agent-*.jsonl")
        for path in sorted(glob.glob(pattern)):
            aid = basename(path).removeprefix("agent-").removesuffix(".jsonl")
            st = self.agents.get(aid)
            if st is None:
                st = _AgentState(aid, _Tail(path), TranscriptParser(self.session, f"agent:{aid}", self.include_user_text),
                                 path.removesuffix(".jsonl") + ".meta.json")
                self.agents[aid] = st
            self._load_meta(st)
            fresh: list[dict[str, Any]] = []
            for line in st.tail.read_new_lines():
                for ev in st.parser.feed_lines([line]):
                    if ev["kind"] == "prompt":
                        continue                      # the parent's delegation text, already in `spawn`
                    if ev["kind"] == "say":
                        st.last_say = ev.get("caption")
                    fresh.append(ev)
            if not st.spawned:                        # spawn is stamped with the agent's first record time
                st.spawned = True
                first_ts = st.parser.first_ts or self.parser.last_ts or time.time()
                out.append(self._spawn_event(st, first_ts))
            out.extend(fresh)
            if st.meta.get("finished") and not st.finished:
                st.finished = True
                out.append(self._finish_event(st))
        return out

    @staticmethod
    def _load_meta(st: _AgentState) -> None:
        try:
            with open(st.meta_path, encoding="utf-8") as f:
                st.meta = json.load(f)
        except (OSError, json.JSONDecodeError):
            pass

    def _spawn_event(self, st: _AgentState, ts: float) -> dict[str, Any]:
        return self._stamp({"kind": "spawn", "actor": f"agent:{st.id}", "room": "elevator", "ref": st.id,
                            "caption": clean_text(str(st.meta.get("description", "")), 60) or "출근",
                            "meta": {"agentType": st.meta.get("agentType"), "text": clean_text(str(st.meta.get("description", "")), 60),
                                     "parentRef": st.meta.get("toolUseId"), "model": st.meta.get("model")}}, ts)

    def _finish_event(self, st: _AgentState) -> dict[str, Any]:
        ts = st.parser.last_ts or time.time()
        return self._stamp({"kind": "finish", "actor": f"agent:{st.id}", "room": "elevator", "ref": st.id,
                            "caption": st.last_say or "👋 퇴근합니다!",
                            "meta": {"agentType": st.meta.get("agentType")}}, ts)

    def _session_start(self, first: dict[str, Any]) -> dict[str, Any]:
        """Emitted once; shares the first event's timestamp so a stable sort keeps it first."""
        self._started = True
        ts = self.parser.first_ts or time.time()
        return self._stamp({"kind": "session_start", "actor": "claude", "room": "desk",
                            "meta": {"cwd": basename(self.parser.cwd or ""), "gitBranch": self.parser.git_branch,
                                     "version": (self.parser.versions or [None])[0]}}, ts)

    def _stamp(self, ev: dict[str, Any], ts: float) -> dict[str, Any]:
        full = {"v": 1, "seq": 0, "t": iso(ts), "ses": self.session}
        full.update({k: v for k, v in ev.items() if v not in (None, "", {})})
        if "meta" in full:
            full["meta"] = {k: v for k, v in full["meta"].items() if v not in (None, "")}
            if not full["meta"]:
                full.pop("meta")
        return full

    # ---- output --------------------------------------------------------
    def _write(self, events: list[dict[str, Any]]) -> None:
        proj_dir = os.path.join(self.out_dir, self.project)
        os.makedirs(proj_dir, exist_ok=True)
        mode = "a"
        if self.progress is None:
            self.progress = ProgressModel(self.project, self.session, self.user)
            self._events_path = os.path.join(proj_dir, f"{self.session}.events.jsonl")
            mode = "w"                                # a (re)start re-derives from the transcript
        self.progress.versions = list(self.parser.versions)
        events.sort(key=lambda e: e["t"])             # stable: main/agent interleave by time
        with open(self._events_path, mode, encoding="utf-8") as f:
            for ev in events:
                ev["seq"] = self._seq                 # tracker owns the final order
                self._seq += 1
                self.progress.apply(ev)
                f.write(json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n")
        _atomic_json(os.path.join(proj_dir, f"{self.session}.progress.json"), self.progress.snapshot())
        self._write_indexes(proj_dir)

    def _write_indexes(self, proj_dir: str) -> None:
        sessions = []
        for p in sorted(glob.glob(os.path.join(proj_dir, "*.progress.json"))):
            try:
                with open(p, encoding="utf-8") as f:
                    s = json.load(f)
                sessions.append({"session": s["session"], "status": s["status"], "lastAt": s["lastAt"],
                                 "startedAt": s["startedAt"], "progress": s.get("progress"),
                                 "last": (s.get("last") or {}).get("caption")})
            except (OSError, KeyError, json.JSONDecodeError):
                continue
        sessions.sort(key=lambda s: s.get("lastAt") or "", reverse=True)
        _atomic_json(os.path.join(proj_dir, "project.json"),
                     {"v": 1, "name": self.project, "sessions": sessions,
                      "lastAt": sessions[0]["lastAt"] if sessions else None})
        projects = []
        for p in sorted(glob.glob(os.path.join(self.out_dir, "*", "project.json"))):
            try:
                with open(p, encoding="utf-8") as f:
                    pj = json.load(f)
                projects.append({"name": pj["name"], "sessions": len(pj["sessions"]), "lastAt": pj.get("lastAt"),
                                 "active": sum(1 for s in pj["sessions"] if s.get("status") == "active")})
            except (OSError, KeyError, json.JSONDecodeError):
                continue
        projects.sort(key=lambda p: p.get("lastAt") or "", reverse=True)
        _atomic_json(os.path.join(self.out_dir, "index.json"),
                     {"v": 1, "generatedAt": iso(time.time()), "projects": projects})


def _atomic_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
