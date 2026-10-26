#!/usr/bin/env bash
# metaCRC — §04 QC on K-BDS: metaFun RAWREAD_QC_cleanifier.nf (fastp → Cleanifier → bgzip), one BioProject per node job.
# Interface agreed 2026-10-27 (claude/kbds.md "metaFun 측 확정", docs/metacrc_qc_settings.md §9):
#   samplesheet  make_samplesheet.py --manifest --fastq-dir --cohort <BioProject> [--exclude <BioProject>.bad_runs.txt] --out runs/qc/<BioProject>/samplesheet.csv
#   run          cd runs/qc/<BioProject> && nextflow run $METAFUN_DIR/nf_scripts/RAWREAD_QC_cleanifier.nf -c $METAFUN_DIR/config/kbds.config -profile kbds
#                  --samplesheet $PWD/samplesheet.csv --outdir $QC_DIR --run_dir $PWD --work_dir $PROJ/work/qc/<BioProject> --cleanifier_index $QC_INDEX -resume
#                (conda env metacrc-qc, NXF_OFFLINE=true), then `cleanifier remove --name <prefix>` as the safety net for the shared-memory index.
#   done         $QC_DIR/<BioProject>/<run>.done (written last); failures = trace FAILED (retry 1 → ignore). No qc.FAILED file.
# A cohort is READY for QC when none of its runs is still to be dumped (dumped, or dump-/prefetch-failed). Re-submitting a cohort
# is safe: -resume + the workflow's skip_done leave finished runs alone.
#
# Usage (login node, ~/office):
#   ./04_qc_kbds.sh pending                  per cohort: total / dumped / qc done / READY
#   ./04_qc_kbds.sh submit [N]               submit up to N cohort jobs (READY, not complete, not live; smallest first)
#   ./04_qc_kbds.sh submit --cohort PRJ      that cohort now
#   ./04_qc_kbds.sh feed                     loop in tmux (every QC_FEED_S)
#   ./04_qc_kbds.sh status                   live jobs, per-cohort .done counts, last-hour throughput
#   ./04_qc_kbds.sh node <BioProject>        (what sbatch runs)
# Knobs (00_env_local.sh): METAFUN_DIR=$HOME/metaFun QC_ENV=metacrc-qc QC_INDEX=$PROJ/db/cleanifier/<prefix> QC_SHM_NAME=(basename of QC_INDEX)
#   QC_PART="cpu32-only cpu64-only" QC_MAX_NODES=5 QC_TIME=96:00:00 QC_FEED_S=600 QC_NF_ARGS="" (extra nextflow args, e.g. --cpus 3)
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${USER:=$(id -un)}"
: "${FQ_DIR:=$PROJ/fastq}" "${QC_DIR:=$PROJ/qc}" "${METAFUN_DIR:=$HOME/metaFun}" "${QC_ENV:=metacrc-qc}"
: "${QC_INDEX:=$PROJ/db/cleanifier/t2t_pangenome_hla_variants_cdna_cleanifier_index_k29_w33}"
: "${QC_SHM_NAME:=$(basename "$QC_INDEX")}" "${QC_PART:=cpu32-only cpu64-only}" "${QC_MAX_NODES:=5}" "${QC_TIME:=96:00:00}" "${QC_FEED_S:=600}" "${QC_NF_ARGS:=}"
JOB=metacrc-qc
MAP="$PROJ/manifest/run_cohort.tsv"; CH="$PROJ/manifest/qc_chunks"; RUNS="$PROJ/runs/qc"; WORK="$PROJ/work/qc"
DUMP_FAILED="$LOG_DIR/dump.FAILED"; PF_FAILED="$LOG_DIR/prefetch.FAILED"
mkdir -p "$QC_DIR" "$CH" "$RUNS" "$WORK" "$LOG_DIR"

mkmap() {
  if [ ! -s "$MAP" ] || [ "$MANIFEST" -nt "$MAP" ]; then
    awk -F'\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="run_accession")r=i;if($i=="cohort_accession")c=i};next} r&&c&&$r!=""{print $r"\t"$c}' "$MANIFEST" > "$MAP.tmp" && mv "$MAP.tmp" "$MAP"
  fi
}
live_jobs() { squeue -h -u "$USER" -o '%i|%j' 2>/dev/null | awk -F'|' -v j="$JOB" 'index($2, j)==1{print $1"\t"substr($2, length(j)+2)}'; }   # id<TAB>cohort
dumped_runs() { find "$FQ_DIR" -mindepth 2 -maxdepth 2 -name '*_1.fastq.gz' -printf '%f\n' 2>/dev/null | sed 's/_1\.fastq\.gz$//'; }
qc_done_runs() { find "$QC_DIR" -mindepth 2 -maxdepth 2 -name '*.done' -printf '%f\n' 2>/dev/null | sed 's/\.done$//'; }

# cohort  total  dumped  settled  qc_done  live(1/0)  ready(1/0)   — settled = dumped or dump-/prefetch-failed
cohort_table() {
  mkmap
  local du qd df pf lv; du="$(mktemp)"; qd="$(mktemp)"; df="$(mktemp)"; pf="$(mktemp)"; lv="$(mktemp)"
  dumped_runs > "$du"; qc_done_runs > "$qd"; cut -d' ' -f1 "$DUMP_FAILED" 2>/dev/null | sort -u > "$df"; cut -d' ' -f1 "$PF_FAILED" 2>/dev/null | sort -u > "$pf"; live_jobs | cut -f2 > "$lv"
  awk -F'\t' -v L="$RUNLIST" -v DU="$du" -v QD="$qd" -v DF="$df" -v PF="$pf" -v LV="$lv" '
    BEGIN{ while((getline l < L)>0){ if(l!="" && l!~/^#/) want[l]=1 } while((getline l < DU)>0) d[l]=1; while((getline l < QD)>0) q[l]=1
           while((getline l < DF)>0) f[l]=1; while((getline l < PF)>0) p[l]=1; while((getline l < LV)>0) live[l]=1 }
    ($1 in want) { c=$2; tot[c]++; if ($1 in d) dd[c]++; if (($1 in d) || ($1 in f) || ($1 in p)) st[c]++; if ($1 in q) qq[c]++ }
    END{ for (c in tot) printf "%s\t%d\t%d\t%d\t%d\t%d\t%d\n", c, tot[c], dd[c]+0, st[c]+0, qq[c]+0, (c in live), (st[c]+0>=tot[c] && dd[c]+0>0) }' "$MAP" | sort -t$'\t' -k2,2n
  rm -f "$du" "$qd" "$df" "$pf" "$lv"
}

pick_part() { local best="" bestn=-1 p n; for p in $QC_PART; do n=$(sinfo -h -p "$p" -t idle -o '%D' 2>/dev/null | awk '{s+=$1} END{print s+0}'); [ "$n" -gt "$bestn" ] && { best="$p"; bestn=$n; }; done; echo "${best:-${QC_PART%% *}}"; }

submit_cohort() {   # $1 = BioProject
  local c="$1" rd="$RUNS/$c" part cores excl=""
  mkdir -p "$rd" "$WORK/$c"
  [ -s "$PROJ/manifest/fastq_check/$c.bad_runs.txt" ] && excl="--exclude $PROJ/manifest/fastq_check/$c.bad_runs.txt"
  python3 "$METAFUN_DIR/scripts/rawreadqc/make_samplesheet.py" --manifest "$MANIFEST" --fastq-dir "$FQ_DIR" --cohort "$c" $excl --out "$rd/samplesheet.csv" \
    || { echo "[submit] $c: samplesheet failed" >&2; return 1; }
  local n; n=$(( $(wc -l < "$rd/samplesheet.csv") - 1 ))
  part="$(pick_part)"; cores=$(sinfo -h -p "$part" -o '%c' 2>/dev/null | head -1); [ -n "$cores" ] || cores=32
  local jid; jid=$(sbatch --parsable -J "$JOB:$c" -p "$part" -N 1 -n 1 -c "$cores" --exclusive -t "$QC_TIME" -o "$rd/slurm-%j.out" --wrap "bash '$SELF' node '$c'" 2>&1) \
    || { echo "[submit] $c: sbatch failed: $jid" >&2; return 1; }
  echo "$jid" > "$CH/chunk.$c.job"
  echo "  job $jid  $JOB:$c  on $part ($cores cores) ← $n runs (samplesheet)"
}

submit() {
  local want="${1:-0}" only="${2:-}" live room
  live=$(live_jobs | wc -l); room=$(( QC_MAX_NODES - live )); [ "$room" -lt 0 ] && room=0
  [ "$want" -gt 0 ] && [ "$want" -lt "$room" ] && room=$want
  if [ -n "$only" ]; then echo "[submit] cohort $only (forced) · live $live"; submit_cohort "$only"; return; fi
  local tbl; tbl="$(mktemp)"; cohort_table > "$tbl"
  local ready; ready=$(awk -F'\t' '$7==1 && $5<$3 && $6==0' "$tbl" | wc -l)
  echo "[submit] READY cohorts not yet complete and not live: $ready · live jobs $live · room $room node(s) on {$QC_PART}"
  while IFS=$'\t' read -r c tot dd st qq lv rd; do
    [ "$room" -le 0 ] && break
    submit_cohort "$c" && room=$(( room - 1 ))
  done < <(awk -F'\t' '$7==1 && $5<$3 && $6==0' "$tbl")
  rm -f "$tbl"
}

case "${1:-}" in
pending)
  printf '%-14s %6s %6s %7s %7s %5s  %s\n' cohort total dumped settled qc_done live ready
  cohort_table | awk -F'\t' '{printf "%-14s %6d %6d %7d %7d %5s  %s\n", $1,$2,$3,$4,$5,($6?"▶":""),($7?($5>=$3?"done":"READY"):"")}' ;;
submit)  if [ "${2:-}" = --cohort ]; then submit 0 "$3"; elif [ "${3:-}" = --cohort ]; then submit "${2:-0}" "$4"; else submit "${2:-0}"; fi ;;
feed)
  echo "[feed] every ${QC_FEED_S}s: submit READY cohorts (≤ $QC_MAX_NODES nodes on {$QC_PART})"
  while true; do submit 0; sleep "$QC_FEED_S"; done ;;
status)
  mkmap
  T=$(wc -l < "$RUNLIST"); Q=$(qc_done_runs | wc -l); D=$(dumped_runs | wc -l)
  printf 'qc done %6d / %d   dumped %d\n' "$Q" "$T" "$D"
  echo "jobs:"; squeue -u "$USER" -h -o '  %i %j %T %M %N %r' 2>/dev/null | grep -F " $JOB"
  find "$QC_DIR" -mindepth 2 -maxdepth 2 -name '*.done' -mmin -60 2>/dev/null | wc -l | awk '{printf "last 1h: %d runs → %d runs/h\n", $1, $1}'
  echo "by cohort (qc done / dumped · state):"
  cohort_table | awk -F'\t' '{st=($5>=$3 && $3>0)?"✓ done":($6?"▶ running":($7?"ready":"waiting for dump")); printf "  %-14s %5d / %5d   %s\n", $1, $5, $3, st}' | sort -k2,2nr
  ls "$QC_DIR"/*/*.qc_summary.tsv 2>/dev/null | wc -l | awk '{print "cohort summaries: "$1}'; true ;;
node)
  C="$2"; RD="$RUNS/$C"; cd "$RD" || exit 1
  if ! command -v conda >/dev/null 2>&1; then for c in "${CONDA_ROOT:-}" "$HOME/miniconda3" "$HOME/anaconda3" /apps/application/miniconda3; do [ -n "$c" ] && [ -f "$c/etc/profile.d/conda.sh" ] && { source "$c/etc/profile.d/conda.sh"; break; }; done; fi
  eval "$(conda shell.bash hook)"; conda activate "$QC_ENV" || { echo "[node] conda env $QC_ENV not found"; exit 1; }
  export NXF_OFFLINE=true
  CORES=$(nproc); echo "[node] $(hostname) cores=$CORES cohort=$C runs=$(( $(wc -l < samplesheet.csv) - 1 )) index=$QC_INDEX"
  LOADF="$CH/chunk.$C.load"
  ( while :; do printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$(hostname)" "$(cut -d' ' -f1 /proc/loadavg)" "$CORES" "$(pgrep -c -x fastp)" "$(pgrep -c -f 'cleanifier filter')" "$C" > "$LOADF.tmp" && mv "$LOADF.tmp" "$LOADF"; sleep 60; done ) &
  LOADPID=$!; trap 'kill $LOADPID 2>/dev/null; cleanifier remove --name "$QC_SHM_NAME" >/dev/null 2>&1 || true' EXIT
  nextflow run "$METAFUN_DIR/nf_scripts/RAWREAD_QC_cleanifier.nf" -c "$METAFUN_DIR/config/kbds.config" -profile kbds \
    --samplesheet "$PWD/samplesheet.csv" --outdir "$QC_DIR" --run_dir "$PWD" --work_dir "$WORK/$C" --cleanifier_index "$QC_INDEX" -resume $QC_NF_ARGS
  RC=$?
  cleanifier remove --name "$QC_SHM_NAME" >/dev/null 2>&1 || true      # safety net for the shared-memory index (workflow cleans up too)
  kill $LOADPID 2>/dev/null; rm -f "$LOADF"
  echo "[node] nextflow exit $RC · done $(ls "$QC_DIR/$C"/*.done 2>/dev/null | wc -l)"; exit $RC ;;
*)       sed -n '12,21p' "$0" ;;
esac
