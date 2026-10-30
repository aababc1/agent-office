#!/usr/bin/env bash
# metaCRC — §05 merge on K-BDS: multi-run samples → one R1/R2 per sample (runbook 05_merge, node-packed like §03/§04).
#   unit     sample from $MULTI (samples_multirun.txt, 322 = PRJEB6070 196 · PRJEB12449 110 · PRJEB27928 16); its runs = manifest rows
#            with that sample_accession that are in $RUNLIST (PAIRED), run order = sorted run_accession.
#   input    $QC_DIR/<BioProject>/<run>_1.fastq.gz + _2.fastq.gz, accepted only with the QC marker <run>.done (metaFun writes it last)
#            and a BGZF EOF block at the end of each file (bgzip finished).
#   output   $MRG_DIR/<BioProject>/<sample>_R2.fastq.gz first, <sample>_R1.fastq.gz last (= completion marker, as in plan.yaml).
#            gzip members are concatenated (cat): valid gzip/BGZF, no re-compression, I/O-bound → several per node.
#   failed   $LOG_DIR/merge.FAILED  "<sample> <code> <when>"  code = MISSING_<run> (run prefetch-/dump-failed or QC FAILED in trace)
#            | TRUNCATED_<run> (QC fastq without BGZF EOF) | CAT_FAIL | SIZE_MISMATCH. merge_done.tsv: sample when seconds bytes cohort runs.
#   ready    a sample is READY when every run has <run>.done; a cohort job is submitted when it has READY samples not merged.
#            Samples with a run that is still being QC'd just wait (not a failure).
#
# Usage (login node, ~/office):
#   ./05_merge_kbds.sh pending                 per cohort: samples / ready / merged / failed / live
#   ./05_merge_kbds.sh submit [N]              submit up to N cohort node jobs (cohorts with READY samples; smallest first)
#   ./05_merge_kbds.sh submit --cohort PRJ     that cohort now
#   ./05_merge_kbds.sh feed                    loop in tmux (every MERGE_FEED_S)
#   ./05_merge_kbds.sh status                  merged / 322, live jobs, per-cohort ✓
#   ./05_merge_kbds.sh retry                   clear merge.FAILED (failed samples go back to the queue)
#   ./05_merge_kbds.sh node <BioProject>       (what sbatch runs)   ·   one <sample>   (merge one sample here, for a check)
# Knobs (00_env_local.sh): MERGE_PART="cpu32-only cpu64-only" MERGE_MAX_NODES=2 MERGE_TIME=12:00:00 MERGE_FEED_S=600
#   MERGE_THREADS=4 (slot size, as everywhere) MERGE_OVERSUB=1.5 (cat is I/O-bound: slots = cores/threads × oversub)
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${USER:=$(id -un)}"
: "${QC_DIR:=$PROJ/qc}" "${MRG_DIR:=$PROJ/merged}" "${MULTI:=$PROJ/manifest/samples_multirun.txt}"
: "${MERGE_PART:=cpu32-only cpu64-only}" "${MERGE_MAX_NODES:=2}" "${MERGE_TIME:=12:00:00}" "${MERGE_FEED_S:=600}" "${MERGE_THREADS:=4}" "${MERGE_OVERSUB:=1.5}"
JOB=metacrc-merge
CH="$PROJ/manifest/merge_chunks"; SMAP="$PROJ/manifest/sample_runs.tsv"; FAILED="$LOG_DIR/merge.FAILED"; DONE_TSV="$LOG_DIR/merge_done.tsv"
DUMP_FAILED="$LOG_DIR/dump.FAILED"; PF_FAILED="$LOG_DIR/prefetch.FAILED"
mkdir -p "$MRG_DIR" "$CH" "$LOG_DIR"

# sample<TAB>cohort<TAB>run1,run2,...   for every sample in $MULTI (runs restricted to $RUNLIST, sorted)
mkmap() {
  if [ ! -s "$SMAP" ] || [ "$MANIFEST" -nt "$SMAP" ] || [ "$MULTI" -nt "$SMAP" ] || [ "$RUNLIST" -nt "$SMAP" ]; then
    awk -F'\t' -v M="$MULTI" -v L="$RUNLIST" '
      BEGIN{ while((getline l < M)>0){ sub(/[ \t].*/,"",l); if(l!="" && l!~/^#/) want[l]=1 } while((getline l < L)>0){ if(l!="" && l!~/^#/) ok[l]=1 } }
      NR==1{ for(i=1;i<=NF;i++){ if($i=="run_accession")r=i; if($i=="sample_accession")s=i; if($i=="cohort_accession")c=i }; next }
      ($s in want) && ($r in ok) { n[$s]++; runs[$s, n[$s]]=$r; coh[$s]=$c }
      END{ for (s in n) { m=n[s]; for(i=1;i<=m;i++) a[i]=runs[s,i]; for(i=1;i<=m;i++) for(j=i+1;j<=m;j++) if(a[j]<a[i]){t=a[i];a[i]=a[j];a[j]=t}
             line=a[1]; for(i=2;i<=m;i++) line=line","a[i]; printf "%s\t%s\t%s\n", s, coh[s], line; delete a } }' "$MANIFEST" | sort > "$SMAP.tmp" && mv "$SMAP.tmp" "$SMAP"
  fi
}
live_jobs() { squeue -h -u "$USER" -o '%i|%j' 2>/dev/null | awk -F'|' -v j="$JOB" 'index($2, j)==1{print $1"\t"substr($2, length(j)+2)}'; }   # id<TAB>cohort
merged_samples() { find "$MRG_DIR" -mindepth 2 -maxdepth 2 -name '*_R1.fastq.gz' -printf '%f\n' 2>/dev/null | sed 's/_R1\.fastq\.gz$//'; }
qc_done_runs()   { find "$QC_DIR" -mindepth 2 -maxdepth 2 -name '*.done' -printf '%f\n' 2>/dev/null | sed 's/\.done$//'; }
# runs that will never get a .done: prefetch-/dump-failed, or a FAILED row in a QC trace without a later COMPLETED/CACHED row
dead_runs() {
  { cut -d' ' -f1 "$PF_FAILED" "$DUMP_FAILED" 2>/dev/null
    for t in "$PROJ"/runs/qc/*/trace.txt; do [ -s "$t" ] || continue
      awk -F'\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="process")p=i;if($i=="tag")g=i;if($i=="status")s=i};next} p&&g&&s&&$p=="fastp_cleanifier"{st[$g]=$s} END{for(r in st) if(st[r]=="FAILED") print r}' "$t"
    done; } | sort -u
}

# cohort  samples  ready  merged  failed  live(1/0)   — ready = every run has .done and sample not merged/failed
cohort_table() {
  mkmap
  local qd md dd fl lv; qd="$(mktemp)"; md="$(mktemp)"; dd="$(mktemp)"; fl="$(mktemp)"; lv="$(mktemp)"
  qc_done_runs > "$qd"; merged_samples > "$md"; dead_runs > "$dd"; cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"; live_jobs | cut -f2 > "$lv"
  awk -F'\t' -v QD="$qd" -v MD="$md" -v DD="$dd" -v FL="$fl" -v LV="$lv" '
    BEGIN{ while((getline l < QD)>0) q[l]=1; while((getline l < MD)>0) m[l]=1; while((getline l < DD)>0) d[l]=1; while((getline l < FL)>0) f[l]=1; while((getline l < LV)>0) live[l]=1 }
    { c=$2; tot[c]++; if ($1 in m) { mm[c]++; next } if ($1 in f) { ff[c]++; next }
      n=split($3, r, ","); ok=1; for(i=1;i<=n;i++) if (!(r[i] in q)) { ok=0; break }; if (ok) rd[c]++ }
    END{ for (c in tot) printf "%s\t%d\t%d\t%d\t%d\t%d\n", c, tot[c], rd[c]+0, mm[c]+0, ff[c]+0, (c in live) }' "$SMAP" | sort -t$'\t' -k2,2n
  rm -f "$qd" "$md" "$dd" "$fl" "$lv"
}

pick_part() { local best="" bestn=-1 p n; for p in $MERGE_PART; do n=$(sinfo -h -p "$p" -t idle -o '%D' 2>/dev/null | awk '{s+=$1} END{print s+0}'); [ "$n" -gt "$bestn" ] && { best="$p"; bestn=$n; }; done; echo "${best:-${MERGE_PART%% *}}"; }

# the per-sample recipe: $1 = sample  (reads $SMAP; writes outputs, merge_done.tsv / merge.FAILED)
merge_one() {
  local s="$1" line c runs r f1 f2 t0 sz1 sz2 o1 o2 tmp1 tmp2 in1="" in2="" eof=1f8b08040000000000ff0600424302001b0003000000000000000000
  line=$(awk -F'\t' -v s="$s" '$1==s' "$SMAP"); [ -n "$line" ] || { echo "[merge] $s: not in $MULTI/manifest" >&2; return 1; }
  c=$(cut -f2 <<<"$line"); runs=$(cut -f3 <<<"$line" | tr ',' ' ')
  o1="$MRG_DIR/$c/${s}_R1.fastq.gz"; o2="$MRG_DIR/$c/${s}_R2.fastq.gz"; tmp1="$MRG_DIR/$c/.${s}_R1.part.gz"; tmp2="$MRG_DIR/$c/.${s}_R2.part.gz"
  [ -s "$o1" ] && [ -s "$o2" ] && { echo "[merge] $s: already merged"; return 0; }
  mkdir -p "$MRG_DIR/$c"; t0=$(date +%s); sz1=0; sz2=0
  for r in $runs; do
    f1="$QC_DIR/$c/${r}_1.fastq.gz"; f2="$QC_DIR/$c/${r}_2.fastq.gz"
    if [ ! -f "$QC_DIR/$c/$r.done" ] || [ ! -s "$f1" ] || [ ! -s "$f2" ]; then echo "$s MISSING_$r $(date -u +%FT%TZ)" >> "$FAILED"; echo "[merge] $s: MISSING_$r"; return 2; fi
    if [ "$(tail -c 28 "$f1" | od -An -tx1 | tr -d ' \n')" != "$eof" ] || [ "$(tail -c 28 "$f2" | od -An -tx1 | tr -d ' \n')" != "$eof" ]; then
      echo "$s TRUNCATED_$r $(date -u +%FT%TZ)" >> "$FAILED"; echo "[merge] $s: TRUNCATED_$r (no BGZF EOF)"; return 2; fi
    in1="$in1 $f1"; in2="$in2 $f2"; sz1=$(( sz1 + $(stat -c %s "$f1") )); sz2=$(( sz2 + $(stat -c %s "$f2") ))
  done
  rm -f "$tmp1" "$tmp2"
  if ! cat $in2 > "$tmp2" || ! cat $in1 > "$tmp1"; then rm -f "$tmp1" "$tmp2"; echo "$s CAT_FAIL $(date -u +%FT%TZ)" >> "$FAILED"; echo "[merge] $s: CAT_FAIL"; return 2; fi
  if [ "$(stat -c %s "$tmp1")" != "$sz1" ] || [ "$(stat -c %s "$tmp2")" != "$sz2" ]; then rm -f "$tmp1" "$tmp2"; echo "$s SIZE_MISMATCH $(date -u +%FT%TZ)" >> "$FAILED"; echo "[merge] $s: SIZE_MISMATCH"; return 2; fi
  mv "$tmp2" "$o2" && mv "$tmp1" "$o1" || { echo "$s CAT_FAIL $(date -u +%FT%TZ)" >> "$FAILED"; return 2; }
  printf '%s\t%s\t%d\t%d\t%s\t%s\n' "$s" "$(date -u +%FT%TZ)" "$(( $(date +%s) - t0 ))" "$(( sz1 + sz2 ))" "$c" "$(tr ' ' ',' <<<"${runs# }")" >> "$DONE_TSV"
  echo "[merge] $s: ok $(( (sz1 + sz2) / 1048576 )) MB ← $(wc -w <<<"$runs") runs, $(( $(date +%s) - t0 )) s"
}

ready_samples() {   # $1 = cohort → sample ids READY now (every run .done, not merged, not failed)
  local c="$1" qd md fl; qd="$(mktemp)"; md="$(mktemp)"; fl="$(mktemp)"
  qc_done_runs > "$qd"; merged_samples > "$md"; cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"
  awk -F'\t' -v C="$c" -v QD="$qd" -v MD="$md" -v FL="$fl" '
    BEGIN{ while((getline l < QD)>0) q[l]=1; while((getline l < MD)>0) m[l]=1; while((getline l < FL)>0) f[l]=1 }
    $2==C && !($1 in m) && !($1 in f) { n=split($3, r, ","); ok=1; for(i=1;i<=n;i++) if (!(r[i] in q)) { ok=0; break }; if (ok) print $1 }' "$SMAP"
  rm -f "$qd" "$md" "$fl"
}

submit_cohort() {   # $1 = BioProject
  local c="$1" part cores n
  mkmap; ready_samples "$c" > "$CH/chunk.$c.txt"; n=$(wc -l < "$CH/chunk.$c.txt")
  [ "$n" -gt 0 ] || { echo "[submit] $c: no READY sample" >&2; return 1; }
  part="$(pick_part)"; cores=$(sinfo -h -p "$part" -o '%c' 2>/dev/null | head -1); [ -n "$cores" ] || cores=32
  local jid; jid=$(sbatch --parsable -J "$JOB:$c" -p "$part" -N 1 -n 1 -c "$cores" --exclusive -t "$MERGE_TIME" -o "$LOG_DIR/merge-$c-%j.out" --wrap "bash '$SELF' node '$c'" 2>&1) \
    || { echo "[submit] $c: sbatch failed: $jid" >&2; return 1; }
  echo "$jid" > "$CH/chunk.$c.job"
  echo "  job $jid  $JOB:$c  on $part ($cores cores) ← $n samples"
}

mark_dead() {   # samples (not merged, not failed) with a run that will never get .done → merge.FAILED MISSING_<run>
  mkmap; local md dd fl; md="$(mktemp)"; dd="$(mktemp)"; fl="$(mktemp)"
  merged_samples > "$md"; dead_runs > "$dd"; cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"
  awk -F'\t' -v MD="$md" -v DD="$dd" -v FL="$fl" -v now="$(date -u +%FT%TZ)" '
    BEGIN{ while((getline l < MD)>0) m[l]=1; while((getline l < DD)>0) d[l]=1; while((getline l < FL)>0) f[l]=1 }
    !($1 in m) && !($1 in f) { n=split($3, r, ","); for(i=1;i<=n;i++) if (r[i] in d) { print $1" MISSING_"r[i]" "now; break } }' "$SMAP" >> "$FAILED"
  rm -f "$md" "$dd" "$fl"
}

submit() {
  local want="${1:-0}" only="${2:-}" live room
  mark_dead
  live=$(live_jobs | wc -l); room=$(( MERGE_MAX_NODES - live )); [ "$room" -lt 0 ] && room=0
  [ "$want" -gt 0 ] && [ "$want" -lt "$room" ] && room=$want
  if [ -n "$only" ]; then echo "[submit] cohort $only (forced) · live $live"; submit_cohort "$only"; return; fi
  local tbl; tbl="$(mktemp)"; cohort_table > "$tbl"
  echo "[submit] cohorts with READY samples and no live job: $(awk -F'\t' '$3>0 && $6==0' "$tbl" | wc -l) · live jobs $live · room $room node(s) on {$MERGE_PART}"
  while IFS=$'\t' read -r c tot rd mm ff lv; do
    [ "$room" -le 0 ] && break
    submit_cohort "$c" && room=$(( room - 1 ))
  done < <(awk -F'\t' '$3>0 && $6==0' "$tbl")
  rm -f "$tbl"
}

case "${1:-}" in
pending)
  mkmap; printf '%-14s %7s %6s %6s %6s %5s\n' cohort samples ready merged failed live
  cohort_table | awk -F'\t' '{printf "%-14s %7d %6d %6d %6d %5s\n", $1,$2,$3,$4,$5,($6?"▶":"")}'
  echo "samples in $MULTI: $(grep -cv '^\s*\(#\|$\)' "$MULTI") · mapped to runs: $(wc -l < "$SMAP") (runs restricted to $RUNLIST)" ;;
submit)  if [ "${2:-}" = --cohort ]; then submit 0 "$3"; elif [ "${3:-}" = --cohort ]; then submit "${2:-0}" "$4"; else submit "${2:-0}"; fi ;;
feed)
  echo "[feed] every ${MERGE_FEED_S}s: submit cohorts with READY samples (≤ $MERGE_MAX_NODES nodes on {$MERGE_PART})"
  while true; do submit 0; sleep "$MERGE_FEED_S"; done ;;
status)
  mkmap; T=$(wc -l < "$SMAP"); M=$(merged_samples | wc -l); F=$(cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u | wc -l)
  printf 'merged %4d / %d   failed %d\n' "$M" "$T" "$F"
  echo "jobs:"; squeue -u "$USER" -h -o '  %i %j %T %M %N %r' 2>/dev/null | grep -F " $JOB"
  [ -s "$DONE_TSV" ] && awk -F'\t' -v t="$(date -u -d '1 hour ago' +%FT%TZ 2>/dev/null)" '$2>t{n++; b+=$4} END{printf "last 1h: %d samples, %.1f GB\n", n, b/1e9}' "$DONE_TSV"
  echo "by cohort (merged / samples · state):"
  cohort_table | awk -F'\t' '{st=($4>=$2)?"✓ done":($6?"▶ running":($3>0?"ready "$3:"waiting for qc")); printf "  %-14s %4d / %4d   %s%s\n", $1, $4, $2, st, ($5?"  ✗ "$5" failed":"")}'
  [ -s "$FAILED" ] && { echo "failed:"; sort -u "$FAILED" | head -20 | sed 's/^/  /'; }; true ;;
retry)
  [ -s "$FAILED" ] && { echo "clearing $(wc -l < "$FAILED") failure line(s) (kept in $FAILED.old)"; cat "$FAILED" >> "$FAILED.old"; : > "$FAILED"; }; true ;;
one)     mkmap; merge_one "$2" ;;
node)
  C="$2"; LIST="$CH/chunk.$C.txt"; [ -s "$LIST" ] || { echo "[node] $LIST missing/empty"; exit 1; }
  CORES=$(nproc); PER=$(awk -v c="$CORES" -v t="$MERGE_THREADS" -v o="$MERGE_OVERSUB" 'BEGIN{p=int(c/t*o); print (p<1)?1:p}')
  echo "[node] $(hostname) cores=$CORES cohort=$C samples=$(wc -l < "$LIST") parallel=$PER"
  LOADF="$CH/chunk.$C.load"
  ( while :; do printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$(hostname)" "$(cut -d' ' -f1 /proc/loadavg)" "$CORES" "$(pgrep -c -x cat)" 0 "$C" > "$LOADF.tmp" && mv "$LOADF.tmp" "$LOADF"; sleep 60; done ) &
  LOADPID=$!; trap 'kill $LOADPID 2>/dev/null; rm -f "$LOADF"' EXIT
  xargs -a "$LIST" -P "$PER" -I{} bash "$SELF" one {}
  echo "[node] done: merged $(merged_samples | wc -l) · failed $(cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u | wc -l)" ;;
*)       sed -n '14,24p' "$0" ;;
esac
