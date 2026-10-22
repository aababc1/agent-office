# K-BDS에서 진행도 보내기 (office-probe)

K-BDS 로그인 노드에는 아무것도 설치하지 않는다. 파일 두 개를 올리고 python3(miniconda base)로 돌린다.
프로브는 **로그와 파일 존재만 읽는다** — Nextflow `trace.txt`·`.nextflow.log`·`work/`, 런북식 산출물 마커, `squeue`, `sinfo`. stat()과 로그 읽기뿐이라 로그인 노드 제한에 걸리지 않는다.

## 1. 올리기 (Mac에서)

```bash
scp dist/office_probe.py examples/metaCRC/plan.yaml examples/metaCRC/02_prefetch_kbds.sh k260a01@kbds.kisti.re.kr:~/office/
```
(`dist/office_probe.py`는 `python3 extractor/build_probe_bundle.py`로 만든 단일 파일. 의존성 없음.)

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
`tmux attach -t office`로 로그 확인. 로그인 노드가 재부팅되면 다시 띄운다. 전송에 실패하면 `~/.agent-office/spool/`에 남겨두고 다음 번에 다시 시도한다.

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

## 5. SINGLE 런 2,061개 — 제외 (2026-10-22 결정)

`runs_paired.txt`(8,420, PAIRED만)가 모든 런 단위 단계의 목록이다. `runs_single_excluded.txt`에 빠진 2,061개를 남겨 둔다. 런북의 03_dump 이후 sbatch 스크립트도 `RUNLIST`를 `runs_paired.txt`로 바꿔야 한다(00_env.sh 한 줄).
