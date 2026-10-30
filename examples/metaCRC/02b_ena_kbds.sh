#!/usr/bin/env bash
# metaCRC — §02b ENA fallback: runs that prefetch cannot get from NCBI are fetched as FASTQ from ENA (login node, like §02).
# Why: for some ENA-submitted runs NCBI keeps the .sra only in the AWS Open Data bucket (SDL: s3:us-east-1) or as .sralite,
# so `prefetch` 2.11.2 from K-BDS fails every time (34 runs on 2026-10-30, all ERR*). ENA has the submitted FASTQ for all of them.
# What it does, per run in $LOG_DIR/prefetch.FAILED (or the runs given on the command line):
#   1. ENA filereport (read_run: fastq_ftp, fastq_md5, fastq_bytes) → the <run>_1.fastq.gz / <run>_2.fastq.gz pair (no unpaired file)
#   2. download both into $TMP_DIR/ena/<run>/ with curl (https, resume, 5 retries), check md5 against ENA's
#   3. mv _2 then _1 into $FQ_DIR/<BioProject>/ — exactly where §03 puts its output, so the dump stage (and prefetch via
#      implied_by) counts the run as done. ENA's files are plain gzip, like §03's pigz output; QC (fastp) reads either.
#   4. ena_done.tsv (run when seconds bytes cohort) · remove the run from prefetch.FAILED and dump.FAILED
# Usage (login node, ~/office):
#   ./02b_ena_kbds.sh list [RUN...]         what ENA has for the failed runs (bytes per file), no download
#   ./02b_ena_kbds.sh run  [RUN...]         download (ENA_PARALLEL at a time; run inside tmux)
#   ./02b_ena_kbds.sh status
# Knobs (00_env_local.sh): ENA_PARALLEL=4 ENA_BASE=https://ftp.sra.ebi.ac.uk (fastq_ftp paths are relative to this host)
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./00_env_local.sh
: "${FQ_DIR:=$PROJ/fastq}" "${TMP_DIR:=$PROJ/tmp}" "${ENA_PARALLEL:=4}" "${ENA_BASE:=https://ftp.sra.ebi.ac.uk}" "${ENA_API:=https://www.ebi.ac.uk/ena/portal/api/filereport}"
MAP="$PROJ/manifest/run_cohort.tsv"; PF_FAILED="$LOG_DIR/prefetch.FAILED"; DUMP_FAILED="$LOG_DIR/dump.FAILED"; DONE_TSV="$LOG_DIR/ena_done.tsv"; ENA_FAILED="$LOG_DIR/ena.FAILED"
mkdir -p "$TMP_DIR/ena" "$LOG_DIR"

mkmap() {
  if [ ! -s "$MAP" ] || [ "$MANIFEST" -nt "$MAP" ]; then
    awk -F'\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="run_accession")r=i;if($i=="cohort_accession")c=i};next} r&&c&&$r!=""{print $r"\t"$c}' "$MANIFEST" > "$MAP.tmp" && mv "$MAP.tmp" "$MAP"
  fi
}
cohort_of() { awk -F'\t' -v r="$1" '$1==r{print $2; exit}' "$MAP"; }
# ENA record → "path1 md5_1 bytes1 path2 md5_2 bytes2": ENA's generated pair <run>_1/_2.fastq.gz; if ENA has not generated FASTQ yet
# (recent submissions: fastq_ftp empty), the submitter's own pair from submitted_ftp (two FASTQ files named *_1/*_2 or *R1/*R2). "" if neither.
ena_pair() {
  curl -sS --retry 3 "$ENA_API?accession=$1&result=read_run&fields=run_accession,fastq_ftp,fastq_md5,fastq_bytes,submitted_ftp,submitted_md5,submitted_bytes,submitted_format" 2>/dev/null \
  | awk -F'\t' -v r="$1" 'function pick(P,M,B,   n,p,m,b,i,p1,m1,b1,p2,m2,b2){ n=split(P,p,";"); split(M,m,";"); split(B,b,";")
      for(i=1;i<=n;i++){ if(p[i] ~ /(_1|_R1|R1_001)\.(fastq|fq)\.gz$/){p1=p[i];m1=m[i];b1=b[i]} else if(p[i] ~ /(_2|_R2|R2_001)\.(fastq|fq)\.gz$/){p2=p[i];m2=m[i];b2=b[i]} }
      if(p1!="" && p2!="") return p1" "m1" "b1" "p2" "m2" "b2; return "" }
    NR>1 && $1==r { out=pick($2,$3,$4); if(out=="" && $8 ~ /^FASTQ;FASTQ$/) out=pick($5,$6,$7); if(out!="") print out }'
}
rel() { local p="$1"; p="${p#ftp.sra.ebi.ac.uk}"; p="${p#*//ftp.sra.ebi.ac.uk}"; echo "$p"; }   # ENA lists "ftp.sra.ebi.ac.uk/vol1/…"

fetch_one() {   # $1 = run
  local r="$1" c rec p1 m1 b1 p2 m2 b2 d t0 f1 f2 h
  c=$(cohort_of "$r"); [ -n "$c" ] || { echo "$r NOT_IN_MANIFEST $(date -u +%FT%TZ)" >> "$ENA_FAILED"; echo "[ena] $r: not in manifest"; return 1; }
  [ -s "$FQ_DIR/$c/${r}_1.fastq.gz" ] && [ -s "$FQ_DIR/$c/${r}_2.fastq.gz" ] && { echo "[ena] $r: already in $FQ_DIR/$c"; return 0; }
  rec=$(ena_pair "$r"); [ -n "$rec" ] || { echo "$r NO_ENA_PAIR $(date -u +%FT%TZ)" >> "$ENA_FAILED"; echo "[ena] $r: ENA has no _1/_2 pair"; return 1; }
  read -r p1 m1 b1 p2 m2 b2 <<<"$rec"
  d="$TMP_DIR/ena/$r"; mkdir -p "$d" "$FQ_DIR/$c"; t0=$(date +%s); f1="$d/${r}_1.fastq.gz"; f2="$d/${r}_2.fastq.gz"
  for pair in "$p1|$m1|$b1|$f1" "$p2|$m2|$b2|$f2"; do
    IFS='|' read -r path md5 bytes out <<<"$pair"
    curl -sS -L -C - --retry 5 --retry-delay 20 -o "$out" "$ENA_BASE$(rel "$path")" >> "$LOG_DIR/ena.$r.log" 2>&1 \
      || { echo "$r DOWNLOAD_FAIL $(date -u +%FT%TZ)" >> "$ENA_FAILED"; echo "[ena] $r: download failed (see logs/ena.$r.log)"; return 1; }
    [ "$(stat -c %s "$out")" = "$bytes" ] || { echo "$r SIZE_MISMATCH $(date -u +%FT%TZ)" >> "$ENA_FAILED"; echo "[ena] $r: size $(stat -c %s "$out") != $bytes"; return 1; }
    h=$(md5sum "$out" | cut -d' ' -f1); [ "$h" = "$md5" ] || { rm -f "$out"; echo "$r MD5_MISMATCH $(date -u +%FT%TZ)" >> "$ENA_FAILED"; echo "[ena] $r: md5 mismatch (file removed; rerun)"; return 1; }
  done
  mv "$f2" "$FQ_DIR/$c/${r}_2.fastq.gz" && mv "$f1" "$FQ_DIR/$c/${r}_1.fastq.gz" || { echo "$r MV_FAIL $(date -u +%FT%TZ)" >> "$ENA_FAILED"; return 1; }
  rmdir "$d" 2>/dev/null
  printf '%s\t%s\t%d\t%d\t%s\n' "$r" "$(date -u +%FT%TZ)" "$(( $(date +%s) - t0 ))" "$(( b1 + b2 ))" "$c" >> "$DONE_TSV"
  for f in "$PF_FAILED" "$DUMP_FAILED" "$ENA_FAILED"; do [ -f "$f" ] && sed -i "/^$r /d" "$f"; done
  echo "[ena] $r: ok $(( (b1 + b2) / 1048576 )) MB in $(( $(date +%s) - t0 )) s → $FQ_DIR/$c"
}

runs_arg() { if [ $# -gt 0 ]; then printf '%s\n' "$@"; else cut -d' ' -f1 "$PF_FAILED" 2>/dev/null | sort -u; fi; }

case "${1:-}" in
list)
  shift; mkmap
  printf '%-12s %-13s %10s %10s  %s\n' run cohort MB_1 MB_2 ena_path_1
  while read -r r; do [ -n "$r" ] || continue; rec=$(ena_pair "$r")
    if [ -n "$rec" ]; then read -r p1 m1 b1 p2 m2 b2 <<<"$rec"; printf '%-12s %-13s %10d %10d  %s\n' "$r" "$(cohort_of "$r")" $((b1/1048576)) $((b2/1048576)) "$p1"
    else printf '%-12s %-13s %10s %10s  %s\n' "$r" "$(cohort_of "$r")" - - "NO PAIR AT ENA"; fi
  done < <(runs_arg "$@") ;;
run)
  shift; mkmap; export -f fetch_one ena_pair rel cohort_of; export MAP FQ_DIR TMP_DIR LOG_DIR ENA_BASE ENA_API PF_FAILED DUMP_FAILED DONE_TSV ENA_FAILED
  echo "[ena] $(runs_arg "$@" | wc -l) runs, $ENA_PARALLEL at a time"
  runs_arg "$@" | xargs -r -P "$ENA_PARALLEL" -I{} bash -c 'fetch_one {}'
  bash "$SELF" status ;;
status)
  printf 'ena done %d   ena failed %d   still in prefetch.FAILED %d\n' "$( [ -s "$DONE_TSV" ] && wc -l < "$DONE_TSV" || echo 0 )" "$( [ -s "$ENA_FAILED" ] && cut -d' ' -f1 "$ENA_FAILED" | sort -u | wc -l || echo 0 )" "$( [ -s "$PF_FAILED" ] && cut -d' ' -f1 "$PF_FAILED" | sort -u | wc -l || echo 0 )"
  [ -s "$ENA_FAILED" ] && sort -u "$ENA_FAILED" | sed 's/^/  /'; true ;;
*) sed -n '11,15p' "$SELF" ;;
esac
