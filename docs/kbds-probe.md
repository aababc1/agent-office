# K-BDS에서 진행도 보내기 (office-probe)

K-BDS 로그인 노드에는 아무것도 설치하지 않는다. 파일 두 개를 올리고 python3(miniconda base)로 돌린다.
프로브는 **로그와 파일 존재만 읽는다** — Nextflow `trace.txt`·`.nextflow.log`·`work/`, 런북식 산출물 마커, `squeue`, `sinfo`. stat()과 로그 읽기뿐이라 로그인 노드 제한에 걸리지 않는다.

## 1. 올리기

Mac에서 scp로:
```bash
scp -O dist/office_probe.py examples/metaCRC/plan.yaml examples/metaCRC/02_prefetch_kbds.sh k260a01@kbds.kisti.re.kr:~/office/
```
K-BDS에서 바깥 HTTPS가 되면 GitHub에서 바로(이 repo는 public):
```bash
mkdir -p ~/office && cd ~/office
curl -sSLO https://raw.githubusercontent.com/aababc1/agent-office/main/dist/office_probe.py
```
(`dist/office_probe.py`는 `python3 extractor/build_probe_bundle.py`로 만든 단일 파일. 의존성 없음. 갱신도 같은 curl 한 줄.)

프로브는 매 전송에 plan의 `repo`를 같이 보내고, 첫 전송과 `plan.yaml`이 바뀔 때마다 plan 전체를 보낸다. 그래서 **data repo(`repo:`에 적은 것)가 GitHub에 있고 App이 설치돼 있어야** 그 층이 보인다 — Worker는 "이 사람이 그 repo를 읽을 수 있나"로 층을 열고, repo가 없으면 🔒로 남는다. plan.json을 따로 push할 필요는 없다.

## 2. plan.yaml 맞추기 (K-BDS에서 한 번)

```bash
cd ~/office && vi plan.yaml        # paths.PROJ 를 실제 경로로, pipeline.trace/log/work 를 metaFun 실행 위치로
python3 office_probe.py show --plan plan.yaml --site kbds | head -60     # 아무것도 안 보내고 읽은 결과만 출력
```
`show`에 `note: unit list missing`이 보이면 `units.file` 경로가 틀린 것. Nextflow를 돌릴 때 `-with-trace $PROJ/run/trace.txt`를 붙여야 단계별 task 기록이 남는다(한 줄 = task 하나, 끝난 것만).

## 3. 보내기

바깥 HTTPS가 되는지 먼저:
```bash
curl -sS -m 10 https://agent-office.hyeongwon-tg.workers.dev/api/health
```

**되면** (Worker로 직접, 수 초 지연):
```bash
export OFFICE_TOKEN='<Cloudflare PROJECT_TOKENS 의 metaCRC 값>'
export OFFICE_TO=https://agent-office.hyeongwon-tg.workers.dev
python3 office_probe.py once --plan plan.yaml --site kbds           # 한 번
tmux new -s office -d 'python3 ~/office/office_probe.py loop --plan ~/office/plan.yaml --site kbds --every 120'   # 2분마다, 계속
# 또는 ./02_prefetch_kbds.sh office  (같은 일을 00_env_local.sh 설정으로)
```
`tmux attach -t office`로 로그 확인. 로그인 노드가 재부팅되면 다시 띄운다. 전송에 실패하면 `~/.agent-office/spool/`에 기록을 남기고, 다음 프로브가 최신 상태를 다시 보낸다(상태는 스냅샷이라 재전송이 따로 필요 없다).

**안 되면** (파일로):
```bash
python3 office_probe.py once --plan plan.yaml --site kbds --to ~/office/out     # pipeline/kbds/progress.json + summary.json
```
`~/office/out`을 Mac에서 `scp`로 가져와 data repo clone에 넣고 push하면 웹훅 경로로 들어간다(분 단위 지연). 이 경우는 Mac에서 cron 한 줄로 자동화할 수 있다.

## 4. 무엇이 올라가나

- 단계별 `done/total`, 실패 목록(런북 `*.FAILED`의 사유, Nextflow `FAILED exit=N`), 실행 중 task(`work/`의 `.command.begin`만 있고 `.exitcode` 없는 것), 마지막 완료 시각
- 완료 속도(최근 3h/12h/48h) → 남은 양 ÷ 속도 = **ETA**. 실측이 3건 이상 쌓인 창을 쓰므로 처음엔 비어 있다가 돌수록 정확해진다
- `squeue -u k260a01`: 내 잡 RUNNING/PENDING과 PENDING 사유(Priority/Resources/Dependency)
- `sinfo`: plan의 `site.partitions`에 적은 파티션의 idle/alloc 노드 수 → `canSubmit`
- trace에는 있는데 plan에 없는 process는 `unplanned`로 그대로 올라간다(단계 이름을 지어내지 않음). 보고 나서 plan의 `done: {kind: nextflow, process: [...]}`에 넣으면 그 단계로 묶인다

샘플·런 id는 K-BDS 밖으로 나가지 않는다. 개수와 실패 사유만 나간다(실패 사유 줄에는 런 id가 포함됨 — 공개 accession이라 괜찮다고 보지만, 가리려면 `failed:` 블록을 지우면 된다).

## 5. 코호트(BioProject) 단위 진행 — `groups:` (2026-10-23)

plan.yaml의 `groups: {file: $MANIFEST, columns: {run: run_accession, sample: sample_accession, cohort: cohort_accession}}` 한 블록으로
런·샘플 단위 모든 단계에 **코호트별 done/total/failed**가 붙는다(뷰어의 코호트 보드). 파일 이름을 파싱하지 않는다 — manifest가 매핑이다.
출력은 코호트 하위 폴더(`$FQ_DIR/<BioProject>/<run>_1.fastq.gz` 등)이고, 마커 경로의 `{cohort}`가 같은 매핑으로 풀린다.

## 6. §03 dump — `03_dump_kbds.sh` (prefetch 끝난 런부터 바로)

**BioProject 단위로 돈다**(`DUMP_MODE=cohort`, 기본). 로그인 노드 tmux의 `feed`가 10분마다, prefetch가 **끝난 코호트**(그 코호트 런 중
아직 내려받는 중인 게 없음 — 실패한 런은 끝난 것으로 침)부터 작은 순서로, 코호트 하나를 그 코호트만 담은 노드 잡(`metacrc-dump:<BioProject>`,
sbatch 1개 = 노드 1개, `xargs -P (cores/4)` × 4 thread)으로 띄운다. 큰 코호트는 160런씩 여러 잡. 특정 코호트를 prefetch가 덜 끝났어도 지금
돌리려면 `./03_dump_kbds.sh submit --cohort PRJEB6070`. 코호트 안 가리고 validated 런을 바로바로 흘리는 옛 방식은 `DUMP_MODE=stream`. 런 하나 = `fasterq-dump`(기본 split-3) → `pigz -p 4` → `gzip -t`
→ `_2` 먼저, `_1` 마지막에 mv(= 완료 마커) → `$SRA_DIR/<run>` 삭제. 실패는 `dump.FAILED`에 `NOT_VALIDATED|NO_SRA|DUMP_FAIL`.
임시 파일은 `$PROJ/tmp/<run>`(home 밑), 끝나면 삭제.

```bash
conda install -n sra-tools -c conda-forge pigz -y        # 한 번
./03_dump_kbds.sh pending                                # 코호트별: total/prefetched/dumped/waiting, READY 표시
DUMP_CHUNK=16 ./03_dump_kbds.sh submit 1                 # 첫 잡은 작게: 노드 1개 · 16런으로 동작 확인
./03_dump_kbds.sh status                                 # dumped/validated-waiting/failed, 잡, 시간당 처리량, 코호트별 ✓
tmux new -s dump -d 'cd ~/office && ./03_dump_kbds.sh feed 2>&1 | tee -a ~/metaCRC/logs/dump.feed.log'   # 상시
./03_dump_kbds.sh retry                                  # FAILED 비우고 다시 대기열로
```
손잡이(00_env_local.sh에 export): `DUMP_PART`(기본 cpu32-only, 0.5 노드시간/h) · `DUMP_MAX_NODES`(5) · `DUMP_CHUNK`(160런/잡) · `DUMP_MIN_BATCH`(16) · `DUMP_FEED_S`(600) · `DUMP_TIME`(24:00:00).
죽은 잡의 청크는 다음 `feed`에서 자동으로 대기열로 돌아온다(끝난 런은 파일이 있으니 건너뜀).

## 6b. §04 QC — `04_qc_kbds.sh` (metaFun `RAWREAD_QC_cleanifier.nf`, 2026-10-27)

**코호트 단위**: dump가 정리된 코호트(모든 런이 dumped · dump-FAILED · prefetch-FAILED 중 하나이고 dumped가 1개 이상)부터 작은 순서로
노드 잡 하나(`metacrc-qc:<BioProject>`, sbatch 1개 = 노드 1개, `--exclusive`)를 띄우고, 그 안에서 metaFun의 Nextflow를 **그 코호트만** 돌린다:
`make_samplesheet.py --cohort $c [--exclude manifest/fastq_check/$c.bad_runs.txt]` → `$PROJ/runs/$c/samplesheet.csv` →
`nextflow run $METAFUN_DIR/nf_scripts/RAWREAD_QC_cleanifier.nf -c $METAFUN_DIR/config/kbds.config -profile kbds --samplesheet … --outdir $QC_DIR --run_dir $PROJ/runs/$c --work_dir $PROJ/work/$c --cleanifier_index $QC_INDEX -resume`,
끝나면 `cleanifier remove --name $QC_SHM_NAME`(EXIT trap에도). 완료 마커는 metaFun이 쓰는 `$QC_DIR/<BioProject>/<run>.done`.
metaFun 쪽 접점(브랜치 `kbds-rawreadqc`, env `metacrc-qc`, 프로세스 `load_index`·`fastp_cleanifier`·`qc_summary`)은 프로젝트 문서 `claude/kbds.md` "metaFun 측 확정" 절이 기준이고, 이 스크립트는 그 접점만 쓴다(metaFun 자체는 건드리지 않는다).

plan.yaml의 qc 단계는 **하이브리드**다: 파일 마커(`qc/{cohort}/{run}.done`)가 done을 세고, `nextflow: {process: [fastp_cleanifier], aux: [load_index, qc_summary]}`가
running/failed/작업시간을 trace에서 가져온다. 코호트별 trace·work·log는 `pipeline:` 블록의 glob(`$PROJ/runs/*/*/trace.txt` 등)으로 모두 합쳐 읽는다.
`est: {s_per_unit: 76}`(PRJNA531273 30런 실측, cpu32-only)는 측정 ETA가 잡히기 전 뷰어의 "추정" 시간이다(남은 런 × 76 s ÷ (노드당 8 × 노드 수)).

```bash
./04_qc_kbds.sh pending                                  # 코호트별: total/dumped/settled/qc_done/live, READY 표시
./04_qc_kbds.sh submit 1                                 # READY 코호트 하나를 노드 1개로 (처음엔 작은 코호트로 확인)
./04_qc_kbds.sh status                                   # .done 수, 잡, 코호트별 ✓
tmux new -s qc -d 'cd ~/office && ./04_qc_kbds.sh feed 2>&1 | tee -a ~/metaCRC/logs/qc.feed.log'   # 상시
```
손잡이(00_env_local.sh에 export): `METAFUN_DIR`(`$HOME/metaFun`) · `QC_ENV`(`metacrc-qc`) · `QC_INDEX`(Cleanifier 인덱스 prefix) · `QC_SHM_NAME`(인덱스 basename) · `QC_PART`(`cpu32-only cpu64-only`) · `QC_MAX_NODES`(5) · `QC_TIME`(96:00:00) · `QC_FEED_S`(600) · `QC_NF_ARGS`.

## 6c. §05 merge — `05_merge_kbds.sh` (다중런 샘플 322개 → 샘플당 R1/R2, 2026-10-30)

단위는 `$MULTI`(`samples_multirun.txt`)의 샘플. 샘플의 런 = manifest에서 그 `sample_accession`이고 `runs_paired.txt`에 있는 런(정렬 순).
입력은 QC 결과 `qc/<BioProject>/<run>_1|_2.fastq.gz` — **`<run>.done`이 있고 파일 끝에 BGZF EOF 블록(28바이트)이 있는 것만**.
출력은 `merged/<BioProject>/<sample>_R2.fastq.gz` 먼저, `_R1` 마지막(= 완료 마커). gzip 멤버를 `cat`으로 이어 붙인다(재압축 없음, 유효한 gzip/BGZF;
MEGAHIT·htslib 모두 읽음). 크기 합이 맞는지 확인하고 `merge_done.tsv`(sample when seconds bytes cohort runs)에 적는다.
실패 `logs/merge.FAILED`: `MISSING_<run>`(런이 prefetch/dump 실패이거나 QC trace에 FAILED) · `TRUNCATED_<run>` · `CAT_FAIL` · `SIZE_MISMATCH`.
샘플의 런 중 아직 QC 중인 게 있으면 기다린다(실패 아님). 코호트당 노드 잡 하나(`metacrc-merge:<BioProject>`, `--exclusive`), cat은 I/O-bound라
`cores/4 × 1.5`개를 동시에 돌린다. 다중런 샘플은 PRJEB6070(196) · PRJEB12449(110) · PRJEB27928(16)에만 있다.

```bash
./05_merge_kbds.sh pending                               # 코호트별: samples/ready/merged/failed/live
./05_merge_kbds.sh submit 1                              # READY 샘플이 있는 코호트 하나를 노드 1개로
./05_merge_kbds.sh status                                # merged/322, 잡, 코호트별 ✓, 실패 목록
tmux new -s merge -d 'cd ~/office && ./05_merge_kbds.sh feed 2>&1 | tee -a ~/metaCRC/logs/merge.feed.log'   # 상시
./05_merge_kbds.sh retry                                 # merge.FAILED 비우고 다시 대기열로
```
손잡이(00_env_local.sh): `MERGE_PART`(`cpu32-only cpu64-only`) · `MERGE_MAX_NODES`(2) · `MERGE_TIME`(12:00:00) · `MERGE_FEED_S`(600) · `MERGE_OVERSUB`(1.5).

plan.yaml의 qc 단계 runner는 `{job: qc, job_sep: "_"}` — metaFun 드라이버(`kbds_submit_all.sh`)의 잡 이름 `qc_<BioProject>[.<k>]`에 맞춘 것. 청크 `.<k>`는 코호트로 합쳐 센다.

## 6d. §06 assemble — `06_assemble_kbds.sh` (샘플 단위, 2026-10-30; `ASM_TOOL=metaspades` 기본 — metaFun 창 결정, `megahit`은 런북 원안으로 남김)

단위는 `$ASMLIST`(`samples_assemble.txt`)의 샘플. 입력은 런 수에 따라: 런 1개 → `qc/<PRJ>/<run>_1|_2.fastq.gz`(`<run>.done` 필요),
런 2개 이상 → `merged/<PRJ>/<sample>_R1|_R2.fastq.gz`(§05). 입력이 아직 없으면 기다린다(QC/merge 중) — 실패 아님. 그래서 **QC 끝난 코호트의
단일런 샘플은 merge와 상관없이 바로** 조립에 들어간다.
출력 `assembly/<PRJ>/<sample>/contigs.renamed.fa`(마지막에 생성 = 마커; 헤더 `>{sample}_c{n} <MEGAHIT 원래 헤더>`) + `megahit.log` + `options.json`;
MEGAHIT 작업 폴더(intermediate_contigs 등)는 지운다. 실패 `logs/asm.FAILED`: `NO_INPUT` · `MEGAHIT_FAIL` · `EMPTY`. `asm_done.tsv`에 샘플당 wall·peak RSS·contig 수·염기 수.
노드 잡 하나 = 코호트 청크(`metacrc-asm:<PRJ>.<k>`; metaspades 32샘플 / megahit 160샘플). 동시 수 = min(cores/8, RAM×0.9 / 샘플당 메모리(metaspades 120 GB, megahit 40 GB)),
메모리가 한도면 남는 코어를 스레드로 채움(cpu64 1 TB: 7개 × 9 thr × 131 GB). 명령은 `spades.py --meta -1 -2 -o -t -m $ASM_SPADES_ARGS`(contigs.fasta) 또는
`megahit -1 -2 -o -t -m $ASM_MEGAHIT_ARGS`(final.contigs.fa) — 도구 기본값 + `-t/-m/-o`만. k·`--only-assembler`·최소 길이는 metaFun 창에서 정해지면 `ASM_SPADES_ARGS`로.
파티션 기본 `cpu64-only cpu64-only-m512GB`(m512는 3개 동시). 실패 코드 `NO_INPUT` · `ASM_FAIL` · `EMPTY`.

```bash
./06_assemble_kbds.sh pending                            # 코호트별 samples/ready/assembled/failed/live
./06_assemble_kbds.sh submit 1 --cohort PRJNA531273      # 첫 측정: 작은 코호트 하나를 노드 1개로 → status의 min/sample·peak RSS로 노드시간 외삽
./06_assemble_kbds.sh status
tmux new -s asm -d 'cd ~/office && ./06_assemble_kbds.sh feed 2>&1 | tee -a ~/metaCRC/logs/asm.feed.log'
./06_assemble_kbds.sh retry
```
손잡이: `ASM_ENV`(metacrc-asm) · `ASM_PART` · `ASM_MAX_NODES`(4) · `ASM_THREADS`(8) · `ASM_CHUNK`(160) · `ASM_TIME`(96:00:00) · `ASM_FEED_S`(900) · `ASM_MEGAHIT_ARGS` · `ASM_MEM_FRAC`(0.9).
예산 주의: metaSPAdes는 샘플당 8 thread로 6–25 h·60–150 GB(문헌·경험치) → 7,595샘플 ÷ 노드당 7 ≈ 6,500–27,000 노드시간(cpu64 1/h), 전체 예산 2,000을 크게 넘는다.
`--only-assembler`(BayesHammer 생략)로 절반쯤, MEGAHIT이면 1/5–1/10. 그래서 전수 `feed` 전에 **PRJNA531273(30샘플) 실측**(`status`의 min/sample·peak RSS)으로 범위·도구를 정한다.

## 7. SINGLE 런 2,061개 — 제외 (2026-10-22 결정)

`runs_paired.txt`(8,420, PAIRED만)가 모든 런 단위 단계의 목록이다. `runs_single_excluded.txt`에 빠진 2,061개를 남겨 둔다. 런북의 03_dump 이후 sbatch 스크립트도 `RUNLIST`를 `runs_paired.txt`로 바꿔야 한다(00_env.sh 한 줄).
