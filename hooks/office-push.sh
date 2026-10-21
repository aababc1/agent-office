#!/usr/bin/env bash
# office-push.sh DATA_DIR [INTERVAL=60]
# Commit + push DATA_DIR every INTERVAL seconds while any extractor is alive, then one last time.
# Minute-level latency was the agreed target, so this is deliberately dumb and dependable.
set -uo pipefail
DATA_DIR="${1:?DATA_DIR}"; INTERVAL="${2:-60}"
cd "$DATA_DIR" || exit 0
[ -d .git ] || { echo "office-push: $DATA_DIR is not a git clone; nothing to push"; exit 0; }
git config user.name  >/dev/null 2>&1 || git config user.name  "${OFFICE_GIT_NAME:-agent-office}"
git config user.email >/dev/null 2>&1 || git config user.email "${OFFICE_GIT_EMAIL:-agent-office@users.noreply.github.com}"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

alive() { for f in .office-*.pid; do [ -f "$f" ] && kill -0 "$(cat "$f" 2>/dev/null || echo 0)" 2>/dev/null && return 0; done; return 1; }

push_once() {
  git add -A -- . ':!.office-*.log' ':!.office-*.pid' 2>/dev/null || git add -A
  git diff --cached --quiet && return 0
  git commit -qm "office: $(date -u +%FT%TZ)" || return 0
  git pull -q --rebase origin "$BRANCH" 2>/dev/null || true
  git push -q origin "$BRANCH" 2>/dev/null || echo "office-push: push failed (will retry)"
}

# first push immediately so the session appears on the floor guide at once
push_once
while alive; do
  sleep "$INTERVAL"
  push_once
done
push_once
