#!/usr/bin/env bash
# metaCRC — §06 assembly on K-BDS: metaFun ASSEMBLY_kbds.nf (metaSPAdes per sample), one BioProject chunk per node job. Thin wrapper like §04.
# Interface (claude/kbds.md 조립 접점, metaFun 창 2026-10-31):
#   reads     ~/metaCRC/reads/<BioProject>/<sample>_{1,2}.fastq.gz  — stage 0, merge_runs.py (single-run = link to the QC files, multi-run = gz concat)
#   sheet     make_asm_samplesheet.py --manifest $MANIFEST --reads-dir $READS_DIR --cohort <BioProject> --skip-done $ASM_DIR [--max-bases B] --out <run dir>/samplesheet.csv
#   run       cd runs/asm/<BioProject>[.<k>] && nextflow run $METAFUN_DIR/nf_scripts/ASSEMBLY_kbds.nf -c $METAFUN_DIR/config/kbds.config -profile kbds
#               --samplesheet $PWD/samplesheet.csv --outdir $ASM_DIR --run_dir $PWD --work_dir $PROJ/work/asm/<BioProject>_metaspades --assembler metaspades --cpus N --mem_gb 120 -resume
#   done      $ASM_DIR/<BioProject>/<sample>.done (written last); contigs <sample>.contigs.fa.gz (>= 500 bp), scaffolds, asm_logs/, <BioProject>.asm_summary.tsv
#   process   assemble (sample당 1, tag = sample), asm_summary (코호트당 1); failure = trace FAILED (retry 1 → ignore)
#   list      ./06_assemble_kbds.sh list → $ASMLIST (samples_assemble.txt) from the manifest; the office's assemble stage counts against it
#   packing   samples at a time on a node = min(nproc/8, RAM / mem_gb) and --cpus = nproc / that  (1 TB: 8 × 8 thr · 512 GB: 3 × 21 · 224 GB: 1 × 32)
# A sample is READY when its reads pair exists (single-run samples right after QC; multi-run after merge_runs.py). A cohort job takes its READY,
# not-yet-assembled samples; big cohorts are cut by --max-bases into runs/asm/<BioProject>.<k>/ so one job stays under the 120 h wall.
#
# Usage (login node, ~/office):
#   ./06_assemble_kbds.sh list                       write manifest/samples_assemble.txt (the office's assemble unit list) from the manifest
#   ./06_assemble_kbds.sh reads                      submit the reads stage (merge_runs.py --all) as one node job; rerunnable
#   ./06_assemble_kbds.sh pending                    per cohort: samples / reads ready / assembled / live
#   ./06_assemble_kbds.sh submit [N] [--cohort PRJ]  submit up to N cohort chunk jobs (smallest cohorts first)
#   ./06_assemble_kbds.sh feed                       loop in tmux (every ASM_FEED_S)
#   ./06_assemble_kbds.sh status                     assembled / total, jobs, node-hours so far, per-cohort ✓
#   ./06_assemble_kbds.sh node <chunk-id>            (what sbatch runs)
# Knobs (00_env_local.sh): METAFUN_DIR=$HOME/metaFun ASM_ENV=metacrc-asm ASM_ASSEMBLER=metaspades ASM_MEM_GB=120 ASM_MEM_GB_M512=115 ASM_MEM_GB_CPU32=100 ASM_RESERVE_GB=24 ASM_MAX_BASES=600e9
#   node packing = min(cores/8, (RAM−reserve)/mem) samples × (cores/that) threads: 1 TB → 8×8×120 GB · 512 GB → 4×16×115 · cpu32 224 GB → 2×16×100 (ASM_MEM_GB_*; a task above its -m cap fails → retry 1 → ignore, so put deep cohorts on the 1 TB nodes)
#   ASM_PART="cpu64-only cpu64-only-m512GB" ASM_MAX_NODES=4 ASM_TIME=96:00:00 ASM_FEED_S=900 ASM_NF_ARGS="" ASM_EXCLUDE=$PROJ/manifest/runs_to_exclude.tsv
#   ASM_SKIP_COHORTS="PRJEB45799 PRJNA1030952"      cohorts `submit`/`feed` never pick (tier 0: Valles-Colomer 2023 saliva/stool, bitBiome); `submit N --cohort X` still can
#   ASM_SKIP=$PROJ/manifest/asm_skip_samples.txt   one sample per line, left out of every samplesheet (assemblies that ran for days)
#   (ASM_MAX_NODES counts every live assembly job, metaFun asm_* ones included; the per-partition submit cap is the node count: cpu32 5 · cpu64 5 · m512GB 8 = 18)
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${USER:=$(id -un)}"
: "${QC_DIR:=$PROJ/qc}" "${READS_DIR:=$PROJ/reads}" "${ASM_DIR:=$PROJ/asm}" "${ASMLIST:=$PROJ/manifest/samples_assemble.txt}" "${METAFUN_DIR:=$HOME/metaFun}"
# metaFun files: fixed names, location found once under $METAFUN_DIR (the layout moved between patches); override with ASM_SHEET_PY / ASM_MERGE_PY / ASM_NF / ASM_NF_CONFIG
_mf() { local v="$1" name="$2" hit; eval "hit=\${$v:-}"; [ -n "$hit" ] || hit=$(find "$METAFUN_DIR" -name "$name" -not -path '*/work/*' -print -quit 2>/dev/null); [ -s "$hit" ] || { echo "[06] $name not found under $METAFUN_DIR (set $v=/path)" >&2; exit 2; }; echo "$hit"; }
: "${ASM_SKIP:=$PROJ/manifest/asm_skip_samples.txt}" "${ASM_SKIP_COHORTS:=PRJEB45799 PRJNA1030952}" "${ASM_ENV:=metacrc-asm}" "${ASM_ASSEMBLER:=metaspades}" "${ASM_MEM_GB:=120}" "${ASM_MEM_GB_CPU32:=100}" "${ASM_MEM_GB_M512:=115}" "${ASM_RESERVE_GB:=24}" "${ASM_MAX_BASES:=600e9}" "${ASM_PART:=cpu64-only cpu64-only-m512GB}" "${ASM_MAX_NODES:=4}"
: "${ASM_TIME:=96:00:00}" "${ASM_FEED_S:=900}" "${ASM_NF_ARGS:=}" "${ASM_EXCLUDE:=$PROJ/manifest/runs_to_exclude.tsv}"
JOB=metacrc-asm
CH="$PROJ/manifest/asm_chunks"; SMAP="$PROJ/manifest/sample_runs_all.tsv"; RUNS="$PROJ/runs/asm"; WORK="$PROJ/work/asm"
mkdir -p "$ASM_DIR" "$CH" "$RUNS" "$WORK" "$LOG_DIR"

# sample<TAB>cohort<TAB>run1,run2,...  for every sample in $ASMLIST (runs restricted to $RUNLIST, minus runs_to_exclude.tsv when present)
mkmap() {
  if [ ! -s "$SMAP" ] || [ "$MANIFEST" -nt "$SMAP" ] || [ "$ASMLIST" -nt "$SMAP" ] || [ "$RUNLIST" -nt "$SMAP" ] || { [ -s "$ASM_EXCLUDE" ] && [ "$ASM_EXCLUDE" -nt "$SMAP" ]; }; then
    awk -F'\t' -v M="$ASMLIST" -v L="$RUNLIST" -v X="$ASM_EXCLUDE" '
      BEGIN{ while((getline l < M)>0){ sub(/[ \t].*/,"",l); if(l!="" && l!~/^#/) want[l]=1 } while((getline l < L)>0){ if(l!="" && l!~/^#/) ok[l]=1 }
             while((getline l < X)>0){ split(l, f, "\t"); if(f[1]!="" && f[1]!~/^(#|run)/) ok[f[1]]=0 } }
      NR==1{ for(i=1;i<=NF;i++){ if($i=="run_accession")r=i; if($i=="sample_accession")s=i; if($i=="cohort_accession")c=i }; next }
      ($s in want) && ok[$r] { n[$s]++; runs[$s, n[$s]]=$r; coh[$s]=$c }
      END{ for (s in n) { m=n[s]; for(i=1;i<=m;i++) a[i]=runs[s,i]; for(i=1;i<=m;i++) for(j=i+1;j<=m;j++) if(a[j]<a[i]){t=a[i];a[i]=a[j];a[j]=t}
             line=a[1]; for(i=2;i<=m;i++) line=line","a[i]; printf "%s\t%s\t%s\n", s, coh[s], line; delete a } }' "$MANIFEST" | sort > "$SMAP.tmp" && mv "$SMAP.tmp" "$SMAP"
  fi
}
# samples_assemble.txt (= $ASMLIST, the office's unit list): every sample_accession with at least one run in $RUNLIST that is not in runs_to_exclude.tsv
mklist() {
  awk -F'\t' -v L="$RUNLIST" -v X="$ASM_EXCLUDE" '
    BEGIN{ while((getline l < L)>0){ if(l!="" && l!~/^#/) ok[l]=1 } while((getline l < X)>0){ split(l, f, "\t"); if(f[1]!="" && f[1]!~/^(#|run)/) ok[f[1]]=0 } }
    NR==1{ for(i=1;i<=NF;i++){ if($i=="run_accession")r=i; if($i=="sample_accession")s=i }; next }
    ok[$r] && !($s in seen) { seen[$s]=1; print $s }' "$MANIFEST" > "$ASMLIST.tmp" && mv "$ASMLIST.tmp" "$ASMLIST"
  echo "[list] $ASMLIST: $(wc -l < "$ASMLIST") samples (runs in $(basename "$RUNLIST")$( [ -s "$ASM_EXCLUDE" ] && echo " minus $(basename "$ASM_EXCLUDE")" ))"
}
# id<TAB>cohort of every live assembly job: this wrapper's metacrc-asm:<cohort>[.k] and metaFun's own driver asm_<cohort>[.k] (so a cohort it is running is never double-submitted)
live_jobs() { squeue -h -u "$USER" -o '%i|%j' 2>/dev/null | awk -F'|' -v j="$JOB" 'index($2, j)==1{c=substr($2, length(j)+2)} $2 ~ /^asm_/{c=substr($2, 5)} c!=""{sub(/\..*$/, "", c); print $1"\t"c; c=""}'; }
assembled()   { find "$ASM_DIR" -mindepth 2 -maxdepth 2 -name '*.done' -printf '%f\n' 2>/dev/null | sed 's/\.done$//'; }
reads_ready() { find "$READS_DIR" -mindepth 2 -maxdepth 2 -name '*_2.fastq.gz' -printf '%f\n' 2>/dev/null | sed 's/_2\.fastq\.gz$//'; }
# cohort  samples  reads_ready  assembled  live
cohort_table() {
  mkmap; local rr as lv; rr="$(mktemp)"; as="$(mktemp)"; lv="$(mktemp)"; reads_ready | sort > "$rr"; assembled | sort > "$as"; live_jobs | cut -f2 | sort -u > "$lv"
  awk -F'\t' -v RR="$rr" -v AS="$as" -v LV="$lv" 'BEGIN{ while((getline l < RR)>0) r[l]=1; while((getline l < AS)>0) a[l]=1; while((getline l < LV)>0) live[l]++ }
    { c=$2; tot[c]++; if ($1 in a) aa[c]++; else if ($1 in r) rd[c]++ }
    END{ for (c in tot) printf "%s\t%d\t%d\t%d\t%d\n", c, tot[c], rd[c]+0, aa[c]+0, live[c]+0 }' "$SMAP" | sort -t$'\t' -k2,2n
  rm -f "$rr" "$as" "$lv"
}
pick_part() { local best="" bestn=-1 p n; for p in $ASM_PART; do n=$(sinfo -h -p "$p" -t idle -o '%D' 2>/dev/null | awk '{s+=$1} END{print s+0}'); [ "$n" -gt "$bestn" ] && { best="$p"; bestn=$n; }; done; echo "${best:-${ASM_PART%% *}}"; }

submit_cohort() {   # $1 = BioProject, $2 = max jobs; chunks come from make_asm_samplesheet.py --max-bases (samplesheet.csv or samplesheet.<k>.csv)
  local c="$1" room="${2:-1}" rd="$RUNS/$c" part cores sub=0 sheet k id jid
  mkdir -p "$rd"
  python3 "$(_mf ASM_SHEET_PY make_asm_samplesheet.py)" --manifest "$MANIFEST" --reads-dir "$READS_DIR" --cohort "$c" --skip-done "$ASM_DIR" --max-bases "$ASM_MAX_BASES" --out "$rd/samplesheet.csv" \
    || { echo "[submit] $c: samplesheet failed" >&2; return 1; }
  for sheet in "$rd"/samplesheet.csv "$rd"/samplesheet.*.csv; do
    [ -s "$sheet" ] || continue; [ "$(wc -l < "$sheet")" -gt 1 ] || continue; [ "$sub" -lt "$room" ] || break
    # largest samples first (base_count, column 5): Nextflow starts tasks in sheet order, so the chunk's tail is made of small
    # samples and the node is not left running 1–2 long assemblies on 64 cores (seen 2026-11-08: load 8–16 on 1 TB nodes)
    { head -1 "$sheet"; tail -n +2 "$sheet" | sort -t, -k5,5gr; } > "$sheet.tmp" && mv -f "$sheet.tmp" "$sheet"
    # ASM_SKIP: one sample_accession per line (pathological assemblies that held a node for days) → dropped from the sheet, listed in the log
    if [ -s "$ASM_SKIP" ]; then awk -F, -v S="$ASM_SKIP" 'BEGIN{while((getline l<S)>0){sub(/[ \t#].*$/,"",l); if(l!="") skip[l]=1}} NR==1||!($1 in skip)' "$sheet" > "$sheet.tmp" && mv -f "$sheet.tmp" "$sheet"
      [ "$(wc -l < "$sheet")" -gt 1 ] || { echo "  $id: every sample is in $(basename "$ASM_SKIP") — nothing to submit" >&2; continue; }; fi
    k=$(basename "$sheet" | sed -n 's/^samplesheet\.\([0-9]*\)\.csv$/\1/p'); id="$c${k:+.$k}"; [ -z "$k" ] || { mkdir -p "$RUNS/$id"; cp -f "$sheet" "$RUNS/$id/samplesheet.csv"; }
    [ -s "$CH/chunk.$id.job" ] && squeue -h -j "$(cat "$CH/chunk.$id.job")" >/dev/null 2>&1 && continue   # already queued
    part="$(pick_part)"; cores=$(sinfo -h -p "$part" -o '%c' 2>/dev/null | head -1); [ -n "$cores" ] || cores=64
    jid=$(sbatch --parsable -J "$JOB:$id" -p "$part" -N 1 -n 1 -c "$cores" --exclusive -t "$ASM_TIME" -o "$RUNS/$id/slurm-%j.out" --wrap "bash '$SELF' node '$id'" 2>&1) \
      || { echo "[submit] $id: sbatch failed: $jid" >&2; break; }
    echo "$jid" > "$CH/chunk.$id.job"; sub=$(( sub + 1 ))
    echo "  job $jid  $JOB:$id  on $part ($cores cores) ← $(( $(wc -l < "$sheet") - 1 )) samples ($ASM_ASSEMBLER, -m $ASM_MEM_GB GB)" >&2
  done
  echo "$sub"
}
submit() {
  local want="${1:-0}" only="${2:-}" live room
  live=$(live_jobs | wc -l); room=$(( ASM_MAX_NODES - live )); [ "$room" -lt 0 ] && room=0
  [ "$want" -gt 0 ] && [ "$want" -lt "$room" ] && room=$want
  if [ -n "$only" ]; then echo "[submit] cohort $only (forced) · live $live · room $room"; submit_cohort "$only" "$(( room > 0 ? room : 1 ))" > /dev/null; return; fi
  local tbl; tbl="$(mktemp)"; cohort_table > "$tbl"
  echo "[submit] cohorts with reads-ready samples and no live job: $(awk -F'\t' '$3>0 && $5==0' "$tbl" | wc -l) · live jobs $live · room $room node(s) on {$ASM_PART}"
  while IFS=$'\t' read -r c tot rd aa lv; do
    [ "$room" -le 0 ] && break
    case " $ASM_SKIP_COHORTS " in *" $c "*) continue ;; esac   # tier-0 cohorts (not CRC) are never fed, whatever reads/ holds
    local n; n=$(submit_cohort "$c" "$room" | tail -1); room=$(( room - ${n:-0} ))
  done < <(awk -F'\t' '$3>0 && $5==0' "$tbl")
  rm -f "$tbl"
}

case "${1:-}" in
list)    mklist ;;
reads)
  part=$(sinfo -h -p cpu32-only -t idle -o '%D' 2>/dev/null | awk '{s+=$1} END{print ((s+0) > 0 ? "cpu32-only" : "cpu64-only")}')
  jid=$(sbatch --parsable -J "metacrc-reads" -p "$part" -N 1 -n 1 --exclusive -t 6:00:00 -o "$LOG_DIR/reads-%j.out" --wrap "bash '$SELF' reads-node") && echo "  job $jid metacrc-reads on $part (merge_runs.py --all → $READS_DIR)" ;;
reads-node)
  if ! command -v conda >/dev/null 2>&1; then for c in "${CONDA_ROOT:-}" "$HOME/miniconda3" "$HOME/anaconda3" /apps/application/miniconda3; do [ -n "$c" ] && [ -f "$c/etc/profile.d/conda.sh" ] && { source "$c/etc/profile.d/conda.sh"; break; }; done; fi
  eval "$(conda shell.bash hook)"; conda activate "$ASM_ENV" || { echo "[reads] conda env $ASM_ENV not found"; exit 1; }
  python3 "$(_mf ASM_MERGE_PY merge_runs.py)" --manifest "$MANIFEST" --qc-dir "$QC_DIR" --out-dir "$READS_DIR" --all; echo "[reads] exit $? · ready $(reads_ready | wc -l)" ;;
pending)
  mkmap; printf '%-14s %7s %11s %9s %5s\n' cohort samples reads_ready assembled live
  cohort_table | awk -F'\t' '{printf "%-14s %7d %11d %9d %5s\n", $1,$2,$3,$4,($5?"▶"$5:"")}'
  echo "samples in $ASMLIST: $(grep -cv '^\s*\(#\|$\)' "$ASMLIST") · mapped: $(wc -l < "$SMAP")$( [ -s "$ASM_EXCLUDE" ] && echo " · excluded runs applied: $(grep -cv '^\s*\(#\|run\|$\)' "$ASM_EXCLUDE")" ) · reads dir: $READS_DIR" ;;
submit)  if [ "${2:-}" = --cohort ]; then submit 0 "$3"; elif [ "${3:-}" = --cohort ]; then submit "${2:-0}" "$4"; else submit "${2:-0}"; fi ;;
feed)    echo "[feed] every ${ASM_FEED_S}s: submit cohorts with reads-ready samples (≤ $ASM_MAX_NODES nodes on {$ASM_PART}, $ASM_ASSEMBLER)"; while true; do submit 0; sleep "$ASM_FEED_S"; done ;;
status)
  mkmap; T=$(wc -l < "$SMAP"); A=$(assembled | wc -l)
  printf 'assembled %5d / %d   reads ready %d\n' "$A" "$T" "$(reads_ready | wc -l)"
  echo "jobs:"; squeue -u "$USER" -h -o '  %i %j %T %M %N %r' 2>/dev/null | grep -F " $JOB"
  cat "$ASM_DIR"/*/*.asm_summary.tsv 2>/dev/null | awk -F'\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="wall_sec")w=i;if($i=="mem_gb")m=i};next} w&&$w!=""{n++; s+=$w; if($m>mx)mx=$m} END{if(n) printf "done %d · mean %.0f min/sample · peak mem max %.0f GB\n", n, s/n/60, mx}'
  echo "by cohort (assembled / samples · state):"
  cohort_table | awk -F'\t' '{st=($4>=$2)?"✓ done":($5?"▶ "$5" job(s)":($3>0?"ready "$3:"waiting for reads")); printf "  %-14s %5d / %5d   %s\n", $1, $4, $2, st}'; true ;;
node)
  ID="$2"; RD="$RUNS/$ID"; cd "$RD" || exit 1; C="${ID%%.*}"
  if ! command -v conda >/dev/null 2>&1; then for c in "${CONDA_ROOT:-}" "$HOME/miniconda3" "$HOME/anaconda3" /apps/application/miniconda3; do [ -n "$c" ] && [ -f "$c/etc/profile.d/conda.sh" ] && { source "$c/etc/profile.d/conda.sh"; break; }; done; fi
  eval "$(conda shell.bash hook)"; conda activate "$ASM_ENV" || { echo "[node] conda env $ASM_ENV not found"; exit 1; }
  export NXF_OFFLINE=true
  CORES=$(nproc); RAMT=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo); RAM=$(( RAMT - ASM_RESERVE_GB ))   # leave ASM_RESERVE_GB for the OS, nextflow and page cache
  # per-sample -m by node class (user decisions 2026-11-08/10): 1 TB → 8 × 8 thr × 120 GB · 512 GB → 4 × 16 × 115 · cpu32 224 GB → 2 × 16 × 100
  MEM=$ASM_MEM_GB; if [ "$RAMT" -le 300 ]; then MEM=${ASM_MEM_GB_CPU32:-$MEM}; elif [ "$RAMT" -le 600 ]; then MEM=${ASM_MEM_GB_M512:-$MEM}; fi
  PER=$(( CORES / 8 )); [ $(( RAM / MEM )) -lt "$PER" ] && PER=$(( RAM / MEM )); [ "$PER" -lt 1 ] && PER=1; CPUS=${CPUS:-$(( CORES / PER ))}
  echo "[node] $(hostname) cores=$CORES ram=${RAM}G chunk=$ID samples=$(( $(wc -l < samplesheet.csv) - 1 )) $ASM_ASSEMBLER: $PER at a time × $CPUS thr × $MEM GB"
  LOADF="$CH/chunk.$ID.load"
  ( while :; do printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$(hostname)" "$(cut -d' ' -f1 /proc/loadavg)" "$CORES" "$(pgrep -c -f spades-core)" "$(pgrep -c -f megahit_core)" "$ID" > "$LOADF.tmp" && mv "$LOADF.tmp" "$LOADF"; sleep 60; done ) &
  LOADPID=$!; trap 'kill $LOADPID 2>/dev/null; rm -f "$LOADF"' EXIT
  nextflow run "$(_mf ASM_NF ASSEMBLY_kbds.nf)" -c "$(_mf ASM_NF_CONFIG kbds.config)" -profile kbds \
    --samplesheet "$PWD/samplesheet.csv" --outdir "$ASM_DIR" --run_dir "$PWD" --work_dir "$WORK/${ID}_$ASM_ASSEMBLER" --assembler "$ASM_ASSEMBLER" --cpus "$CPUS" --mem_gb "$MEM" -resume $ASM_NF_ARGS
  RC=$?; echo "[node] nextflow exit $RC · done $(ls "$ASM_DIR/$C"/*.done 2>/dev/null | wc -l)"; exit $RC ;;
*)       sed -n '13,22p' "$SELF" ;;
esac
