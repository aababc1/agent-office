#!/usr/bin/env bash
# office-push.sh DATA_DIR [MAX_SECONDS=180]
# Push policy (event-driven, not a fixed timer):
#   - nothing changed            → nothing happens (idle sessions cost zero pushes)
#   - changed + quiet for QUIET s → push now (a turn just ended: the office is in a "watchable" state)
#   - changed but never quiet    → push anyway every MAX s (long tool bursts still surface)
#   - extractor gone             → one final push, exit
#   - long job running (KBDS)    → heartbeat push every HEARTBEAT s so "alive since 3h" can be told from "died"
#                                  (the emitter keeps a `.office-running` file while a job runs; removed when none runs)
# Env: OFFICE_PUSH_QUIET (default 20), OFFICE_PUSH_TICK (default 15), OFFICE_HEARTBEAT (default 1800, 0 = off),
#      OFFICE_GIT_NAME/EMAIL.
set -uo pipefail
DATA_DIR="${1:?DATA_DIR}"; MAX="${2:-${OFFICE_PUSH_MAX:-180}}"; QUIET="${OFFICE_PUSH_QUIET:-20}"; TICK="${OFFICE_PUSH_TICK:-15}"; HEARTBEAT="${OFFICE_HEARTBEAT:-1800}"
cd "$DATA_DIR" || exit 0
[ -d .git ] || { echo "office-push: $DATA_DIR is not a git clone; nothing to push"; exit 0; }
git config user.name  >/dev/null 2>&1 || git config user.name  "${OFFICE_GIT_NAME:-agent-office}"
git config user.email >/dev/null 2>&1 || git config user.email "${OFFICE_GIT_EMAIL:-agent-office@users.noreply.github.com}"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

alive() { for f in .office-*.pid; do [ -f "$f" ] && kill -0 "$(cat "$f" 2>/dev/null || echo 0)" 2>/dev/null && return 0; done; return 1; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
newest_change() {   # epoch of the most recently written data file (ignores .git and the pusher's own bookkeeping)
  local best=0 t
  while IFS= read -r f; do t=$(mtime "$f"); [ "$t" -gt "$best" ] && best=$t; done < <(find . -path ./.git -prune -o -type f ! -name '.office-*' -print)
  echo "$best"
}
dirty() { git add -A -- . ':!.office-*.log' ':!.office-*.pid' 2>/dev/null || git add -A; ! git diff --cached --quiet; }
summary() {   # "+N events" across staged event files, for the commit message
  local n; n=$(git diff --cached --numstat -- '*.events.jsonl' 2>/dev/null | awk '{s+=$1} END{print s+0}'); [ "$n" -gt 0 ] && echo "+$n events" || echo "snapshot"
}
unpushed=0
push_now() {
  if dirty; then git commit -qm "office: $(date -u +%FT%TZ) $(summary)" >/dev/null 2>&1 && unpushed=1; fi
  [ "$unpushed" = 1 ] || return 0
  git pull -q --rebase origin "$BRANCH" 2>/dev/null || true
  if git push -q origin "$BRANCH" 2>/dev/null; then unpushed=0; last_push=$(date +%s); else echo "office-push: push failed (will retry)"; fi
}

last_push=$(date +%s)
push_now                                   # first push at once so the floor guide lights up
while alive; do
  sleep "$TICK"
  now=$(date +%s)
  if [ "$unpushed" = 1 ] || dirty; then
    quiet=$(( now - $(newest_change) ))
    since=$(( now - last_push ))
    if [ "$unpushed" = 1 ] || [ "$quiet" -ge "$QUIET" ] || [ "$since" -ge "$MAX" ]; then push_now; fi
  elif [ "$HEARTBEAT" -gt 0 ] && [ -f .office-running ] && [ $(( now - last_push )) -ge "$HEARTBEAT" ]; then
    printf '{"v":1,"at":"%s","running":%s}\n' "$(date -u +%FT%TZ)" "$(cat .office-running 2>/dev/null || echo '{}')" > heartbeat.json
    push_now
  fi
done
push_now
