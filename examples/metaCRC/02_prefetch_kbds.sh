#!/usr/bin/env bash
# metaCRC — prefetch + vdb-validate on K-BDS (tmux on the login node), with live progress in the office.
# Source: metaCRC_runbook.sh §02 — same flags, same markers, same FAILED format, .sra kept until 03_dump
# deletes it. Added: a disk-space guard, a per-run throughput log, and an office-probe loop (every 2 min).
#
# Usage:
#   ./02_prefetch_kbds.sh env        write 00_env_local.sh (edit paths once; same variables as the runbook's 00_env.sh)
#   ./02_prefetch_kbds.sh conda      create the metacrc-dl env (sra-tools>=3.1). NOTE: K-BDS login node is CentOS 7 (glibc 2.17);
#                                    bioconda sra-tools 3.x needs glibc>=2.25 and will not run there -> use the existing `sra-tools` env (2.11.2)
#   ./02_prefetch_kbds.sh run        download+validate everything in $RUNLIST (resume-safe; run in tmux)
#   ./02_prefetch_kbds.sh retry      re-run only the runs listed in $LOG_DIR/prefetch.FAILED
#   ./02_prefetch_kbds.sh status     counts, failures, disk, throughput
#   ./02_prefetch_kbds.sh office     start the office-probe loop in tmux (needs OFFICE_TOKEN in 00_env_local.sh)
set -uo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
env)
cat > 00_env_local.sh <<'ENV'
# ── K-BDS paths (edit; same as the runbook's 00_env.sh) ────────
export PROJ=$HOME/metaCRC                 # /home01 (Lustre, no quota) — the K-BDS guide keeps user work under home
export MANIFEST=$PROJ/manifest/run_manifest.tsv
export RUNLIST=$PROJ/manifest/runs_paired.txt # PAIRED only (8,420); SINGLE excluded (runs_single_excluded.txt)
export SRA_DIR=$PROJ/sra                       # prefetch output (.sra; 03_dump deletes it after a good dump)
export LOG_DIR=$PROJ/logs
export PARALLEL=6                              # >6 and NCBI throttles (runbook)
export MIN_FREE_GB=200                         # stop launching new downloads below this

# ── office (progress → phone) ──────────────────────────────────
export OFFICE_TO=https://agent-office.hyeongwon-tg.workers.dev
export OFFICE_TOKEN=                           # Cloudflare PROJECT_TOKENS["metaCRC"]
export OFFICE_SITE=kbds
export OFFICE_PLAN=$PWD/plan.yaml

mkdir -p "$SRA_DIR" "$LOG_DIR" "$PROJ/manifest"
ENV
echo "[env] 00_env_local.sh written — edit PROJ/OFFICE_TOKEN, then: source 00_env_local.sh" ;;

conda)
conda create -y -n metacrc-dl -c conda-forge -c bioconda 'sra-tools>=3.1' pigz
conda run -n metacrc-dl prefetch --version && conda run -n metacrc-dl vdb-validate --version ;;

run|retry)
source ./00_env_local.sh
eval "$(conda shell.bash hook)"; conda activate "${DL_ENV:-sra-tools}"       # sra-tools 2.11.2 (the only build that runs on this glibc); DL_ENV=... to override
prefetch --version >/dev/null 2>&1 || { echo "prefetch does not run in env ${DL_ENV:-sra-tools} (glibc?) — try DL_ENV=sra-tools"; exit 1; }
# cache on the big disk, not $HOME (runbook)
vdb-config -s /repository/user/main/public/root="$SRA_DIR"
vdb-config -s /LIBS/GUID="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)" 2>/dev/null || true
LIST="$RUNLIST"
if [ "$1" = retry ]; then
  LIST="$PROJ/manifest/runs_retry.txt"
  cut -d' ' -f1 "$LOG_DIR/prefetch.FAILED" 2>/dev/null | sort -u > "$LIST"
  : > "$LOG_DIR/prefetch.FAILED"
  echo "[retry] $(wc -l < "$LIST") runs"
fi
fetch_one() {
  local RUN="$1" SRA="$SRA_DIR/$1/$1.sra"
  [ -s "$SRA_DIR/$RUN/.validated" ] && return 0                       # already done (resume-safe)
  # disk guard: wait while free space is below the floor
  while [ "$(df -BG --output=avail "$SRA_DIR" | tail -1 | tr -dc 0-9)" -lt "$MIN_FREE_GB" ]; do
    echo "$(date -u +%FT%TZ) $RUN waiting: free < ${MIN_FREE_GB}G" >> "$LOG_DIR/prefetch.disk.log"; sleep 300
  done
  local T0=$(date +%s)
  if [ ! -s "$SRA" ]; then
    # --max-size 999G (not `u`: 2.11 syntax); 79 runs exceed the 20G default
    prefetch --max-size 999G -O "$SRA_DIR" "$RUN" >> "$LOG_DIR/prefetch.$RUN.log" 2>&1 \
      || { echo "$RUN PREFETCH_FAIL" >> "$LOG_DIR/prefetch.FAILED"; return 1; }
  fi
  if vdb-validate "$SRA" > "$LOG_DIR/vdbval.$RUN.log" 2>&1; then
    touch "$SRA_DIR/$RUN/.validated"
    printf '%s\t%s\t%s\t%s\n' "$RUN" "$(date -u +%FT%TZ)" "$(( $(date +%s) - T0 ))" "$(stat -c %s "$SRA" 2>/dev/null || stat -f %z "$SRA")" >> "$LOG_DIR/prefetch_done.tsv"   # run, when, seconds, bytes
  else
    echo "$RUN VDB_INVALID" >> "$LOG_DIR/prefetch.FAILED"; rm -rf "$SRA_DIR/$RUN"; return 1   # corrupt → redownload on retry
  fi
}
export -f fetch_one; export SRA_DIR LOG_DIR MIN_FREE_GB
xargs -a "$LIST" -n1 -P "$PARALLEL" -I{} bash -c 'fetch_one {}'
"$0" status ;;

status)
source ./00_env_local.sh
T=$(wc -l < "$RUNLIST"); D=$(find "$SRA_DIR" -name .validated 2>/dev/null | wc -l); F=$(sort -u "$LOG_DIR/prefetch.FAILED" 2>/dev/null | wc -l)
printf 'validated %6d / %d   failed %d\n' "$D" "$T" "$F"
if [ -s "$LOG_DIR/prefetch_done.tsv" ]; then
  awk -F'\t' -v now="$(date +%s)" 'BEGIN{n=0;b=0} { cmd="date -d \""$2"\" +%s"; cmd | getline t; close(cmd); if (now-t<=3*3600){n++; b+=$4} } END{printf "last 3h: %d runs, %.1f GB → %.1f runs/h, %.2f TB/day\n", n, b/1e9, n/3, b/1e9/3*24/1000}' "$LOG_DIR/prefetch_done.tsv"
fi
df -h "$SRA_DIR" | tail -1 | awk '{print "disk: used "$3" / "$2"  free "$4}'
du -sh "$SRA_DIR" 2>/dev/null | awk '{print "sra: "$1}' ;;

office)
source ./00_env_local.sh
[ -n "$OFFICE_TOKEN" ] || { echo "set OFFICE_TOKEN in 00_env_local.sh"; exit 1; }
[ -f office_probe.py ] || { echo "office_probe.py missing: copy dist/office_probe.py here"; exit 1; }
tmux new -d -s office-metacrc "python3 $PWD/office_probe.py loop --plan $OFFICE_PLAN --site $OFFICE_SITE --every 120 --to $OFFICE_TO 2>&1 | tee -a $LOG_DIR/office-probe.log"
echo "[office] probe loop started in tmux 'office-metacrc' (every 2 min). tmux attach -t office-metacrc" ;;

*) sed -n '2,14p' "$0" ;;
esac
