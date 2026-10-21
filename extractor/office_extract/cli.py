"""office-extract — turn a Claude Code transcript into Agent Office data files.

  office-extract once   TRANSCRIPT.jsonl --out DATA_DIR [--project NAME] [--user NAME]
  office-extract follow TRANSCRIPT.jsonl --out DATA_DIR [--interval 0.5] [--idle-exit 3600]
  office-extract hook   --out DATA_DIR            # reads the SessionStart hook JSON on stdin

Zero tokens: this is a file reader. Nothing in DATA_DIR contains tool results,
file contents or full messages — only short, masked captions (see sanitize.py).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from .session import SessionTracker


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="office-extract", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser, with_transcript: bool = True) -> None:
        if with_transcript:
            p.add_argument("transcript", help="path to <session>.jsonl")
        p.add_argument("--out", required=True, help="DATA_DIR (the folder that gets pushed)")
        p.add_argument("--project", help="floor name; default = basename of the session cwd")
        p.add_argument("--user", default=os.environ.get("OFFICE_USER") or os.environ.get("USER"))
        p.add_argument("--no-user-text", action="store_true", help="hide the user's prompt text (show '…')")
        p.add_argument("--print", action="store_true", help="also print events to stdout")

    p_once = sub.add_parser("once", help="parse the whole file once");   common(p_once)
    p_follow = sub.add_parser("follow", help="tail the file until killed"); common(p_follow)
    p_follow.add_argument("--interval", type=float, default=0.5)
    p_follow.add_argument("--idle-exit", type=float, default=None, help="exit after N seconds without new lines")
    p_hook = sub.add_parser("hook", help="SessionStart hook entry: spawn `follow` in the background"); common(p_hook, False)
    p_hook.add_argument("--interval", type=float, default=0.5)
    p_hook.add_argument("--push-every", type=int, default=60, help="seconds between git pushes (0 = no pusher)")

    a = ap.parse_args(argv)
    if a.cmd == "hook":
        return _hook(a)

    tracker = SessionTracker(a.transcript, a.out, a.project, a.user, include_user_text=not a.no_user_text)
    if a.cmd == "once":
        events = tracker.poll()
        _report(tracker, events, a.print)
        return 0
    try:
        for batch in tracker.follow(a.interval, a.idle_exit):
            _report(tracker, batch, a.print)
    except KeyboardInterrupt:
        pass
    return 0


def _report(tracker: SessionTracker, events: list[dict], do_print: bool) -> None:
    if do_print:
        for ev in events:
            sys.stdout.write(json.dumps(ev, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    elif events:
        sys.stderr.write(f"[office] {tracker.project}/{tracker.session}: +{len(events)} events\n")


def _hook(a: argparse.Namespace) -> int:
    """Claude Code SessionStart hook. Reads {session_id, transcript_path, cwd, ...} from stdin,
    launches a detached `follow` (and optionally the git pusher) and returns immediately so the
    session is never blocked. Idempotent per transcript: a lock file prevents duplicates."""
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        payload = {}
    transcript = payload.get("transcript_path")
    if not transcript:
        # Fallback: ~/.claude/projects/<encoded cwd>/<session_id>.jsonl
        sid, cwd = payload.get("session_id"), payload.get("cwd") or os.getcwd()
        enc = cwd.replace("/", "-")
        transcript = os.path.expanduser(f"~/.claude/projects/{enc}/{sid}.jsonl") if sid else None
    if not transcript:
        sys.stderr.write("[office] hook: no transcript_path in payload; nothing to do\n")
        return 0
    os.makedirs(a.out, exist_ok=True)
    lock = os.path.join(a.out, ".office-" + os.path.basename(transcript).removesuffix(".jsonl") + ".pid")
    if os.path.exists(lock):
        try:
            os.kill(int(open(lock).read().strip() or 0), 0)
            return 0  # already running for this transcript
        except (OSError, ValueError):
            pass
    cmd = [sys.executable, "-m", "office_extract.cli", "follow", transcript, "--out", a.out,
           "--interval", str(a.interval)]
    if a.project:
        cmd += ["--project", a.project]
    if a.user:
        cmd += ["--user", a.user]
    if a.no_user_text:
        cmd += ["--no-user-text"]
    log = open(os.path.join(a.out, ".office-follow.log"), "ab")
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                            start_new_session=True, env={**os.environ, "PYTHONPATH": _pkg_root()})
    with open(lock, "w") as f:
        f.write(str(proc.pid))
    if a.push_every > 0 and os.environ.get("OFFICE_PUSH", "1") != "0":
        pusher = os.path.join(os.path.dirname(_pkg_root()), "hooks", "office-push.sh")
        if os.path.exists(pusher):
            subprocess.Popen(["bash", pusher, a.out, str(a.push_every)], stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, start_new_session=True)
    return 0


def _pkg_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


if __name__ == "__main__":
    sys.exit(main())
