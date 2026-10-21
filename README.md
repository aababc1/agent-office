# agent-office

Claude Code 세션 기록(JSONL)을 읽어 **에이전트 사무실**로 보여주는 도구.
Claude와 서브에이전트가 방을 오가며 일하는 모습(캐릭터·말풍선)과, 그 세션이 **얼마나 진행됐는지**(할 일 완료율, 커밋, 손댄 파일)를 한 화면에 보여준다.

- 토큰 0: 모델을 호출하지 않고 파일만 읽는다.
- 클라우드 세션 전제: 세션이 Anthropic 컨테이너에서 돌기 때문에 추출기는 **세션 안에서** 돌며 결과를 **GitHub data repo**로 밀어낸다. 팀원은 뷰어만 본다.
- 공유 데이터에는 도구 결과·파일 내용·전체 메시지가 **들어가지 않는다.** 짧고 마스킹된 캡션만 나간다.

```
[세션 컨테이너]  ~/.claude/projects/<cwd>/<session>.jsonl  ─┐
                 <session>/subagents/agent-*.jsonl (+meta)  ─┤ office-extract follow (0.5s tail)
                                                             ▼
                 DATA_DIR/<project>/<session>.events.jsonl    ← schema/events.v1
                 DATA_DIR/<project>/<session>.progress.json   ← 진행도 스냅샷
                 DATA_DIR/<project>/project.json, index.json  ← 층별 안내
                                                             │ office-push.sh (1분마다 commit+push)
                                                             ▼
[GitHub]         agent-office-data (private)
                                                             │ git pull (1분)
                                                             ▼
[kbds VM]        viewer/index.html + data/  → 팀원이 cloud.kbds.re.kr 계정으로 접속
```

## 구성

| 경로 | 역할 |
|---|---|
| `extractor/office_extract/` | 추출기 (Python 3.10+, 표준 라이브러리만) |
| `schema/events.v1.schema.json` | 이벤트 스키마. 뷰어는 이것만 안다 |
| `hooks/` | 세션 시작 시 추출기를 띄우는 훅과 git 푸셔 |
| `viewer/index.html` | 단일 파일 아이소메트릭 뷰어 (캔버스로 그림, 이미지 에셋 없음, 정적 호스팅용) |
| `viewer/build_preview.py` | 데이터를 내장한 미리보기 HTML 생성 |
| `fixtures/session-sample/` | 실제 세션을 값만 잘라낸 테스트 픽스처 |
| `tests/` | pytest |

## 빠른 시작

```bash
# 1) 끝난 세션 한 번 변환
PYTHONPATH=extractor python3 -m office_extract.cli once ~/.claude/projects/<enc>/<session>.jsonl --out ./data --project myproj

# 2) 진행 중인 세션 따라가기 (Ctrl-C로 중단)
PYTHONPATH=extractor python3 -m office_extract.cli follow ~/.claude/projects/<enc>/<session>.jsonl --out ./data --print

# 3) 뷰어 미리보기 (데이터 내장, 서버 불필요)
python3 viewer/build_preview.py ./data preview.html && open preview.html

# 4) 테스트
python3 -m pytest tests -q
```

## 세션 안에서 자동으로 켜기

세션이 시작될 때 `hooks/office-start.sh`가 한 번 실행되면 된다. 두 가지 방법:

**A. Claude Code 훅 (repo 기반 세션)** — 프로젝트 repo에 이 저장소를 `.agent-office/`로 넣고(서브모듈이나 복사), `hooks/settings.json`의 `SessionStart` 항목을 `<project>/.claude/settings.json`에 합친다. 그 repo를 여는 모든 세션에서 자동으로 켜진다.

**B. 프로젝트 지침 (Desktop 연결 폴더 등 훅을 못 거는 세션)** — Claude 프로젝트 Instructions에 "세션 시작 시 `bash ~/.agent-office/hooks/office-start.sh`를 실행하라"를 적는다. Claude가 첫 턴에 한 번 실행하고, 이후는 파일만 읽히므로 토큰을 쓰지 않는다.

둘 다 환경변수로 조정한다:

```
OFFICE_DATA_REPO=https://github.com/<you>/agent-office-data.git   # 있으면 clone + 1분마다 push
OFFICE_PROJECT=<층 이름>        # 기본: 세션 cwd의 basename
OFFICE_USER=<이름>              # 기본: $USER
OFFICE_PUSH_EVERY=60            # 0이면 push 안 함
```

`office-start.sh`는 훅 JSON(stdin)의 `transcript_path`를 쓰고, 훅이 아니면 `~/.claude/projects/*/*.jsonl` 중 가장 최근 파일을 집는다. 즉시 반환하고 추출기·푸셔는 detach된 채 세션이 끝날 때까지 돈다.

## 뷰어 배포 (kbds)

정적 파일 + 데이터 폴더면 끝이다.

```bash
git clone <agent-office> /srv/office && git clone <agent-office-data> /srv/office/viewer/data
# nginx: root /srv/office/viewer;
# crontab: * * * * * cd /srv/office/viewer/data && git pull -q --ff-only
```

뷰어는 `data/index.json` → `data/<project>/project.json` → `<session>.events.jsonl` 순으로 읽고, 라이브 모드에서는 10초마다(`window.OFFICE_POLL_MS`) 다시 읽는다. 다시보기는 가상 시계로 재생하며 긴 공백은 실시간 2초로 압축한다.

## 데이터 모델

**이벤트** (`events.v1`, 한 줄 = 사건 하나)

| kind | 뜻 | 화면 |
|---|---|---|
| `prompt` / `interrupt` | 사용자가 친 말 / Esc | 내 캐릭터 말풍선 / "잠깐, 멈춰!" |
| `say` | Claude 답변 (120자) | 말풍선 |
| `think` | 생각 (`dur_ms`) | 구름 말풍선 "N초 고민함" |
| `tool` → `tool_done` / `tool_err` | 도구 호출 → 결과 | 방으로 이동 + "app.js 읽는 중 · 3s" / 빨간 말풍선 |
| `spawn` → `finish` | 서브에이전트 출근 → 퇴근 | 엘리베이터 |
| `task` | 할 일 변경 | 회의실 |

방 배정: `rooms.py`. Read/Grep → 자료실, Edit/Write → 개발실, Bash → 명령을 까서 (rg·cat 자료실, sed -i·리다이렉트 개발실, curl 정보검색실, 나머지 서버실), 웹·MCP → 정보검색실, 할 일·계획·스킬 → 회의실, 사용자에게 묻기 → 내 자리, Agent → 엘리베이터.

**진행도** (`<session>.progress.json`): `tasks[]`(TodoWrite 전체 배열이 진실, TaskCreate는 결과의 `#N`으로 실제 ID 확정), `git.commits[]`·`git.filesChanged[]`, `agents[]`, `counters`, `rooms`, `status`(마지막 기록 2분 이내면 `active`).

## 민감정보 원칙 (`sanitize.py`)

allow-list 방식이다. 밖으로 나가는 문자열은 캡션뿐이고, 캡션은 `<system-reminder>`·태그 제거 → 공백 정리 → 토큰/키/비밀번호/이메일 마스킹 → 120자 절단을 거친다. 경로는 마지막 두 단계만 남긴다. `tool_result` 본문은 TaskCreate의 `#N` 외에는 읽지도 않는다. `--no-user-text`를 주면 내 프롬프트도 `…`로 가린다.

## 알아둘 것

- JSONL은 Claude Code 내부 포맷이라 버전마다 바뀔 수 있다. 추출기는 모르는 레코드 type을 무시하고, 한 파일 안에서 버전이 바뀌어도(실제로 `2.1.285 → 2.1.306`이 한 세션 안에서 관찰됨) 버전 목록을 스냅샷에 남긴다. 포맷이 바뀌면 `fixtures/`에 새 샘플을 추가하고 `parse.py`만 고치면 된다.
- 생각(`think`) 기록은 생각이 끝난 뒤에 쓰인다. 그래서 라이브 화면의 "고민 중"은 마지막 기록(프롬프트/도구 결과) 이후 새 줄이 없는 시간으로 추정한 것이고, 기록이 오면 실제 길이로 바뀐다.
- 컨테이너에서 띄운 백그라운드 프로세스는 세션이 끝나면 함께 끝난다. 푸셔가 마지막 push를 한 번 더 하므로 데이터는 남는다.

## 다음 단계

1. **data repo 연결**: `agent-office-data` private repo 생성 → `OFFICE_DATA_REPO` 지정 → 첫 세션에서 push 확인
2. **kbds 배포**: VM에 뷰어 + cron pull. 포트/프록시 가능 여부 확인
3. **Drive 어댑터**: 팀원이 올린 자료·댓글을 "자료함" 이벤트로 바꿔 사무실에 띄우기 (Slack 없이 Drive 파일 댓글 + 의견 Doc)
4. 진행도 고도화: Jira/이슈 키 연결, 프로젝트 타임라인

## 폰에서 보기 (PWA)

`viewer/`에는 `manifest.webmanifest`, `sw.js`, `icons/`가 같이 있다. https로 호스팅되면 iPhone·Android에서 "홈 화면에 추가"로 앱처럼 열리고, 마지막 상태가 캐시돼 오프라인에서도 직전 사무실이 먼저 뜬다. 760px 이하에서는 사무실이 화면 폭 전체를 쓰고(핀치 줌·드래그), 진행도/사람/로그/층은 아래 탭으로 바뀐다. ◎ 버튼은 Claude 위치로 화면을 옮긴다.

## 프로젝트별 접근 권한

접근 권한 단위가 프로젝트라서 **data repo는 프로젝트당 하나**다(`OFFICE_DATA_REPO`가 프로젝트마다 다름). 참여자 = 그 repo의 collaborator. 뷰어 로그인은 Cloudflare Pages + Access(이메일 코드/Google 로그인, 참여자 이메일 목록) 또는 GitHub 로그인 중 선택. 권한 없는 층은 이름만 보이고 잠긴다.
