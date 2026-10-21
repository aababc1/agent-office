#!/usr/bin/env bash
# office-start.sh — start the Agent Office extractor for the *current* Claude Code session.
#
# Works as a Claude Code SessionStart hook (reads the hook JSON on stdin) and as a
# plain command Claude can run at the start of a session ("bash office-start.sh").
# It never blocks the session: everything is launched detached and returns at once.
#
# Env (all optional):
#   OFFICE_SRC        path to a checkout of agent-office (default: alongside this script)
#   OFFICE_DATA_REPO  git URL of the data repo (private). If set, DATA_DIR is a clone of it
#                     and office-push.sh commits+pushes every OFFICE_PUSH_EVERY seconds.
#   OFFICE_DATA_DIR   where data files are written (default: ~/.agent-office/data)
#   OFFICE_PROJECT    floor name (default: basename of the session cwd)
#   OFFICE_USER       who is running (default: $USER)
#   OFFICE_PUSH_EVERY longest wait between pushes while busy (default 180; 0 disables the pusher).
#                     Pushes are event-driven: a quiet 20s after new records, or MAX seconds, never while idle.
#   OFFICE_PUSH=0     disable pushing even if OFFICE_DATA_REPO is set
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFICE_SRC="${OFFICE_SRC:-$(dirname "$HERE")}"
OFFICE_DATA_DIR="${OFFICE_DATA_DIR:-$HOME/.agent-office/data}"
OFFICE_PUSH_EVERY="${OFFICE_PUSH_EVERY:-180}"
LOG_DIR="${OFFICE_DATA_DIR%/}"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/.office-start.log"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"; }

# 1) data dir: clone the data repo if asked and not yet present
if [ -n "${OFFICE_DATA_REPO:-}" ] && [ ! -d "$OFFICE_DATA_DIR/.git" ]; then
  rm -rf "$OFFICE_DATA_DIR.tmp"
  if git clone -q --depth 1 "$OFFICE_DATA_REPO" "$OFFICE_DATA_DIR.tmp" 2>>"$LOG"; then
    # keep any files already written locally
    if [ -d "$OFFICE_DATA_DIR" ]; then cp -a "$OFFICE_DATA_DIR/." "$OFFICE_DATA_DIR.tmp/" 2>/dev/null || true; rm -rf "$OFFICE_DATA_DIR"; fi
    mv "$OFFICE_DATA_DIR.tmp" "$OFFICE_DATA_DIR"
    log "cloned $OFFICE_DATA_REPO"
  else
    log "clone failed; writing locally only"
    rm -rf "$OFFICE_DATA_DIR.tmp"
  fi
fi

# 2) hook payload: stdin JSON if we are a hook, otherwise synthesize from the newest transcript
PAYLOAD=""
if [ -n "${1:-}" ]; then
  PAYLOAD="{\"transcript_path\":\"$1\",\"cwd\":\"$PWD\"}"
elif [ ! -t 0 ]; then
  PAYLOAD="$(cat || true)"
fi
if [ -z "$PAYLOAD" ] || ! printf '%s' "$PAYLOAD" | grep -q transcript_path; then
  NEWEST="$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 || true)"
  [ -z "$NEWEST" ] && { log "no transcript found under ~/.claude/projects"; exit 0; }
  PAYLOAD="{\"transcript_path\":\"$NEWEST\",\"cwd\":\"$PWD\"}"
fi

# 3) launch the follower (+ pusher) detached
ARGS=(hook --out "$OFFICE_DATA_DIR" --push-every "$OFFICE_PUSH_EVERY")
[ -n "${OFFICE_PROJECT:-}" ] && ARGS+=(--project "$OFFICE_PROJECT")
[ -n "${OFFICE_USER:-}" ] && ARGS+=(--user "$OFFICE_USER")
printf '%s' "$PAYLOAD" | PYTHONPATH="$OFFICE_SRC/extractor" python3 -m office_extract.cli "${ARGS[@]}" >>"$LOG" 2>&1
log "started for $(printf '%s' "$PAYLOAD" | sed 's/.*transcript_path":"\([^"]*\)".*/\1/')"
exit 0
