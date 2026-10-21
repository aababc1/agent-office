"""office-emit — report progress from any script on any machine (a local server, KBDS, a Mac).

The office does not care where work runs. Anything that can run a shell command can tell it
what happened, in one line, using the same progress model the viewer already understands.

  office-emit stage profiling --done 12 --total 40 [--unit samples] [--eta-min 90]
  office-emit job start  --id trim_S07 --stage trimming           # a unit of work started
  office-emit job done   --id trim_S07 --stage trimming [--seconds 812]
  office-emit job failed --id trim_S07 --stage trimming --msg "exit 137 (OOM)"
  office-emit note "QC 완료, 3개 샘플 탈락"                           # a line in the activity log
  office-emit run start|end --id run_2026-10-21                     # a whole pipeline run

Where it goes (pick one, or both):
  --to DATA_DIR            write pipeline/<run>/progress.json (+ tasks.jsonl) into a data-repo clone;
                           office-push.sh ships it with the usual push policy and heartbeat
  --to URL                 POST to the Worker (https://…/ingest/events) at once; needs OFFICE_TOKEN
Env: OFFICE_PROJECT, OFFICE_RUN (default: today), OFFICE_TOKEN, OFFICE_TO (default target).
Stdlib only, so it runs wherever python3 exists.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any


def iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---- local store: pipeline/<run>/progress.json ---------------------------------------------
class RunStore:
    def __init__(self, data_dir: str, project: str, run_id: str) -> None:
        self.dir = os.path.join(data_dir, "pipeline", run_id)
        self.data_dir, self.project, self.run_id = data_dir, project, run_id
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, "progress.json")
        self.state = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {"v": 1, "id": self.run_id, "project": self.project, "startedAt": iso(), "lastAt": None,
                    "status": "running", "stages": {}, "jobs": {}, "notes": [], "counters": {"done": 0, "failed": 0}}

    def save(self) -> None:
        self.state["lastAt"] = iso()
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)
        running = any(j.get("status") == "running" for j in self.state["jobs"].values()) or self.state.get("status") == "running"
        marker = os.path.join(self.data_dir, ".office-running")
        if running:
            with open(marker, "w", encoding="utf-8") as f:
                json.dump({"kind": "pipeline", "run": self.run_id, "project": self.project, "at": iso(),
                           "running": [k for k, j in self.state["jobs"].items() if j.get("status") == "running"][:20]}, f)
        elif os.path.exists(marker):
            os.remove(marker)
        self._summary()

    def _summary(self) -> None:
        """Keep summary.json's pipeline block current so the floor guide can show it without reading runs."""
        path = os.path.join(self.data_dir, "summary.json")
        try:
            with open(path, encoding="utf-8") as f:
                summary = json.load(f)
        except (OSError, json.JSONDecodeError):
            summary = {"v": 1, "name": self.project, "sessions": {"total": 0, "active": 0, "latest": None}, "alerts": []}
        st = self.state["stages"]
        done = sum(s.get("done", 0) for s in st.values()); total = sum(s.get("total", 0) for s in st.values())
        summary["pipeline"] = {"run": self.run_id, "status": self.state["status"], "lastAt": self.state["lastAt"],
                               "done": done, "total": total, "ratio": round(done / total, 3) if total else None,
                               "stages": {k: {"done": v.get("done", 0), "total": v.get("total", 0), "etaMin": v.get("etaMin")} for k, v in st.items()},
                               "running": sum(1 for j in self.state["jobs"].values() if j.get("status") == "running"),
                               "failed": self.state["counters"]["failed"]}
        summary["emitterAt"] = iso()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def append_task(self, rec: dict[str, Any]) -> None:
        with open(os.path.join(self.dir, "tasks.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")


# ---- commands --------------------------------------------------------------------------------
def apply(store: RunStore, args: argparse.Namespace) -> dict[str, Any]:
    s = store.state; now = iso(); rec: dict[str, Any] = {"t": now, "cmd": args.cmd}
    if args.cmd == "stage":
        st = s["stages"].setdefault(args.name, {"done": 0, "total": 0, "unit": "units"})
        if args.total is not None: st["total"] = args.total
        if args.done is not None: st["done"] = args.done
        if args.unit: st["unit"] = args.unit
        if args.eta_min is not None: st["etaMin"] = args.eta_min
        st["updatedAt"] = now
        rec.update(stage=args.name, done=st["done"], total=st["total"])
    elif args.cmd == "job":
        j = s["jobs"].setdefault(args.id, {"stage": args.stage, "startedAt": now, "status": "running"})
        j["stage"] = args.stage or j.get("stage")
        if args.action == "start":
            j.update(status="running", startedAt=now, endedAt=None)
        else:
            j.update(status="done" if args.action == "done" else "failed", endedAt=now)
            if args.seconds is not None: j["seconds"] = args.seconds
            elif j.get("startedAt"):
                try: j["seconds"] = round(time.time() - datetime.fromisoformat(j["startedAt"].replace("Z", "+00:00")).timestamp())
                except ValueError: pass
            if args.msg: j["msg"] = args.msg
            s["counters"]["done" if args.action == "done" else "failed"] += 1
            if args.stage and args.action == "done":
                st = s["stages"].setdefault(args.stage, {"done": 0, "total": 0, "unit": "units"}); st["done"] = st.get("done", 0) + 1; st["updatedAt"] = now
        rec.update(job=args.id, stage=args.stage, status=j["status"], seconds=j.get("seconds"), msg=args.msg)
    elif args.cmd == "note":
        s["notes"] = (s["notes"] + [{"t": now, "text": args.text[:200]}])[-50:]
        rec.update(text=args.text[:200])
    elif args.cmd == "run":
        if args.action == "start": s.update(status="running", startedAt=now)
        else: s.update(status="done")
        rec.update(status=s["status"])
    return rec


def post(url: str, token: str, payload: dict[str, Any]) -> None:
    req = urllib.request.Request(url.rstrip("/") + ("" if url.endswith("/ingest/events") else "/ingest/events"), method="POST",
                                 data=json.dumps(payload, ensure_ascii=False).encode(), headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        if r.status >= 300:
            raise RuntimeError(f"worker {r.status}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="office-emit", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=os.environ.get("OFFICE_PROJECT"), help="floor name (OFFICE_PROJECT)")
    ap.add_argument("--run", default=os.environ.get("OFFICE_RUN") or datetime.now().strftime("run_%Y-%m-%d"), help="run id (OFFICE_RUN)")
    ap.add_argument("--to", action="append", default=None, help="DATA_DIR and/or Worker URL (repeatable; OFFICE_TO)")
    ap.add_argument("--token", default=os.environ.get("OFFICE_TOKEN"), help="project write token for a Worker target (OFFICE_TOKEN)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("stage"); p.add_argument("name"); p.add_argument("--done", type=int); p.add_argument("--total", type=int); p.add_argument("--unit"); p.add_argument("--eta-min", type=float)
    p = sub.add_parser("job"); p.add_argument("action", choices=["start", "done", "failed"]); p.add_argument("--id", required=True); p.add_argument("--stage"); p.add_argument("--seconds", type=int); p.add_argument("--msg")
    p = sub.add_parser("note"); p.add_argument("text")
    p = sub.add_parser("run"); p.add_argument("action", choices=["start", "end"])
    a = ap.parse_args(argv)
    if not a.project:
        sys.stderr.write("office-emit: --project or OFFICE_PROJECT is required\n"); return 2
    targets = a.to or ([os.environ["OFFICE_TO"]] if os.environ.get("OFFICE_TO") else [])
    if not targets:
        sys.stderr.write("office-emit: --to DATA_DIR or --to https://…worker URL (or OFFICE_TO)\n"); return 2
    dirs = [t for t in targets if not t.startswith("http")]; urls = [t for t in targets if t.startswith("http")]
    # Always keep local state somewhere so counters/jobs accumulate; a URL-only target uses a scratch dir.
    store = RunStore(dirs[0] if dirs else os.path.join(os.path.expanduser("~"), ".agent-office", "emit", a.project), a.project, a.run)
    rec = apply(store, a)
    store.save(); store.append_task(rec)
    for d in dirs[1:]:
        RunStore(d, a.project, a.run).state.update(store.state)  # mirror
    for url in urls:
        if not a.token:
            sys.stderr.write("office-emit: OFFICE_TOKEN is required for a Worker target\n"); return 2
        try:
            post(url, a.token, {"project": a.project, "pipeline": store.state,
                                "summary": json.load(open(os.path.join(store.data_dir, "summary.json"), encoding="utf-8"))})
        except (urllib.error.URLError, RuntimeError, OSError) as e:
            sys.stderr.write(f"office-emit: post failed ({e}); state kept locally\n"); return 1
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
