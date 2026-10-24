#!/usr/bin/env bash
# metaCRC — §03 dump on K-BDS: fasterq-dump → fastq.gz, one BioProject at a time (DUMP_MODE=cohort, default):
# a cohort is submitted as its own job(s) — named metacrc-dump:<BioProject> — once none of its runs is still downloading,
# so progress reads per BioProject. DUMP_MODE=stream instead feeds any validated run as it arrives (mixed cohorts).
# Agreed 2026-10-23: fasterq-dump default split mode (= split-3), 4 threads per run, pigz, verify (gzip -t), cohort subfolders
# $FQ_DIR/<BioProject>/<run>_{1,2}.fastq.gz, delete $SRA_DIR/<run> after a verified dump, everything (temp too) under $HOME.
# Node packing (K-BDS = exclusive nodes, node-hour billing): 1 sbatch = 1 node, PER_NODE runs at a time × THREADS each.
# Failure codes as in the runbook: NOT_VALIDATED | NO_SRA | DUMP_FAIL, plus NOT_PAIRED (fasterq-dump gave no _1/_2 — a run
# labelled PAIRED that is really single-end; not retried) → $LOG_DIR/dump.FAILED ("<run> <code>").
# Orphan reads (<run>.fastq from split-3) are dropped by default and their byte count logged; DUMP_KEEP_ORPHANS=1 keeps them as <run>_s.fastq.gz.
#
# Usage (login node, ~/office):
#   ./03_dump_kbds.sh pending            per cohort: total / validated / dumped / waiting, and READY (prefetch of that cohort finished)
#   ./03_dump_kbds.sh submit [N]         submit up to N node jobs for READY cohorts (smallest first; ≤ DUMP_MAX_NODES − live)
#   ./03_dump_kbds.sh submit N --cohort PRJ   force that cohort now, ready or not (its validated runs only)
#   ./03_dump_kbds.sh feed               loop in tmux: every DUMP_FEED_S, sweep finished chunks and submit READY cohorts
#   ./03_dump_kbds.sh status             per-cohort counts, live jobs, throughput, failures
#   ./03_dump_kbds.sh retry              forget dump.FAILED (keeps a copy) so those runs become pending again
#   ./03_dump_kbds.sh node <chunk>       (what sbatch runs) xargs -P PER_NODE over the chunk's runs
#   ./03_dump_kbds.sh one <run>          (one run; called by `node`)
# Knobs (export in 00_env_local.sh or the environment): DUMP_MODE=cohort|stream DUMP_PART=cpu32-only DUMP_THREADS=4 DUMP_PER_NODE=(cores/threads)
#   DUMP_OVERSUB=1.5 (runs per node = cores/threads × this; fasterq-dump waits on Lustre so 4 threads ≈ 1.5 busy cores)
#   DUMP_PART may list several ("cpu32-only cpu64-only": each job takes the one with most idle nodes)  DUMP_CHUNK=160 (runs per node job) DUMP_MAX_NODES=5 DUMP_MIN_BATCH=16 DUMP_FEED_S=600 DUMP_TIME=24:00:00 DL_ENV=sra-tools
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${USER:=$(id -un)}"
: "${FQ_DIR:=$PROJ/fastq}" "${TMP_DIR:=$PROJ/tmp}" "${DL_ENV:=sra-tools}"
: "${DUMP_MODE:=cohort}" "${DUMP_PART:=cpu32-only}" "${DUMP_THREADS:=4}" "${DUMP_CHUNK:=160}" "${DUMP_MAX_NODES:=5}" "${DUMP_MIN_BATCH:=16}" "${DUMP_FEED_S:=600}" "${DUMP_TIME:=24:00:00}"
JOB=metacrc-dump
CH="$PROJ/manifest/dump_chunks"; MAP="$PROJ/manifest/run_cohort.tsv"; FAILED="$LOG_DIR/dump.FAILED"; DONE_TSV="$LOG_DIR/dump_done.tsv"; PF_FAILED="$LOG_DIR/prefetch.FAILED"
mkdir -p "$FQ_DIR" "$TMP_DIR" "$LOG_DIR/dump" "$LOG_DIR/slurm" "$CH"

# run → cohort map from the manifest (header names, not column numbers); rebuilt when the manifest is newer
mkmap() {
  if [ ! -s "$MAP" ] || [ "$MANIFEST" -nt "$MAP" ]; then
    awk -F'\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="run_accession")r=i;if($i=="cohort_accession")c=i};next} r&&c&&$r!=""{print $r"\t"$c}' "$MANIFEST" > "$MAP.tmp" && mv "$MAP.tmp" "$MAP"
  fi
}
cohort_of() { awk -F'\t' -v r="$1" '$1==r{print $2;exit}' "$MAP"; }

# chunk bookkeeping: $CH/chunk.<id>.txt + chunk.<id>.job (sbatch id) + chunk.<id>.done (node finished)
live_jobs() { squeue -h -u "$USER" -o '%i|%j' 2>/dev/null | awk -F'|' -v j="$JOB" 'index($2, j)==1{print $1}'; }
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

# per-cohort table: cohort  total  prefetched  prefetch_failed  dumped  dump_failed  inflight  waiting  ready(1/0)
# prefetched = validated now, or already dumped / dump-failed (their .sra is gone). READY = nothing of the cohort still downloading:
# every run is prefetched or prefetch-failed.
cohort_table() {
  mkmap; sweep
  local fl pf inf va du; fl="$(mktemp)"; pf="$(mktemp)"; inf="$(mktemp)"; va="$(mktemp)"; du="$(mktemp)"
  cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"; cut -d' ' -f1 "$PF_FAILED" 2>/dev/null | sort -u > "$pf"; inflight > "$inf"; validated_runs > "$va"; dumped_runs > "$du"
  awk -F'\t' -v L="$RUNLIST" -v FL="$fl" -v PF="$pf" -v IN="$inf" -v VA="$va" -v DU="$du" '
    BEGIN{ while((getline l < L)>0){ if(l!="" && l!~/^#/) want[l]=1 } while((getline l < FL)>0) bad[l]=1; while((getline l < PF)>0) pbad[l]=1
           while((getline l < IN)>0) inflt[l]=1; while((getline l < VA)>0) val[l]=1; while((getline l < DU)>0) dmp[l]=1 }
    ($1 in want) { c=$2; tot[c]++
      pre = ($1 in val) || ($1 in dmp) || ($1 in bad)
      if (pre) v[c]++; else if ($1 in pbad) pf[c]++; else miss[c]++
      if ($1 in dmp) d[c]++; else if ($1 in bad) df[c]++; else if ($1 in inflt) inf[c]++; else if ($1 in val) w[c]++ }
    END{ for (c in tot) printf "%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", c, tot[c], v[c]+0, pf[c]+0, d[c]+0, df[c]+0, inf[c]+0, w[c]+0, (miss[c]+0==0) }' "$MAP" | sort -t$'\t' -k2,2n
  rm -f "$fl" "$pf" "$inf" "$va" "$du"
}
# runs of one cohort that are waiting (validated, no fastq, not FAILED, not inflight), manifest order
cohort_waiting() { pending_list | awk -F'\t' -v c="$1" '$2==c{print $1}'; }

node_cores() { sinfo -h -p "$1" -o '%c' 2>/dev/null | head -1; }
# DUMP_PART="cpu32-only cpu64-only": pick, per job, the listed partition with the most idle nodes (first one if sinfo is silent)
pick_part() {
  local best="" bestn=-1 p n
  for p in $DUMP_PART; do n=$(sinfo -h -p "$p" -t idle -o '%D' 2>/dev/null | awk '{s+=$1} END{print s+0}'); [ "$n" -gt "$bestn" ] && { best="$p"; bestn=$n; }; done
  echo "${best:-${DUMP_PART%% *}}"
}

sbatch_chunk() {   # $1 = file of runs, $2 = job-name suffix (cohort or "mixed")
  local f="$1" tag="$2" part cores; part="$(pick_part)"; cores="$(node_cores "$part")"; [ -n "$cores" ] || cores=32
  local jid; jid=$(sbatch --parsable -J "$JOB:$tag" -p "$part" -N 1 -n 1 -c "$cores" --exclusive -t "$DUMP_TIME" \
                   -o "$LOG_DIR/slurm/dump-%j.out" --wrap "bash '$SELF' node '$f'" 2>&1) || { echo "[submit] sbatch failed: $jid" >&2; rm -f "$f"; return 1; }
  echo "$jid" > "${f%.txt}.job"
  echo "  job $jid  $JOB:$tag  on $part ($cores cores) ← $(wc -l < "$f") runs" >&2      # stderr: submit_runs' stdout is its job count
}

submit_runs() {   # $1 = file of runs, $2 = tag, $3 = max jobs → chunks of DUMP_CHUNK, returns jobs submitted
  local src="$1" tag="$2" room="$3" k=0 n; n=$(wc -l < "$src")
  while [ "$k" -lt "$room" ]; do
    local id f; id="$(date +%Y%m%d-%H%M%S)-$RANDOM"; f="$CH/chunk.$id.txt"
    sed -n "$(( k * DUMP_CHUNK + 1 )),$(( (k + 1) * DUMP_CHUNK ))p" "$src" > "$f"
    [ -s "$f" ] || { rm -f "$f"; break; }
    sbatch_chunk "$f" "$tag" || break
    k=$((k + 1))
  done
  echo "$k"
}
submit() {
  local want="${1:-0}" only="${2:-}" live room
  live=$(live_jobs | wc -l); room=$(( DUMP_MAX_NODES - live )); [ "$room" -lt 0 ] && room=0
  [ "$want" -gt 0 ] && [ "$want" -lt "$room" ] && room=$want
  if [ -n "$only" ]; then   # forced: this cohort's validated runs now, ready or not
    local f; f="$(mktemp)"; cohort_waiting "$only" > "$f"
    echo "[submit] cohort $only (forced) · $(wc -l < "$f") runs waiting · live jobs $live · room $room node(s) on $DUMP_PART"
    submit_runs "$f" "$only" "$room" >/dev/null; rm -f "$f"; return
  fi
  if [ "$DUMP_MODE" = stream ]; then
    local f; f="$(mktemp)"; pending_list | cut -f1 > "$f"
    echo "[submit] stream · $(wc -l < "$f") runs waiting · live jobs $live · room $room node(s) on $DUMP_PART"
    submit_runs "$f" mixed "$room" >/dev/null; rm -f "$f"; return
  fi
  # cohort mode: READY cohorts with waiting runs, smallest first, each cohort its own job(s)
  local tbl; tbl="$(mktemp)"; cohort_table > "$tbl"
  local ready; ready=$(awk -F'\t' '$9==1 && $8>0' "$tbl" | wc -l)
  echo "[submit] cohort mode · READY cohorts with waiting runs: $ready · live jobs $live · room $room node(s) on $DUMP_PART (chunk ≤ $DUMP_CHUNK)"
  while IFS=$'\t' read -r c tot v pf d df inf w rd; do
    [ "$room" -le 0 ] && break
    local f; f="$(mktemp)"; cohort_waiting "$c" > "$f"
    local k; k=$(submit_runs "$f" "$c" "$room"); rm -f "$f"; room=$(( room - k ))
  done < <(awk -F'\t' '$9==1 && $8>0' "$tbl")
  rm -f "$tbl"
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
  if ! { [ -s "$T/${RUN}_1.fastq" ] && [ -s "$T/${RUN}_2.fastq" ]; }; then
    [ -s "$T/$RUN.fastq" ] && { echo "$(date -u +%FT%TZ) no _1/_2, only unpaired $(stat -c %s "$T/$RUN.fastq") bytes" >> "$LOG"; fail NOT_PAIRED; return 1; }
    fail DUMP_FAIL; return 1
  fi
  local ORPH=0; [ -f "$T/$RUN.fastq" ] && ORPH=$(stat -c %s "$T/$RUN.fastq")
  local GZ="gzip"; command -v pigz >/dev/null 2>&1 && GZ="pigz -p $DUMP_THREADS"
  if [ "${DUMP_KEEP_ORPHANS:-0}" = 1 ] && [ "$ORPH" -gt 0 ]; then $GZ "$T/$RUN.fastq" && mv "$T/$RUN.fastq.gz" "$OUT/${RUN}_s.fastq.gz"; else rm -f "$T/$RUN.fastq"; fi
  $GZ "$T/${RUN}_2.fastq" && $GZ "$T/${RUN}_1.fastq" || fail DUMP_FAIL || return 1
  gzip -t "$T/${RUN}_1.fastq.gz" && gzip -t "$T/${RUN}_2.fastq.gz" || fail DUMP_FAIL || return 1
  mv "$T/${RUN}_2.fastq.gz" "$OUT/${RUN}_2.fastq.gz" && mv "$T/${RUN}_1.fastq.gz" "$OUT/${RUN}_1.fastq.gz" || fail DUMP_FAIL || return 1   # _1 last = the marker
  local B; B=$(( $(stat -c %s "$OUT/${RUN}_1.fastq.gz") + $(stat -c %s "$OUT/${RUN}_2.fastq.gz") ))
  rm -rf "$T" "$SRA_DIR/$RUN"                                                          # runbook: .sra goes once the dump is verified
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$RUN" "$(date -u +%FT%TZ)" "$(( $(date +%s) - T0 ))" "$B" "$COH" "$ORPH" >> "$DONE_TSV"   # run, when, seconds, fastq.gz bytes, cohort, orphan bytes (uncompressed)
  echo "$(date -u +%FT%TZ) done $RUN $(( $(date +%s) - T0 ))s $B bytes orphans=$ORPH" >> "$LOG"
}

case "${1:-}" in
pending)
  printf '%-14s %6s %6s %5s %6s %5s %5s %6s  %s\n' cohort total prefd pfail dumped dfail infl wait ready
  cohort_table | awk -F'\t' '{printf "%-14s %6d %6d %5d %6d %5d %5d %6d  %s\n", $1,$2,$3,$4,$5,$6,$7,$8,($9?"READY":"")}'
  echo "waiting total: $(pending_list | wc -l) runs · mode $DUMP_MODE" ;;
submit)  if [ "${3:-}" = --cohort ]; then submit "${2:-0}" "$4"; elif [ "${2:-}" = --cohort ]; then submit 0 "$3"; else submit "${2:-0}"; fi ;;
feed)
  echo "[feed] mode $DUMP_MODE · every ${DUMP_FEED_S}s: sweep + submit (≤ $DUMP_MAX_NODES nodes on $DUMP_PART, chunk $DUMP_CHUNK)"
  while true; do
    live=$(live_jobs | wc -l)
    if [ "$DUMP_MODE" = stream ]; then n=$(pending_list | wc -l); else n=$(cohort_table | awk -F'\t' '$9==1{s+=$8} END{print s+0}'); fi
    if { [ "$n" -ge "$DUMP_MIN_BATCH" ] || { [ "$n" -gt 0 ] && [ "$live" -eq 0 ]; }; } && [ "$live" -lt "$DUMP_MAX_NODES" ]; then submit 0; else echo "$(date -u +%FT%TZ) ready-to-dump $n · live $live · nothing to do"; fi
    sleep "$DUMP_FEED_S"
  done ;;
status)
  mkmap; sweep
  T=$(wc -l < "$RUNLIST"); V=$(find "$SRA_DIR" -maxdepth 2 -name .validated 2>/dev/null | wc -l); D=$(find "$FQ_DIR" -mindepth 2 -maxdepth 2 -name '*_1.fastq.gz' 2>/dev/null | wc -l); F=$(sort -u "$FAILED" 2>/dev/null | wc -l)
  printf 'dumped %6d / %d   validated-waiting %d   failed %d   inflight %d\n' "$D" "$T" "$(pending_list | wc -l)" "$F" "$(inflight | wc -l)"
  echo "jobs:"; squeue -u "$USER" -h -o '  %i %j %T %M %N %r' 2>/dev/null | grep -F " $JOB" 
  if [ -s "$DONE_TSV" ]; then awk -F'\t' -v now="$(date +%s)" '{cmd="date -d \""$2"\" +%s"; cmd|getline t; close(cmd); if(now-t<=3600){n++;b+=$4} tot++; sec+=$3; orph+=$6+0} END{printf "last 1h: %d runs, %.1f GB fastq.gz → %d runs/h   all: %d runs, avg %.0f s/run, orphans dropped %.2f GB\n", n, b/1e9, n, tot, sec/tot, orph/1e9}' "$DONE_TSV"; fi
  echo "by cohort (dumped / total · prefetched · state):"
  cohort_table | awk -F'\t' '{st=($5>=$2)?"✓ done":($7>0?"▶ running":($9?"ready":"prefetching")); printf "  %-14s %5d / %5d   prefetched %5d   %s\n", $1, $5, $2, $3, st}' | sort -k2,2nr
  [ -s "$FAILED" ] && { echo "failed reasons:"; awk '{print $2}' "$FAILED" | sort | uniq -c; }; true ;;
retry)   [ -s "$FAILED" ] && { cp "$FAILED" "$FAILED.$(date +%Y%m%d-%H%M%S)"; grep ' NOT_PAIRED$' "$FAILED" > "$FAILED.tmp" || true; mv "$FAILED.tmp" "$FAILED"; echo "[retry] FAILED cleared except NOT_PAIRED (copy kept); the rest are pending again — feed/submit picks them up"; } || echo "nothing failed" ;;
node)
  # batch jobs do not read .bashrc: find conda by path
  if ! command -v conda >/dev/null 2>&1; then for c in "${CONDA_ROOT:-}" "$HOME/miniconda3" "$HOME/anaconda3" /apps/application/miniconda3; do [ -n "$c" ] && [ -f "$c/etc/profile.d/conda.sh" ] && { source "$c/etc/profile.d/conda.sh"; break; }; done; fi
  eval "$(conda shell.bash hook)"; conda activate "$DL_ENV" || { echo "[node] conda env $DL_ENV not found"; exit 1; }
  command -v fasterq-dump >/dev/null || { echo "[node] fasterq-dump not on PATH"; exit 1; }
  # fasterq-dump on Lustre is I/O-bound (~1.5 of its 4 threads busy), so DUMP_OVERSUB (default 1.5) packs more runs per node
  CORES=$(nproc); PER="${DUMP_PER_NODE:-$(awk -v c="$CORES" -v t="$DUMP_THREADS" -v o="${DUMP_OVERSUB:-1.5}" 'BEGIN{printf "%d", c/t*o}')}"; [ "$PER" -lt 1 ] && PER=1
  echo "[node] $(hostname) cores=$CORES per_node=$PER threads=$DUMP_THREADS chunk=$2 ($(wc -l < "$2") runs)"
  export -f one cohort_of; export SRA_DIR FQ_DIR TMP_DIR LOG_DIR FAILED DONE_TSV MAP DUMP_THREADS
  # load heartbeat (read by office-probe → CPU 활용률 in the app): iso  host  load1  ncpu  fasterq-dump procs  pigz procs  chunk
  LOADF="${2%.txt}.load"
  ( while :; do printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$(hostname)" "$(cut -d' ' -f1 /proc/loadavg)" "$CORES" "$(pgrep -c -x fasterq-dump)" "$(pgrep -c -x pigz)" "$(basename "$2" .txt)" > "$LOADF.tmp" && mv "$LOADF.tmp" "$LOADF"; sleep 60; done ) &
  LOADPID=$!; trap 'kill $LOADPID 2>/dev/null' EXIT
  xargs -a "$2" -n1 -P "$PER" -I{} bash -c 'one {}'
  kill $LOADPID 2>/dev/null; rm -f "$LOADF"
  touch "${2%.txt}.done"; echo "[node] chunk done" ;;
one)     one "$2" ;;
*)       sed -n '9,18p' "$0" ;;
esac
