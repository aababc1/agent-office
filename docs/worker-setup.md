# Worker 배포 + GitHub 로그인 설정 (한 번만)

Cloudflare Worker 하나가 뷰어(정적), GitHub 로그인, 읽기 API, WebSocket 실시간, 데이터 수신(GitHub 웹훅 + 직접 전송)을 전부 맡는다. 저장은 D1(SQLite) 하나, 실시간 중계는 Durable Object 하나. 전부 무료 범위.

```
[Claude 세션 컨테이너] ──git push──▶ GitHub data repo ──웹훅──▶ Worker /ingest/github ──▶ D1
[계산 서버 · Mac]           ──POST /ingest/events (프로젝트 토큰)──────────────────────────▶ D1
                                                                                     │ Durable Object
[팀원 폰·PC] ◀── 정적 뷰어 + GitHub 로그인 쿠키 + /api/* + /ws/<project> ◀──────────┘
```

권한: 뷰어 로그인은 GitHub. "그 사람이 data repo를 읽을 수 있나"를 Worker가 GitHub에 물어보고(10분 캐시) 층을 보여준다. 참여자 = data repo collaborator. 토큰은 브라우저에 내려가지 않고 HttpOnly 쿠키 안에만 있다.

## 0. 준비물

GitHub에 `agent-office`(이 repo, public)와 프로젝트별 data repo(`agent-office-data`, `office-<project>`… private). Cloudflare 계정(무료).

## 1. GitHub App (로그인 + 웹훅 + repo 읽기)

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App

| 항목 | 값 |
|---|---|
| App name | `agent-office-aababc1` (고유) |
| Homepage URL | `https://agent-office.<계정>.workers.dev` (3단계 후 확정; 임시값 가능) |
| Callback URL | `https://agent-office.<계정>.workers.dev/auth/callback` |
| Expire user authorization tokens | ✅ |
| Request user authorization (OAuth) during installation | ✅ |
| **Webhook** → Active | ✅ URL `https://agent-office.<계정>.workers.dev/ingest/github`, Secret = 임의 문자열(=`GH_WEBHOOK_SECRET`) |
| Repository permissions | **Contents: Read-only**, Metadata: Read-only(자동) |
| Subscribe to events | **Push** |
| Where can this app be installed? | Only on this account |

만든 뒤 적어둘 것: **App ID**, **Client ID**, **Client secret**(Generate), **Private key**(Generate → `.pem` 다운로드). pem은 PKCS#1 형식(`BEGIN RSA PRIVATE KEY`)이어도 Worker가 그대로 받는다.

Install App → 계정 선택 → **Only select repositories** → data repo들. App 웹훅은 설치된 모든 repo의 push를 한 번에 보내므로 repo마다 웹훅을 따로 걸 필요가 없다. 새 data repo가 생기면 설치 목록에 추가만 하면 된다.

## 2. D1 데이터베이스

Cloudflare 대시보드 → Storage & Databases → D1 → Create → 이름 `agent-office`. 생성된 **Database ID**를 `worker/wrangler.toml`의 `database_id`에 넣고 커밋. 스키마는 `worker/migrations/0001_init.sql`:

- 로컬에 wrangler가 있으면 `cd worker && npx wrangler d1 migrations apply agent-office --remote`
- 없으면 D1 콘솔(대시보드의 Console 탭)에 `0001_init.sql` 내용을 붙여 넣고 실행

## 3. Worker 배포 (GitHub 연동, 토큰 없이)

Workers & Pages → Create → **Import a repository** → `aababc1/agent-office`

| 항목 | 값 |
|---|---|
| Project name | `agent-office` |
| Root directory | `worker` |
| Build command | (비움) |
| Deploy command | `npx wrangler deploy` |

배포되면 `https://agent-office.<계정>.workers.dev`. Settings → Variables and Secrets에 아래를 넣고 한 번 더 배포(Retry deployment).

| Secret | 값 |
|---|---|
| `GH_CLIENT_ID` / `GH_CLIENT_SECRET` | 1단계 |
| `GH_APP_ID` / `GH_APP_PRIVATE_KEY` | 1단계 (pem 파일 내용 전체, 줄바꿈 포함) |
| `GH_WEBHOOK_SECRET` | 1단계의 웹훅 secret |
| `SESSION_SECRET` | 임의의 긴 문자열 (예: `openssl rand -hex 32`) |
| `PROJECT_TOKENS` | `{"metaCRC":"<임의 토큰>"}` — 직접 전송(계산 서버·Mac)용. 세션 컨테이너에는 주지 않는다 |

`wrangler.toml`의 `[vars]` `GH_OWNER`, `ADMIN_LOGIN`은 이미 `aababc1`. 이후 `main`에 push할 때마다 자동 재배포.

## 4. 확인

1. `https://…workers.dev/api/health` → `{"ok":true}`
2. 뷰어 열기 → "GitHub로 로그인" → App 승인 → 본인이 collaborator인 층이 보임
3. data repo에 push가 일어나면 수 초 안에 사무실이 움직임 (GitHub App → Recent Deliveries에서 웹훅 응답 `200` 확인 가능)
4. 다른 계정으로 로그인하면 collaborator가 아닌 층은 🔒

## 5. 직접 전송 (계산 서버, Mac)

```bash
curl -X POST https://agent-office.<계정>.workers.dev/ingest/events \
  -H "Authorization: Bearer <PROJECT_TOKENS의 값>" -H "content-type: application/json" \
  -d '{"project":"metaCRC","session":"<id>","events":[...],"progress":{...},"summary":{...},"pipeline":{...}}'
```

필드는 전부 선택이다. 받은 즉시 D1에 쓰고 그 층을 보고 있는 모든 뷰어에 WebSocket으로 알린다. 계산 서버의 리더/office-emit은 이 경로로 초 단위 갱신을 보낸다.

## 로컬에서 돌려보기

```bash
cd worker && cp .dev.vars.example .dev.vars        # DEV_ALLOW_ALL=1 이면 GitHub 없이 모든 층이 열림(로컬 전용)
npx wrangler d1 migrations apply agent-office --local
npx wrangler dev --local                          # http://localhost:8787
```
