#!/usr/bin/env bash
# metaCRC — §03 dump on K-BDS: fasterq-dump → fastq.gz, fed continuously as prefetch finishes (no waiting for all 8,420).
# Agreed 2026-10-23: fasterq-dump default split mode (= split-3), 4 threads per run, pigz, verify (gzip -t), cohort subfolders
# $FQ_DIR/<BioProject>/<run>_{1,2}.fastq.gz, delete $SRA_DIR/<run> after a verified dump, everything (temp too) under $HOME.
# Node packing (K-BDS = exclusive nodes, node-hour billing): 1 sbatch = 1 node, PER_NODE runs at a time × THREADS each.
# Failure codes as in the runbook: NOT_VALIDATED | NO_SRA | DUMP_FAIL  → $LOG_DIR/dump.FAILED ("<run> <code>").
#
# Usage (login node, ~/office):
#   ./03_dump_kbds.sh pending            runs ready for dump, by cohort (validated, no fastq, not FAILED, not in a live chunk)
#   ./03_dump_kbds.sh submit [N]         submit up to N node jobs now (default: what pending needs, ≤ DUMP_MAX_NODES − live)
#   ./03_dump_kbds.sh feed               loop in tmux: every DUMP_FEED_S, sweep finished chunks and submit for what is pending
#   ./03_dump_kbds.sh status             per-cohort counts, live jobs, throughput, failures
#   ./03_dump_kbds.sh retry              forget dump.FAILED (keeps a copy) so those runs become pending again
#   ./03_dump_kbds.sh node <chunk>       (what sbatch runs) xargs -P PER_NODE over the chunk's runs
#   ./03_dump_kbds.sh one <run>          (one run; called by `node`)
# Knobs (export in 00_env_local.sh or the environment): DUMP_PART=cpu32-only DUMP_THREADS=4 DUMP_PER_NODE=(cores/threads)
#   DUMP_CHUNK=160 (runs per node job) DUMP_MAX_NODES=5 DUMP_MIN_BATCH=16 DUMP_FEED_S=600 DUMP_TIME=24:00:00 DL_ENV=sra-tools
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${USER:=$(id -un)}"
: "${FQ_DIR:=$PROJ/fastq}" "${TMP_DIR:=$PROJ/tmp}" "${DL_ENV:=sra-tools}"
: "${DUMP_PART:=cpu32-only}" "${DUMP_THREADS:=4}" "${DUMP_CHUNK:=160}" "${DUMP_MAX_NODES:=5}" "${DUMP_MIN_BATCH:=16}" "${DUMP_FEED_S:=600}" "${DUMP_TIME:=24:00:00}"
JOB=metacrc-dump
CH="$PROJ/manifest/dump_chunks"; MAP="$PROJ/manifest/run_cohort.tsv"; FAILED="$LOG_DIR/dump.FAILED"; DONE_TSV="$LOG_DIR/dump_done.tsv"
mkdir -p "$FQ_DIR" "$TMP_DIR" "$LOG_DIR/dump" "$LOG_DIR/slurm" "$CH"

# run → cohort map from the manifest (header names, not column numbers); rebuilt when the manifest is newer
mkmap() {
  if [ ! -s "$MAP" ] || [ "$MANIFEST" -nt "$MAP" ]; then
    awk -F'\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="run_accession")r=i;if($i=="cohort_accession")c=i};next} r&&c&&$r!=""{print $r"\t"$c}' "$MANIFEST" > "$MAP.tmp" && mv "$MAP.tmp" "$MAP"
  fi
}
cohort_of() { awk -F'\t' -v r="$1" '$1==r{print $2;exit}' "$MAP"; }

# chunk bookkeeping: $CH/chunk.<id>.txt + chunk.<id>.job (sbatch id) + chunk.<id>.done (node finished)
live_jobs() { squeue -h -u "$USER" -n "$JOB" -o '%i' 2>/dev/null; }
sweep() {   # a chunk whose job is gone from squeue is finished (or died): its runs without fastq become pending again
  local live; live="$(live_jobs | tr '\n' ' ')"
  for j in "$CH"/chunk.*.job; do
    [ -f "$j" ] || continue
    local id; id="$(cat "$j")"; case " $live " in *" $id "*) continue;; esac
    local base="${j%.job}"; mkdir -p "$CH/finished"; mv "$base".* "$CH/finished/" 2>/dev/null
  done
}
inflight() { cat "$CH"/chunk.*.txt 2>/dev/null | sort -u; }

validated_runs() { find "$SRA_DIR" -mindepth 2 -maxdepth 2 -name .validated -printf '%h\n' 2>/dev/null | awk -F/ '{print $NF}'; }
dumped_runs()    { find "$FQ_DIR" -mindepth 2 -maxdepth 2 -name '*_1.fastq.gz' -printf '%f\n' 2>/dev/null | sed 's/_1\.fastq\.gz$//'; }
pending_list() {   # stdout: "<run>\t<cohort>" sorted by cohort (manifest order inside a cohort). Two finds, no per-run stat.
  mkmap; sweep
  local fl inf va du; fl="$(mktemp)"; inf="$(mktemp)"; va="$(mktemp)"; du="$(mktemp)"
  cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"; inflight > "$inf"; validated_runs > "$va"; dumped_runs > "$du"
  awk -F'\t' -v L="$RUNLIST" -v FL="$fl" -v IN="$inf" -v VA="$va" -v DU="$du" '
    BEGIN{ while((getline l < L)>0){ if(l!="" && l!~/^#/) want[l]=1 } while((getline l < FL)>0) bad[l]=1; while((getline l < IN)>0) inflt[l]=1
           while((getline l < VA)>0) val[l]=1; while((getline l < DU)>0) dmp[l]=1 }
    ($1 in want) && ($1 in val) && !($1 in dmp) && !($1 in bad) && !($1 in inflt) { print $1"\t"$2 }' "$MAP" | sort -s -k2,2
  rm -f "$fl" "$inf" "$va" "$du"
}

node_cores() { sinfo -h -p "$DUMP_PART" -o '%c' 2>/dev/null | head -1; }

submit() {
  local want="${1:-0}" live n pend
  pend="$(mktemp)"; pending_list > "$pend"; n=$(wc -l < "$pend")
  live=$(live_jobs | wc -l)
  local room=$(( DUMP_MAX_NODES - live )); [ "$room" -lt 0 ] && room=0
  local need=$(( (n + DUMP_CHUNK - 1) / DUMP_CHUNK ))
  [ "$want" -gt 0 ] && [ "$want" -lt "$need" ] && need=$want
  [ "$need" -gt "$room" ] && need=$room
  echo "[submit] pending $n runs · live jobs $live · submitting $need node job(s) on $DUMP_PART (chunk ≤ $DUMP_CHUNK)"
  local k=0; local cores; cores="$(node_cores)"; [ -n "$cores" ] || cores=32
  while [ "$k" -lt "$need" ]; do
    local id f; id="$(date +%Y%m%d-%H%M%S)-$RANDOM"; f="$CH/chunk.$id.txt"
    sed -n "$(( k * DUMP_CHUNK + 1 )),$(( (k + 1) * DUMP_CHUNK ))p" "$pend" | cut -f1 > "$f"
    [ -s "$f" ] || { rm -f "$f"; break; }
    local jid; jid=$(sbatch --parsable -J "$JOB" -p "$DUMP_PART" -N 1 -n 1 -c "$cores" --exclusive -t "$DUMP_TIME" \
                     -o "$LOG_DIR/slurm/dump-%j.out" --wrap "bash '$SELF' node '$f'" 2>&1) || { echo "[submit] sbatch failed: $jid"; rm -f "$f"; break; }
    echo "$jid" > "$CH/chunk.$id.job"
    echo "  job $jid ← $(wc -l < "$f") runs ($(cut -f2 <(grep -F -w -f "$f" "$MAP") | sort | uniq -c | sort -rn | head -3 | awk '{printf "%s×%s ",$2,$1}'))"
    k=$((k + 1))
  done
  rm -f "$pend"
}

one() {   # one run on a compute node — the per-run recipe (§03)
  local RUN="$1" COH; COH="$(cohort_of "$RUN")"; [ -n "$COH" ] || COH=_
  local SRA="$SRA_DIR/$RUN/$RUN.sra" OUT="$FQ_DIR/$COH" T="$TMP_DIR/$RUN" LOG="$LOG_DIR/dump/$RUN.log"
  fail() { echo "$RUN $1" >> "$FAILED"; echo "$(date -u +%FT%TZ) FAIL $1" >> "$LOG"; rm -rf "$T"; return 1; }
  [ -s "$OUT/${RUN}_1.fastq.gz" ] && [ -s "$OUT/${RUN}_2.fastq.gz" ] && return 0      # already dumped (resume-safe)
  [ -s "$SRA" ] || fail NO_SRA || return 1
  [ -f "$SRA_DIR/$RUN/.validated" ] || fail NOT_VALIDATED || return 1
  mkdir -p "$OUT" "$T"; rm -rf "$T"/*; local T0; T0=$(date +%s)
  echo "$(date -u +%FT%TZ) start $RUN cohort=$COH host=$(hostname)" >> "$LOG"
  # fasterq-dump 2.11.2: default split mode is split-3 (_1/_2 + leftover unpaired, which is dropped below)
  fasterq-dump --threads "$DUMP_THREADS" --temp "$T" --outdir "$T" "$SRA" >> "$LOG" 2>&1 || fail DUMP_FAIL || return 1
  [ -s "$T/${RUN}_1.fastq" ] && [ -s "$T/${RUN}_2.fastq" ] || fail DUMP_FAIL || return 1
  rm -f "$T/$RUN.fastq"
  local GZ="gzip"; command -v pigz >/dev/null 2>&1 && GZ="pigz -p $DUMP_THREADS"
  $GZ "$T/${RUN}_2.fastq" && $GZ "$T/${RUN}_1.fastq" || fail DUMP_FAIL || return 1
  gzip -t "$T/${RUN}_1.fastq.gz" && gzip -t "$T/${RUN}_2.fastq.gz" || fail DUMP_FAIL || return 1
  mv "$T/${RUN}_2.fastq.gz" "$OUT/${RUN}_2.fastq.gz" && mv "$T/${RUN}_1.fastq.gz" "$OUT/${RUN}_1.fastq.gz" || fail DUMP_FAIL || return 1   # _1 last = the marker
  local B; B=$(( $(stat -c %s "$OUT/${RUN}_1.fastq.gz") + $(stat -c %s "$OUT/${RUN}_2.fastq.gz") ))
  rm -rf "$T" "$SRA_DIR/$RUN"                                                          # runbook: .sra goes once the dump is verified
  printf '%s\t%s\t%s\t%s\t%s\n' "$RUN" "$(date -u +%FT%TZ)" "$(( $(date +%s) - T0 ))" "$B" "$COH" >> "$DONE_TSV"
  echo "$(date -u +%FT%TZ) done $RUN $(( $(date +%s) - T0 ))s $B bytes" >> "$LOG"
}

case "${1:-}" in
pending) pending_list | awk -F'\t' '{n[$2]++} END{for(c in n) printf "%6d  %s\n", n[c], c}' | sort -rn; echo "total $(pending_list | wc -l)" ;;
submit)  submit "${2:-0}" ;;
feed)
  echo "[feed] every ${DUMP_FEED_S}s: sweep + submit (≤ $DUMP_MAX_NODES nodes on $DUMP_PART, chunk $DUMP_CHUNK, min batch $DUMP_MIN_BATCH)"
  while true; do
    n=$(pending_list | wc -l); live=$(live_jobs | wc -l)
    if { [ "$n" -ge "$DUMP_MIN_BATCH" ] || { [ "$n" -gt 0 ] && [ "$live" -eq 0 ]; }; } && [ "$live" -lt "$DUMP_MAX_NODES" ]; then submit 0; else echo "$(date -u +%FT%TZ) pending $n · live $live · nothing to do"; fi
    sleep "$DUMP_FEED_S"
  done ;;
status)
  mkmap; sweep
  T=$(wc -l < "$RUNLIST"); V=$(find "$SRA_DIR" -maxdepth 2 -name .validated 2>/dev/null | wc -l); D=$(find "$FQ_DIR" -mindepth 2 -maxdepth 2 -name '*_1.fastq.gz' 2>/dev/null | wc -l); F=$(sort -u "$FAILED" 2>/dev/null | wc -l)
  printf 'dumped %6d / %d   validated-waiting %d   failed %d   inflight %d\n' "$D" "$T" "$(pending_list | wc -l)" "$F" "$(inflight | wc -l)"
  echo "jobs:"; squeue -u "$USER" -n "$JOB" -h -o '  %i %T %M %N %r' 2>/dev/null
  if [ -s "$DONE_TSV" ]; then awk -F'\t' -v now="$(date +%s)" '{cmd="date -d \""$2"\" +%s"; cmd|getline t; close(cmd); if(now-t<=3600){n++;b+=$4}} END{printf "last 1h: %d runs, %.1f GB fastq.gz → %d runs/h\n", n, b/1e9, n}' "$DONE_TSV"; fi
  echo "by cohort (dumped / paired runs):"; du="$(mktemp)"; dumped_runs > "$du"
  awk -F'\t' -v L="$RUNLIST" -v DU="$du" 'BEGIN{while((getline l<L)>0) want[l]=1; while((getline l<DU)>0) dmp[l]=1} ($1 in want){tot[$2]++; if($1 in dmp) d[$2]++} END{for(c in tot) printf "  %-14s %5d / %5d%s\n", c, d[c]+0, tot[c], (d[c]==tot[c]?"  ✓":"")}' "$MAP" | sort -k4 -rn; rm -f "$du"
  [ -s "$FAILED" ] && { echo "failed reasons:"; awk '{print $2}' "$FAILED" | sort | uniq -c; } ;;
retry)   [ -s "$FAILED" ] && { cp "$FAILED" "$FAILED.$(date +%Y%m%d-%H%M%S)"; : > "$FAILED"; echo "[retry] FAILED cleared (copy kept); they are pending again — feed/submit picks them up"; } || echo "nothing failed" ;;
node)
  # batch jobs do not read .bashrc: find conda by path
  if ! command -v conda >/dev/null 2>&1; then for c in "${CONDA_ROOT:-}" "$HOME/miniconda3" "$HOME/anaconda3" /apps/application/miniconda3; do [ -n "$c" ] && [ -f "$c/etc/profile.d/conda.sh" ] && { source "$c/etc/profile.d/conda.sh"; break; }; done; fi
  eval "$(conda shell.bash hook)"; conda activate "$DL_ENV" || { echo "[node] conda env $DL_ENV not found"; exit 1; }
  command -v fasterq-dump >/dev/null || { echo "[node] fasterq-dump not on PATH"; exit 1; }
  CORES=$(nproc); PER="${DUMP_PER_NODE:-$(( CORES / DUMP_THREADS ))}"; [ "$PER" -lt 1 ] && PER=1
  echo "[node] $(hostname) cores=$CORES per_node=$PER threads=$DUMP_THREADS chunk=$2 ($(wc -l < "$2") runs)"
  export -f one cohort_of; export SRA_DIR FQ_DIR TMP_DIR LOG_DIR FAILED DONE_TSV MAP DUMP_THREADS
  xargs -a "$2" -n1 -P "$PER" -I{} bash -c 'one {}'
  touch "${2%.txt}.done"; echo "[node] chunk done" ;;
one)     one "$2" ;;
*)       sed -n '9,18p' "$0" ;;
esac
