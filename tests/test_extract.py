"""Tests run against fixtures/session-sample (a real transcript, values truncated)."""
from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "extractor"))

from office_extract.parse import TranscriptParser  # noqa: E402
from office_extract.progress import ProgressModel  # noqa: E402
from office_extract.rooms import bash_room, caption_for, room_for  # noqa: E402
from office_extract.sanitize import clean_text, mask_secrets, short_path  # noqa: E402
from office_extract.session import SessionTracker  # noqa: E402

FIXTURE_DIR = os.path.join(ROOT, "fixtures", "session-sample")
FIXTURE = os.path.join(FIXTURE_DIR, "a7606fa9-d0f1-5448-8d7a-c1a0026a2cf4.jsonl")
SCHEMA = json.load(open(os.path.join(ROOT, "schema", "events.v1.schema.json")))


@pytest.fixture(scope="module")
def extracted():
    with tempfile.TemporaryDirectory() as out:
        tracker = SessionTracker(FIXTURE, out, project="fixture", user="tester")
        events = tracker.poll()
        ses = os.path.join(out, "sessions")
        progress = json.load(open(os.path.join(ses, tracker.session + ".progress.json")))
        on_disk = [json.loads(l) for l in open(os.path.join(ses, tracker.session + ".events.jsonl"))]
        index = json.load(open(os.path.join(out, "index.json")))
        summary = json.load(open(os.path.join(out, "summary.json")))
        project = json.load(open(os.path.join(out, "project.json")))
        assert os.path.exists(os.path.join(out, ".office-running"))   # live marker while attached
        tracker.stop()
        running = os.path.exists(os.path.join(out, ".office-running"))
        yield events, progress, on_disk, index, summary, project, running


# ---- rooms --------------------------------------------------------------
@pytest.mark.parametrize("cmd,room", [
    ("rg -n foo src/", "archive"),
    ("cat README.md", "archive"),
    ("ls -la ~/.claude/ 2>/dev/null; echo x", "archive"),          # stderr redirect is not a file write
    ("cat a.txt > b.txt", "dev"),
    ("sed -i 's/a/b/' x.py", "dev"),
    ("mkdir -p a && cd a && git init", "dev"),
    ("curl -s https://example.com", "search"),
    ("git commit -m 'x'", "server"),
    ("python3 -c \"print('a->b')\"", "server"),                      # `->` inside quotes is not a redirect
    ("cd /x && echo hi && find . -name '*.py' | head", "archive"),   # echo is noise, find decides
    ("npm test", "server"),
])
def test_bash_room(cmd, room):
    assert bash_room(cmd) == room


def test_tool_rooms():
    assert room_for("Read", {}) == "archive"
    assert room_for("Edit", {}) == "dev"
    assert room_for("WebSearch", {}) == "search"
    assert room_for("mcp__Google_Drive__search_files", {}) == "search"
    assert room_for("TodoWrite", {}) == "meeting"
    assert room_for("AskUserQuestion", {}) == "desk"
    assert room_for("Agent", {}) == "elevator"
    assert room_for("SomethingNew", {}) == "server"


def test_captions_never_leak_absolute_paths():
    cap = caption_for("Read", {"file_path": "/home/me/secret-proj/src/app/main.py"}, "/home/me/secret-proj")
    assert cap == "app/main.py 읽는 중"
    assert "/home/" not in cap
    assert short_path("/a/b/c/d.txt") == "c/d.txt"


# ---- sanitizer ----------------------------------------------------------
def test_mask_secrets():
    assert "***" in mask_secrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    assert "AKIA" not in mask_secrets("key AKIAIOSFODNN7EXAMPLE")
    assert mask_secrets("password=hunter2") == "password=***"
    assert mask_secrets("mail me at jane.doe@example.com") == "mail me at j***@example.com"
    assert mask_secrets("plain text stays") == "plain text stays"


def test_clean_text_drops_links():
    assert clean_text("see [cowboy76](https://threads.net/@cowboy76) and https://example.com/x?y=1 now") == "see cowboy76 and 🔗 now"


def test_clean_text_strips_system_blocks_and_truncates():
    raw = "<system-reminder>hidden stuff</system-reminder>\n# Title\n- real **prompt** " + "x" * 500
    out = clean_text(raw)
    assert "hidden" not in out and "system-reminder" not in out
    assert out.startswith("Title real **prompt**")
    assert len(out) <= 120 and out.endswith("…")


# ---- parser on the fixture ---------------------------------------------
def test_events_validate_against_schema(extracted):
    events, _, on_disk, *_ = extracted
    allowed_keys = set(SCHEMA["properties"])
    kinds = set(SCHEMA["properties"]["kind"]["enum"])
    rooms = set(SCHEMA["properties"]["room"]["enum"])
    assert events == on_disk
    for ev in events:
        assert set(ev) <= allowed_keys, ev
        assert ev["v"] == 1 and ev["kind"] in kinds
        assert ev.get("room") in rooms or "room" not in ev
        assert len(ev.get("caption", "")) <= 160


def test_ordering_and_coverage(extracted):
    events, *_ = extracted
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert [e["t"] for e in events] == sorted(e["t"] for e in events)
    kinds = {e["kind"] for e in events}
    assert {"session_start", "prompt", "say", "think", "tool", "tool_done", "spawn", "finish"} <= kinds
    assert events[0]["kind"] == "session_start"


def test_unknown_record_types_are_ignored():
    p = TranscriptParser("s")
    weird = [json.dumps({"type": "queue-operation", "operation": "enqueue"}),
             json.dumps({"type": "attachment", "attachment": {"x": 1}}),
             "not json at all",
             json.dumps({"type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
                         "message": {"content": "plain string content"}})]
    evs = list(p.feed_lines(weird))
    assert [e["kind"] for e in evs] == ["say"]


def test_tool_pairing_and_durations(extracted):
    events, *_ = extracted
    starts = {e["ref"]: e for e in events if e["kind"] == "tool"}
    for e in events:
        if e["kind"] in ("tool_done", "tool_err"):
            assert e["ref"] in starts
            assert e["tool"] == starts[e["ref"]]["tool"]
            assert e.get("dur_ms", 0) >= 0
    thinks = [e for e in events if e["kind"] == "think"]
    assert thinks and all(e["dur_ms"] > 0 for e in thinks)


def test_no_tool_results_leak(extracted):
    """The biggest payloads in a transcript are tool results; none may reach the output."""
    _, _, on_disk, *_ = extracted
    blob = json.dumps(on_disk, ensure_ascii=False)
    assert "search_results" not in blob           # body of the conversation_search result
    assert "launcher-settings.json" not in blob or "읽는 중" in blob  # only as a caption
    assert "<system-reminder>" not in blob


def test_subagent_lifecycle(extracted):
    events, progress, *_ = extracted
    agent_evs = [e for e in events if e["actor"].startswith("agent:")]
    assert agent_evs[0]["kind"] == "spawn" and agent_evs[0]["room"] == "elevator"
    assert agent_evs[0]["meta"]["agentType"] == "Explore"
    assert agent_evs[-1]["kind"] == "finish"
    assert progress["agents"][0]["status"] == "done"
    assert progress["agents"][0]["startedAt"] <= progress["agents"][0]["finishedAt"]


def test_progress_tasks_use_real_ids(extracted):
    _, progress, *_ = extracted
    ids = [t["id"] for t in progress["tasks"]]
    assert ids and all(i.isdigit() for i in ids), ids   # reconciled from "Task #N created"
    assert progress["progress"]["tasksTotal"] == len(ids)
    assert progress["versions"]                           # version(s) recorded


def test_progress_todo_write_is_whole_truth():
    pm = ProgressModel("p", "s")
    pm.apply({"t": "2026-01-01T00:00:00Z", "kind": "tool", "tool": "TodoWrite", "room": "meeting",
              "meta": {"tasks": [{"id": "1", "text": "a", "status": "pending"},
                                 {"id": "2", "text": "b", "status": "in_progress"}]}})
    pm.apply({"t": "2026-01-01T00:01:00Z", "kind": "tool", "tool": "TodoWrite", "room": "meeting",
              "meta": {"tasks": [{"id": "1", "text": "a", "status": "completed"}]}})
    snap = pm.snapshot(now=1_800_000_000)                   # well after the last event
    assert [t["id"] for t in snap["tasks"]] == ["1"]       # task 2 was removed from the list
    assert snap["progress"] == {"tasksDone": 1, "tasksTotal": 1, "ratio": 1.0}
    assert snap["status"] == "idle"


def test_index_summary_project_files(extracted):
    _, progress, _, index, summary, project, running = extracted
    assert index["projects"][0]["name"] == "fixture" and index["projects"][0]["sessions"] == 1
    assert summary["name"] == "fixture" and summary["sessions"]["total"] == 1
    assert summary["sessions"]["latest"]["session"] == progress["session"]
    assert summary["emitterAt"] and summary["status"] in ("active", "idle")
    assert isinstance(summary["alerts"], list)
    assert project["sessions"][0]["title"] == progress["title"]
    assert progress["title"] and len(progress["title"]) <= 60     # first prompt becomes the session title
    assert running is False                                       # stop() removed the live marker


def test_follow_mode_is_incremental(tmp_path):
    """Append lines to a copy of the fixture while following; events must arrive incrementally."""
    lines = open(FIXTURE, encoding="utf-8").read().splitlines()
    live = tmp_path / "live.jsonl"
    live.write_text("\n".join(lines[:40]) + "\n", encoding="utf-8")
    tracker = SessionTracker(str(live), str(tmp_path / "out"), project="p")
    first = tracker.poll()
    assert first and (tmp_path / "out" / ".office-running").exists()
    assert tracker.poll() == []                           # nothing new → nothing emitted
    with open(live, "a", encoding="utf-8") as f:          # simulate Claude Code appending
        f.write("\n".join(lines[40:80]) + "\n")
    second = tracker.poll()
    assert second and second[0]["seq"] == first[-1]["seq"] + 1
