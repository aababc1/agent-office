#!/usr/bin/env bash
# metaCRC — §06 de novo assembly on K-BDS, one sample at a time on node-packed cohort chunks (like §03–§05).
#   ASM_TOOL=metaspades (decision 2026-10-30, metaFun window) → `spades.py --meta -1 R1 -2 R2 -o <tmp> -t ASM_THREADS -m <GB> $ASM_SPADES_ARGS`,
#            contigs = <tmp>/contigs.fasta;  ASM_TOOL=megahit (runbook 06 original) → `megahit … -o <tmp> -t -m <bytes> $ASM_MEGAHIT_ARGS`, contigs = final.contigs.fa.
#   Tool options are the tool's defaults plus -t/-m/-o; k, --only-assembler, min contig length etc. go in ASM_SPADES_ARGS / ASM_MEGAHIT_ARGS once decided.
#   unit     sample from $ASMLIST (samples_assemble.txt, PAIRED samples); its runs = manifest rows with that sample_accession in $RUNLIST
#   input    1 run  → $QC_DIR/<BioProject>/<run>_1|_2.fastq.gz (needs the QC marker <run>.done)
#            ≥2 runs → $MRG_DIR/<BioProject>/<sample>_R1|_R2.fastq.gz (§05 output; _R1 is written last = both present)
#            A sample whose input is not there yet simply waits (QC/merge still running) — not a failure.
#   output   $ASM_DIR/<BioProject>/<sample>/contigs.renamed.fa (completion marker, written last) + the tool's log (spades.log/params.txt or megahit.log/options.json).
#            Headers: ">{sample}_c{n} {original MEGAHIT header}" (e.g. ">SAMEA123_c1 k141_7 flag=1 multi=3.0 len=1234"), so every
#            contig id is unique across samples (needed for binning/dereplication) and nothing from MEGAHIT's header is lost.
#            The tool's work dir (K* / corrected / intermediate_contigs …) is deleted after the rename; a crashed sample is restarted from scratch.
#   failed   $LOG_DIR/asm.FAILED "<sample> NO_INPUT|ASM_FAIL|EMPTY <when>"; asm_done.tsv: sample when seconds peak_rss_kb contigs bases cohort input tool
#   node     one sbatch = one exclusive node; samples at a time = min(cores / ASM_THREADS, RAM × ASM_MEM_FRAC / ASM_MEM_GB_PER_SAMPLE); if memory is the
#            limit the threads per sample grow to fill the cores. Big cohorts are cut into ASM_CHUNK-sample jobs (metacrc-asm:<BioProject>.<k>) to stay under the 120 h wall.
#
# Usage (login node, ~/office):
#   ./06_assemble_kbds.sh pending                per cohort: samples / ready / assembled / failed / live jobs
#   ./06_assemble_kbds.sh submit [N] [--cohort PRJ]   submit up to N node jobs (cohorts with READY samples, smallest first)
#   ./06_assemble_kbds.sh feed                   loop in tmux (every ASM_FEED_S)
#   ./06_assemble_kbds.sh status                 assembled / total, jobs, last-hour throughput + node-hours so far, per-cohort ✓
#   ./06_assemble_kbds.sh retry                  clear asm.FAILED (failed samples go back to the queue)
#   ./06_assemble_kbds.sh node <chunk-id>        (what sbatch runs)   ·   one <sample>   (assemble one sample here, for a check)
# Knobs (00_env_local.sh): ASM_TOOL=metaspades ASM_ENV=metacrc-asm ASM_PART="cpu64-only cpu64-only-m512GB" ASM_MAX_NODES=4 ASM_THREADS=8
#   ASM_CHUNK (metaspades 32 / megahit 160)  ASM_MEM_GB_PER_SAMPLE (metaspades 120 / megahit 40)  ASM_TIME=96:00:00 ASM_FEED_S=900 ASM_MEM_FRAC=0.9
#   ASM_SPADES_ARGS="" ASM_MEGAHIT_ARGS=""
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${USER:=$(id -un)}"
: "${QC_DIR:=$PROJ/qc}" "${MRG_DIR:=$PROJ/merged}" "${ASM_DIR:=$PROJ/assembly}" "${ASMLIST:=$PROJ/manifest/samples_assemble.txt}"
: "${ASM_TOOL:=metaspades}" "${ASM_ENV:=metacrc-asm}" "${ASM_PART:=cpu64-only cpu64-only-m512GB}" "${ASM_MAX_NODES:=4}" "${ASM_THREADS:=8}"
: "${ASM_TIME:=96:00:00}" "${ASM_FEED_S:=900}" "${ASM_SPADES_ARGS:=}" "${ASM_MEGAHIT_ARGS:=}" "${ASM_MEM_FRAC:=0.9}"
case "$ASM_TOOL" in
  metaspades) : "${ASM_CHUNK:=32}"  "${ASM_MEM_GB_PER_SAMPLE:=120}"; ASM_BIN=spades.py; ASM_PROC=spades-core ;;
  megahit)    : "${ASM_CHUNK:=160}" "${ASM_MEM_GB_PER_SAMPLE:=40}";  ASM_BIN=megahit;   ASM_PROC=megahit_core ;;
  *) echo "ASM_TOOL must be metaspades or megahit (got '$ASM_TOOL')" >&2; exit 1 ;;
esac
JOB=metacrc-asm
CH="$PROJ/manifest/asm_chunks"; SMAP="$PROJ/manifest/sample_runs_all.tsv"; FAILED="$LOG_DIR/asm.FAILED"; DONE_TSV="$LOG_DIR/asm_done.tsv"
mkdir -p "$ASM_DIR" "$CH" "$LOG_DIR"

# sample<TAB>cohort<TAB>run1,run2,...  for every sample in $ASMLIST (runs restricted to $RUNLIST, sorted)
mkmap() {
  if [ ! -s "$SMAP" ] || [ "$MANIFEST" -nt "$SMAP" ] || [ "$ASMLIST" -nt "$SMAP" ] || [ "$RUNLIST" -nt "$SMAP" ]; then
    awk -F'\t' -v M="$ASMLIST" -v L="$RUNLIST" '
      BEGIN{ while((getline l < M)>0){ sub(/[ \t].*/,"",l); if(l!="" && l!~/^#/) want[l]=1 } while((getline l < L)>0){ if(l!="" && l!~/^#/) ok[l]=1 } }
      NR==1{ for(i=1;i<=NF;i++){ if($i=="run_accession")r=i; if($i=="sample_accession")s=i; if($i=="cohort_accession")c=i }; next }
      ($s in want) && ($r in ok) { n[$s]++; runs[$s, n[$s]]=$r; coh[$s]=$c }
      END{ for (s in n) { m=n[s]; for(i=1;i<=m;i++) a[i]=runs[s,i]; for(i=1;i<=m;i++) for(j=i+1;j<=m;j++) if(a[j]<a[i]){t=a[i];a[i]=a[j];a[j]=t}
             line=a[1]; for(i=2;i<=m;i++) line=line","a[i]; printf "%s\t%s\t%s\n", s, coh[s], line; delete a } }' "$MANIFEST" | sort > "$SMAP.tmp" && mv "$SMAP.tmp" "$SMAP"
  fi
}
live_jobs() { squeue -h -u "$USER" -o '%i|%j' 2>/dev/null | awk -F'|' -v j="$JOB" 'index($2, j)==1{c=substr($2, length(j)+2); sub(/\..*$/, "", c); print $1"\t"c}'; }   # id<TAB>cohort
assembled() { find "$ASM_DIR" -mindepth 3 -maxdepth 3 -name contigs.renamed.fa -printf '%h\n' 2>/dev/null | xargs -r -n1 basename; }
# input pair for a sample: prints "R1 R2" or nothing
input_of() {   # $1 sample  $2 cohort  $3 runs(csv)
  local s="$1" c="$2" runs="$3"
  if [[ "$runs" == *,* ]]; then
    [ -s "$MRG_DIR/$c/${s}_R1.fastq.gz" ] && [ -s "$MRG_DIR/$c/${s}_R2.fastq.gz" ] && echo "$MRG_DIR/$c/${s}_R1.fastq.gz $MRG_DIR/$c/${s}_R2.fastq.gz"
  else
    [ -f "$QC_DIR/$c/$runs.done" ] && [ -s "$QC_DIR/$c/${runs}_1.fastq.gz" ] && [ -s "$QC_DIR/$c/${runs}_2.fastq.gz" ] && echo "$QC_DIR/$c/${runs}_1.fastq.gz $QC_DIR/$c/${runs}_2.fastq.gz"
  fi
}
# READY samples of one cohort (input present, not assembled, not failed, not in a live chunk)
ready_samples() {
  local c="$1" as fl lv; as="$(mktemp)"; fl="$(mktemp)"; lv="$(mktemp)"
  assembled > "$as"; cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"
  for id in $(live_jobs | cut -f1); do f="$CH/chunk.$(awk -F'\t' -v i="$id" '$1==i{print $2}' "$CH/jobs.tsv" 2>/dev/null).txt"; [ -s "$f" ] && cat "$f"; done | sort -u > "$lv"
  local qd md; qd="$(mktemp)"; md="$(mktemp)"
  find "$QC_DIR" -mindepth 2 -maxdepth 2 -name '*.done' -printf '%f\n' 2>/dev/null | sed 's/\.done$//' | sort > "$qd"
  find "$MRG_DIR" -mindepth 2 -maxdepth 2 -name '*_R1.fastq.gz' -printf '%f\n' 2>/dev/null | sed 's/_R1\.fastq\.gz$//' | sort > "$md"
  awk -F'\t' -v C="$c" -v AS="$as" -v FL="$fl" -v LV="$lv" -v QD="$qd" -v MD="$md" '
    BEGIN{ while((getline l < AS)>0) a[l]=1; while((getline l < FL)>0) f[l]=1; while((getline l < LV)>0) v[l]=1; while((getline l < QD)>0) q[l]=1; while((getline l < MD)>0) m[l]=1 }
    $2==C && !($1 in a) && !($1 in f) && !($1 in v) { if ($3 ~ /,/) { if ($1 in m) print $1 } else if ($3 in q) print $1 }' "$SMAP"
  rm -f "$as" "$fl" "$lv" "$qd" "$md"
}
# cohort  samples  ready  assembled  failed  live
cohort_table() {
  mkmap
  local as fl lv qd md; as="$(mktemp)"; fl="$(mktemp)"; lv="$(mktemp)"; qd="$(mktemp)"; md="$(mktemp)"
  assembled > "$as"; cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u > "$fl"; live_jobs | cut -f2 | sort -u > "$lv"
  find "$QC_DIR" -mindepth 2 -maxdepth 2 -name '*.done' -printf '%f\n' 2>/dev/null | sed 's/\.done$//' | sort > "$qd"
  find "$MRG_DIR" -mindepth 2 -maxdepth 2 -name '*_R1.fastq.gz' -printf '%f\n' 2>/dev/null | sed 's/_R1\.fastq\.gz$//' | sort > "$md"
  awk -F'\t' -v AS="$as" -v FL="$fl" -v LV="$lv" -v QD="$qd" -v MD="$md" '
    BEGIN{ while((getline l < AS)>0) a[l]=1; while((getline l < FL)>0) f[l]=1; while((getline l < LV)>0) live[l]++; while((getline l < QD)>0) q[l]=1; while((getline l < MD)>0) m[l]=1 }
    { c=$2; tot[c]++; if ($1 in a) { aa[c]++; next } if ($1 in f) { ff[c]++; next }
      if ($3 ~ /,/) { if ($1 in m) rd[c]++ } else if ($3 in q) rd[c]++ }
    END{ for (c in tot) printf "%s\t%d\t%d\t%d\t%d\t%d\n", c, tot[c], rd[c]+0, aa[c]+0, ff[c]+0, live[c]+0 }' "$SMAP" | sort -t$'\t' -k2,2n
  rm -f "$as" "$fl" "$lv" "$qd" "$md"
}
pick_part() { local best="" bestn=-1 p n; for p in $ASM_PART; do n=$(sinfo -h -p "$p" -t idle -o '%D' 2>/dev/null | awk '{s+=$1} END{print s+0}'); [ "$n" -gt "$bestn" ] && { best="$p"; bestn=$n; }; done; echo "${best:-${ASM_PART%% *}}"; }

# the per-sample recipe (runs on the node; $ASM_MEM_GB set by `node`, or derived here for `one`)
asm_one() {
  local s="$1" line c runs in r1 r2 out tmp t0 rc mem="${ASM_MEM_GB:-}"
  line=$(awk -F'\t' -v s="$s" '$1==s' "$SMAP"); [ -n "$line" ] || { echo "[asm] $s: not in $ASMLIST/manifest" >&2; return 1; }
  c=$(cut -f2 <<<"$line"); runs=$(cut -f3 <<<"$line"); out="$ASM_DIR/$c/$s"; tmp="$out/.$ASM_TOOL"
  [ -s "$out/contigs.renamed.fa" ] && { echo "[asm] $s: already assembled"; return 0; }
  in=$(input_of "$s" "$c" "$runs"); [ -n "$in" ] || { echo "$s NO_INPUT $(date -u +%FT%TZ)" >> "$FAILED"; echo "[asm] $s: NO_INPUT"; return 2; }
  read -r r1 r2 <<<"$in"
  [ -n "$mem" ] || mem=$(awk -v f="$ASM_MEM_FRAC" '/MemTotal/{printf "%d", $2/1048576*f}' /proc/meminfo)
  mkdir -p "$out"; rm -rf "$tmp"; t0=$(date +%s)
  local timer=() contigs logf; [ -x /usr/bin/time ] && timer=(/usr/bin/time -v -o "$out/time.txt")
  if [ "$ASM_TOOL" = metaspades ]; then
    "${timer[@]}" spades.py --meta -1 "$r1" -2 "$r2" -o "$tmp" -t "$ASM_THREADS" -m "$mem" $ASM_SPADES_ARGS > "$out/$ASM_TOOL.stdout" 2>&1; rc=$?
    contigs="$tmp/contigs.fasta"; logf="$tmp/spades.log"
  else
    "${timer[@]}" megahit -1 "$r1" -2 "$r2" -o "$tmp" -t "$ASM_THREADS" -m "$(( mem * 1073741824 ))" $ASM_MEGAHIT_ARGS > "$out/$ASM_TOOL.stdout" 2>&1; rc=$?
    contigs="$tmp/final.contigs.fa"; logf="$tmp/log"
  fi
  if [ $rc -ne 0 ] || [ ! -s "$contigs" ]; then
    cp -f "$logf" "$out/$ASM_TOOL.log" 2>/dev/null; rm -rf "$tmp"; echo "$s ASM_FAIL $(date -u +%FT%TZ)" >> "$FAILED"; echo "[asm] $s: ASM_FAIL rc=$rc (see $out/$ASM_TOOL.log)"; return 2
  fi
  local nctg nbases
  awk -v s="$s" 'BEGIN{n=0} /^>/{n++; sub(/^>/,""); print ">"s"_c"n" "$0; next} {print}' "$contigs" > "$out/.contigs.renamed.part" || { rm -rf "$tmp" "$out/.contigs.renamed.part"; echo "$s ASM_FAIL $(date -u +%FT%TZ)" >> "$FAILED"; return 2; }
  read -r nctg nbases < <(awk '/^>/{n++; next} {b+=length($0)} END{print n+0, b+0}' "$out/.contigs.renamed.part")
  [ "$nctg" -gt 0 ] || { rm -rf "$tmp" "$out/.contigs.renamed.part"; echo "$s EMPTY $(date -u +%FT%TZ)" >> "$FAILED"; echo "[asm] $s: EMPTY (no contigs)"; return 2; }
  cp -f "$logf" "$out/$ASM_TOOL.log"; cp -f "$tmp/params.txt" "$tmp/options.json" "$out/" 2>/dev/null; rm -rf "$tmp"
  mv "$out/.contigs.renamed.part" "$out/contigs.renamed.fa"       # marker, last
  local rss; rss=$(awk '/Maximum resident set size/{print $NF}' "$out/time.txt" 2>/dev/null)
  printf '%s\t%s\t%d\t%s\t%d\t%d\t%s\t%s\t%s\n' "$s" "$(date -u +%FT%TZ)" "$(( $(date +%s) - t0 ))" "${rss:-NA}" "$nctg" "$nbases" "$c" "$(basename "$r1")" "$ASM_TOOL" >> "$DONE_TSV"
  echo "[asm] $s: ok $nctg contigs, $(( nbases / 1000000 )) Mb, $(( ( $(date +%s) - t0 ) / 60 )) min, peak ${rss:-?} kB"
}

submit_cohort() {   # $1 = BioProject
  local c="$1" part cores n k=0 id jid rl; rl="$(mktemp)"
  mkmap; ready_samples "$c" > "$rl"; n=$(wc -l < "$rl")
  [ "$n" -gt 0 ] || { echo "[submit] $c: no READY sample" >&2; rm -f "$rl"; return 1; }
  local room="${2:-1}" sub=0
  while [ "$sub" -lt "$room" ] && [ -s "$rl" ]; do
    k=$(( $(ls "$CH"/chunk."$c".*.txt 2>/dev/null | wc -l) + 1 )); id="$c.$k"
    head -n "$ASM_CHUNK" "$rl" > "$CH/chunk.$id.txt"; sed -i "1,${ASM_CHUNK}d" "$rl"
    part="$(pick_part)"; cores=$(sinfo -h -p "$part" -o '%c' 2>/dev/null | head -1); [ -n "$cores" ] || cores=64
    jid=$(sbatch --parsable -J "$JOB:$id" -p "$part" -N 1 -n 1 -c "$cores" --exclusive -t "$ASM_TIME" -o "$LOG_DIR/asm-$id-%j.out" --wrap "bash '$SELF' node '$id'" 2>&1) \
      || { echo "[submit] $id: sbatch failed: $jid" >&2; rm -f "$CH/chunk.$id.txt"; break; }
    printf '%s\t%s\n' "$jid" "$id" >> "$CH/jobs.tsv"; sub=$(( sub + 1 ))
    echo "  job $jid  $JOB:$id  on $part ($cores cores, $(( cores / ASM_THREADS )) × ${ASM_THREADS} thr) ← $(wc -l < "$CH/chunk.$id.txt") samples ($ASM_TOOL)" >&2
  done
  rm -f "$rl"; echo "$sub"
}
submit() {
  local want="${1:-0}" only="${2:-}" live room
  live=$(live_jobs | wc -l); room=$(( ASM_MAX_NODES - live )); [ "$room" -lt 0 ] && room=0
  [ "$want" -gt 0 ] && [ "$want" -lt "$room" ] && room=$want
  if [ -n "$only" ]; then echo "[submit] cohort $only (forced) · live $live · room $room"; submit_cohort "$only" "$(( room > 0 ? room : 1 ))" > /dev/null; return; fi
  local tbl; tbl="$(mktemp)"; cohort_table > "$tbl"
  echo "[submit] cohorts with READY samples: $(awk -F'\t' '$3>0' "$tbl" | wc -l) · live jobs $live · room $room node(s) on {$ASM_PART}"
  while IFS=$'\t' read -r c tot rd aa ff lv; do
    [ "$room" -le 0 ] && break
    local n; n=$(submit_cohort "$c" "$room" | tail -1); room=$(( room - ${n:-0} ))
  done < <(awk -F'\t' '$3>0' "$tbl")
  rm -f "$tbl"
}

case "${1:-}" in
pending)
  mkmap; printf '%-14s %7s %6s %9s %6s %5s\n' cohort samples ready assembled failed live
  cohort_table | awk -F'\t' '{printf "%-14s %7d %6d %9d %6d %5s\n", $1,$2,$3,$4,$5,($6?"▶"$6:"")}'
  echo "samples in $ASMLIST: $(grep -cv '^\s*\(#\|$\)' "$ASMLIST") · mapped: $(wc -l < "$SMAP") (single-run → qc/, multi-run → merged/)" ;;
submit)  if [ "${2:-}" = --cohort ]; then submit 0 "$3"; elif [ "${3:-}" = --cohort ]; then submit "${2:-0}" "$4"; else submit "${2:-0}"; fi ;;
feed)    echo "[feed] every ${ASM_FEED_S}s: submit READY samples (≤ $ASM_MAX_NODES nodes on {$ASM_PART}, $ASM_CHUNK samples/job)"; while true; do submit 0; sleep "$ASM_FEED_S"; done ;;
status)
  mkmap; T=$(wc -l < "$SMAP"); A=$(assembled | wc -l); F=$(cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u | wc -l)
  printf 'assembled %5d / %d   failed %d\n' "$A" "$T" "$F"
  echo "jobs:"; squeue -u "$USER" -h -o '  %i %j %T %M %N %r' 2>/dev/null | grep -F " $JOB"
  [ -s "$DONE_TSV" ] && awk -F'\t' -v t="$(date -u -d '1 hour ago' +%FT%TZ 2>/dev/null)" -v thr="$ASM_THREADS" '{n++; s+=$3; if($2>t) h++; if($4!="NA"&&$4>rss) rss=$4} END{printf "done %d · mean %.0f min/sample at %d thr · peak RSS max %.0f GB · last 1h %d\n", n, s/n/60, thr, rss/1048576, h}' "$DONE_TSV"
  echo "by cohort (assembled / samples · state):"
  cohort_table | awk -F'\t' '{st=($4>=$2)?"✓ done":($6?"▶ "$6" job(s)":($3>0?"ready "$3:"waiting for qc/merge")); printf "  %-14s %5d / %5d   %s%s\n", $1, $4, $2, st, ($5?"  ✗ "$5" failed":"")}'
  [ -s "$FAILED" ] && { echo "failed:"; sort -u "$FAILED" | tail -10 | sed 's/^/  /'; }; true ;;
retry)   [ -s "$FAILED" ] && { echo "clearing $(wc -l < "$FAILED") failure line(s) (kept in $FAILED.old)"; cat "$FAILED" >> "$FAILED.old"; : > "$FAILED"; }; true ;;
one)     mkmap; asm_one "$2" ;;
node)
  ID="$2"; LIST="$CH/chunk.$ID.txt"; [ -s "$LIST" ] || { echo "[node] $LIST missing/empty"; exit 1; }
  if ! command -v conda >/dev/null 2>&1; then for c in "${CONDA_ROOT:-}" "$HOME/miniconda3" "$HOME/anaconda3" /apps/application/miniconda3; do [ -n "$c" ] && [ -f "$c/etc/profile.d/conda.sh" ] && { source "$c/etc/profile.d/conda.sh"; break; }; done; fi
  eval "$(conda shell.bash hook)"; conda activate "$ASM_ENV" || { echo "[node] conda env $ASM_ENV not found"; exit 1; }
  command -v "$ASM_BIN" >/dev/null || { echo "[node] $ASM_BIN not on PATH (env $ASM_ENV)"; exit 1; }
  CORES=$(nproc); RAM=$(awk -v f="$ASM_MEM_FRAC" '/MemTotal/{printf "%d", $2/1048576*f}' /proc/meminfo)
  PER=$(( CORES / ASM_THREADS )); [ $(( RAM / ASM_MEM_GB_PER_SAMPLE )) -lt "$PER" ] && PER=$(( RAM / ASM_MEM_GB_PER_SAMPLE )); [ "$PER" -lt 1 ] && PER=1
  export ASM_THREADS=$(( CORES / PER )) ASM_MEM_GB=$(( RAM / PER ))        # fill the node: memory decides how many, threads take the rest
  echo "[node] $(hostname) cores=$CORES ram=${RAM}G chunk=$ID samples=$(wc -l < "$LIST") tool=$ASM_TOOL parallel=$PER × $ASM_THREADS thr · $ASM_MEM_GB GB each · $($ASM_BIN --version 2>&1 | head -1)"
  LOADF="$CH/chunk.$ID.load"
  ( while :; do printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$(hostname)" "$(cut -d' ' -f1 /proc/loadavg)" "$CORES" "$(pgrep -c -f "$ASM_PROC")" 0 "$ID" > "$LOADF.tmp" && mv "$LOADF.tmp" "$LOADF"; sleep 60; done ) &
  LOADPID=$!; trap 'kill $LOADPID 2>/dev/null; rm -f "$LOADF"' EXIT
  export SMAP ASMLIST QC_DIR MRG_DIR ASM_DIR FAILED DONE_TSV ASM_TOOL ASM_THREADS ASM_SPADES_ARGS ASM_MEGAHIT_ARGS ASM_MEM_FRAC
  xargs -a "$LIST" -P "$PER" -I{} bash "$SELF" one {}
  echo "[node] chunk $ID done: assembled $(assembled | wc -l) · failed $(cut -d' ' -f1 "$FAILED" 2>/dev/null | sort -u | wc -l)" ;;
*)       sed -n '16,24p' "$SELF" ;;
esac
