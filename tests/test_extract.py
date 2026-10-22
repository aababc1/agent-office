"""Tests run against fixtures/session-sample (a real transcript, values truncated)."""
from __future__ import annotations

import glob
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
        on_disk = [json.loads(l) for c in sorted(glob.glob(os.path.join(ses, tracker.session, "events.*.jsonl"))) for l in open(c)]
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


def test_events_are_chunked(tmp_path):
    SessionTracker.CHUNK = 50
    try:
        tracker = SessionTracker(FIXTURE, str(tmp_path), project="p"); events = tracker.poll()
        chunks = sorted(glob.glob(str(tmp_path / "sessions" / tracker.session / "events.*.jsonl")))
        prog = json.load(open(tmp_path / "sessions" / (tracker.session + ".progress.json")))
        assert len(chunks) == (len(events) + 49) // 50 == prog["events"]["chunks"] and prog["events"]["count"] == len(events)
        assert sum(1 for c in chunks for _ in open(c)) == len(events)
        assert [json.loads(l)["seq"] for l in open(chunks[0])] == list(range(50))
    finally:
        SessionTracker.CHUNK = 500


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


# ---- office-emit (any server, any script) -------------------------------
def test_emit_cli_builds_pipeline_progress_and_summary(tmp_path, capsys):
    from office_extract.emit import main as emit
    d = str(tmp_path); env = ["--project", "metaCRC", "--run", "run_1", "--to", d]
    assert emit(env + ["run", "start"]) == 0
    assert emit(env + ["stage", "profiling", "--total", "40", "--unit", "samples"]) == 0
    assert emit(env + ["job", "start", "--id", "S01", "--stage", "profiling"]) == 0
    assert os.path.exists(tmp_path / ".office-running")                 # heartbeat marker while a job runs
    assert emit(env + ["job", "done", "--id", "S01", "--stage", "profiling", "--seconds", "812"]) == 0
    assert emit(env + ["job", "failed", "--id", "S02", "--stage", "profiling", "--msg", "exit 137"]) == 0
    assert emit(env + ["note", "QC 끝"]) == 0
    prog = json.load(open(tmp_path / "pipeline" / "run_1" / "progress.json"))
    assert prog["stages"]["profiling"] == {"done": 1, "total": 40, "unit": "samples", "updatedAt": prog["stages"]["profiling"]["updatedAt"]}
    assert prog["jobs"]["S01"]["status"] == "done" and prog["jobs"]["S01"]["seconds"] == 812
    assert prog["jobs"]["S02"]["status"] == "failed" and prog["counters"] == {"done": 1, "failed": 1}
    summary = json.load(open(tmp_path / "summary.json"))
    assert summary["pipeline"]["done"] == 1 and summary["pipeline"]["total"] == 40 and summary["pipeline"]["failed"] == 1
    assert emit(env + ["run", "end"]) == 0 and not os.path.exists(tmp_path / ".office-running")   # marker gone when nothing runs
    assert len(open(tmp_path / "pipeline" / "run_1" / "tasks.jsonl").read().splitlines()) == 7


# ---- office-probe (K-BDS: Nextflow trace + markers + squeue/sinfo via fake commands) ---------
def _fake_slurm(tmp_path):
    """Put fake squeue/sinfo on PATH that print the user's real K-BDS output shapes."""
    bindir = tmp_path / "bin"; bindir.mkdir()
    (bindir / "squeue").write_text("#!/bin/sh\ncat <<'EOT'\n83016|cpu32-only|metacrc-dump|RUNNING|10:43|5-00:00:00|1|cpu32-only-001\n83017|cpu32-only|metacrc-dump|RUNNING|56:14|5-00:00:00|1|cpu32-only-003\n83018|cpu64-only|metacrc-dump|PENDING|0:00|5-00:00:00|1|(Priority)\n83019|cpu64-only|nf-PROFILE|PENDING|0:00|5-00:00:00|1|(Resources)\nEOT\n")
    (bindir / "sinfo").write_text("#!/bin/sh\ncat <<'EOT'\ncpu32-only|up|5-00:00:00|2|alloc\ncpu32-only|up|5-00:00:00|3|idle\ncpu64-only|up|5-00:00:00|5|idle\ncpu64-only-m512GB|up|5-00:00:00|5|alloc\ncpu64-only-m512GB|up|5-00:00:00|3|idle\n1gpu|up|5-00:00:00|5|alloc\nEOT\n")
    for f in ("squeue", "sinfo"): os.chmod(bindir / f, 0o755)
    return str(bindir)


def test_probe_reads_markers_trace_and_slurm(tmp_path, monkeypatch):
    import time as _t
    from office_extract.probe import probe, to_pipeline_state
    proj = tmp_path / "metaCRC"; (proj / "manifest").mkdir(parents=True)
    for d in ("sra", "fastq", "qc", "merged", "logs", "run", "work"): (proj / d).mkdir()
    runs = [f"ERR{i:06d}" for i in range(1, 21)]; (proj / "manifest" / "runs_all.txt").write_text("\n".join(runs) + "\n")
    (proj / "manifest" / "samples_multirun.txt").write_text("SAMEA1\nSAMEA2\n")
    now = _t.time()
    # prefetch: 12 validated (3 of them already dumped → sra dir deleted, must still count via implied_by)
    for r in runs[:9]: (proj / "sra" / r).mkdir(); (proj / "sra" / r / ".validated").write_text("")
    for i, r in enumerate(runs[9:12]):                 # dumped runs: fastq exists, sra gone; recent completions → rate/ETA
        f = proj / "fastq" / f"{r}_1.fastq.gz"; f.write_text("x"); os.utime(f, (now - 600 * (i + 1), now - 600 * (i + 1)))
    (proj / "logs" / "dump.FAILED").write_text("ERR000020 DUMP_FAIL\nERR000011 NOT_VALIDATED\n")   # ERR000011 is actually dumped → ignored
    (proj / "logs" / "prefetch.FAILED").write_text("ERR000019 VDB_INVALID\n")
    # nextflow trace + work dir
    (proj / "run" / "trace.txt").write_text("task_id\thash\tnative_id\tname\tstatus\texit\tsubmit\tstart\tcomplete\trealtime\n"
        + "\n".join(f"{i}\tab/cd{i}\t900{i}\tWMS:PROFILE (S{i})\tCOMPLETED\t0\t2026-10-22 01:00:00\t2026-10-22 01:00:05\t2026-10-22 01:4{i}:00\t{40+i}m 2s" for i in range(1, 4))
        + "\n4\tab/cd4\t9004\tWMS:PROFILE (S4)\tFAILED\t137\t2026-10-22 01:00:00\t2026-10-22 01:00:05\t2026-10-22 01:30:00\t29m 55s\n"
        + "5\tab/cd5\t9005\tWMS:QC (S1)\tCACHED\t0\t-\t-\t-\t-\n")
    w = proj / "work" / "aa" / "bbbbbbbb"; w.mkdir(parents=True); (w / ".command.begin").write_text(""); (w / ".command.run").write_text("#!/bin/bash\n# NEXTFLOW TASK: WMS:PROFILE (S9)\n")
    w2 = proj / "work" / "aa" / "cccccccc"; w2.mkdir(parents=True); (w2 / ".command.begin").write_text(""); (w2 / ".exitcode").write_text("0")   # finished → not in flight
    (proj / "run" / ".nextflow.log").write_text("Oct-22 01:00:00.123 [main] INFO  nextflow.cli.CmdRun - N E X T F L O W  ~  version 24.10.0\nOct-22 01:00:05.000 [Task submitter] INFO  nextflow.Session - [ab/cd1] Submitted process > WMS:PROFILE (S1)\nOct-22 01:30:00.000 [Task monitor] ERROR nextflow.processor.TaskProcessor - Error executing process > 'WMS:PROFILE (S4)'\n")
    plan = {"project": "metaCRC", "paths": {"PROJ": str(proj), "RUNLIST": "$PROJ/manifest/runs_all.txt", "MULTI": "$PROJ/manifest/samples_multirun.txt", "SRA_DIR": "$PROJ/sra", "FQ_DIR": "$PROJ/fastq", "MRG_DIR": "$PROJ/merged", "LOG_DIR": "$PROJ/logs"},
            "site": {"slurm_user": "k260a01", "partitions": ["cpu64-only", "cpu64-only-m512GB", "cpu32-only"]},
            "pipeline": {"kind": "nextflow", "trace": "$PROJ/run/trace.txt", "log": "$PROJ/run/.nextflow.log", "work": "$PROJ/work"},
            "stages": [
                {"name": "prefetch", "unit": "run", "units": {"file": "$RUNLIST"}, "done": {"kind": "file", "path": "$SRA_DIR/{run}/.validated"}, "failed": {"log": "$LOG_DIR/prefetch.FAILED"}, "implied_by": "dump"},
                {"name": "dump", "unit": "run", "units": {"file": "$RUNLIST"}, "after": ["prefetch"], "done": {"kind": "file", "path": "$FQ_DIR/{run}_1.fastq.gz"}, "failed": {"log": "$LOG_DIR/dump.FAILED"}, "runner": {"kind": "slurm", "job": "metacrc-dump"}},
                {"name": "merge", "unit": "sample", "units": {"file": "$MULTI"}, "done": {"kind": "file", "path": "$MRG_DIR/{sample}_R1.fastq.gz"}},
                {"name": "profile", "unit": "sample", "done": {"kind": "nextflow", "process": ["PROFILE"]}},
            ]}
    monkeypatch.setenv("PATH", _fake_slurm(tmp_path) + os.pathsep + os.environ["PATH"])
    rep = probe(plan, "test")
    st = rep["stages"]
    assert st["dump"]["done"] == 3 and st["dump"]["total"] == 20 and st["dump"]["failed"] == {"ERR000020": "DUMP_FAIL"}
    assert st["dump"]["running"] == 2 and st["dump"]["pending"] == 1                       # from fake squeue, by job name
    assert st["dump"]["rates"]["per_h_3h"] == 1.0 and st["dump"]["eta"]["hours"] == 16.0      # 3 done in 3h → 16 remaining / 1 per h
    assert st["prefetch"]["done"] == 12 and st["prefetch"]["failed"] == {"ERR000019": "VDB_INVALID"}   # 9 markers + 3 implied by dump
    assert st["merge"]["done"] == 0 and st["merge"]["total"] == 2 and st["merge"]["eta"] is None
    assert st["profile"]["source"] == "nextflow" and st["profile"]["done"] == 3 and st["profile"]["failed"] == {"S4": "FAILED exit=137"} and st["profile"]["running"] == 1
    assert st["profile"]["taskS"]["p50"] >= 40 * 60
    assert rep["unplanned"] == {"QC": {"done": 1, "failed": 0, "running": 0, "lastAt": None, "taskS": None}}
    assert rep["nextflow"]["log"]["errors"] == 1 and rep["nextflow"]["log"]["submitted"] == 1
    cl = rep["cluster"]; assert cl["canSubmit"] is True and cl["sinfo"]["partitions"]["cpu64-only"]["idle"] == 5 and "1gpu" not in cl["sinfo"]["partitions"]
    assert cl["squeue"]["pendingReasons"] == {"Priority": 1, "Resources": 1}
    state = to_pipeline_state(rep, "test")
    assert state["rollup"]["running"] == 3 and state["counters"]["failed"] == 3 and "dump:ERR000020" in state["jobs"] and "PROFILE:S9" in state["jobs"]
    assert "doneIds" not in json.dumps(state) or isinstance(state["stages"]["dump"].get("doneIds", 0), int)   # ids never leave the site


def test_probe_without_slurm_or_trace(tmp_path, monkeypatch):
    from office_extract.probe import probe
    monkeypatch.setenv("PATH", str(tmp_path))          # no squeue/sinfo at all
    plan = {"project": "p", "paths": {"PROJ": str(tmp_path)}, "stages": [{"name": "x", "unit": "once", "done": {"kind": "file", "path": "$PROJ/out.tsv"}}]}
    rep = probe(plan, "r")
    assert rep["cluster"]["squeue"] is None and rep["cluster"]["sinfo"] is None and rep["cluster"]["canSubmit"] is None
    assert rep["stages"]["x"]["done"] == 0 and rep["rollup"]["status"] == "empty"
    (tmp_path / "out.tsv").write_text("ok")
    assert probe(plan, "r")["stages"]["x"]["done"] == 1


def test_probe_deliver_names_repo_and_sends_plan_once(tmp_path, monkeypatch):
    """A floor is gated by read access to its data repo, so the probe must name it; the plan rides along on the first push only."""
    import office_extract.probe as pr
    monkeypatch.setenv("PATH", str(tmp_path))
    plan = {"project": "p", "repo": "me/office-p", "paths": {"PROJ": str(tmp_path)},
            "stages": [{"name": "x", "unit": "once", "done": {"kind": "file", "path": "$PROJ/out.tsv"}}]}
    state = pr.to_pipeline_state(pr.probe(plan, "kbds"), "kbds")
    sent = []
    monkeypatch.setattr(pr, "post", lambda url, token, payload: sent.append(payload))
    assert pr.deliver(state, ["https://w.example"], "tok", "p", plan, send_plan=True) == 0
    assert sent[0]["repo"] == "me/office-p" and sent[0]["plan"]["stages"][0]["name"] == "x" and sent[0]["summary"]["name"] == "p"
    assert pr.deliver(state, ["https://w.example"], "tok", "p", plan, send_plan=False) == 0
    assert "plan" not in sent[1] and sent[1]["repo"] == "me/office-p"
    # file target: plan.json lands next to pipeline/<run>/progress.json for the webhook path
    out = tmp_path / "data"
    assert pr.deliver(state, [str(out)], None, "p", plan, send_plan=True) == 0
    assert json.load(open(out / "plan.json"))["repo"] == "me/office-p" and (out / "pipeline" / "kbds" / "progress.json").exists()
