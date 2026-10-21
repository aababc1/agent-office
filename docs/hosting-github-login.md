# 호스팅 + GitHub 로그인 설정

뷰어는 Cloudflare Pages가 `agent-office` repo의 `viewer/`를 그대로 서빙하고, 같은 repo의 `functions/auth/`가 GitHub 로그인의 코드 교환을 맡는다(비밀키는 Pages 환경변수에만 존재). 로그인한 사람은 **자기 토큰으로 GitHub API를 직접 읽어** collaborator인 data repo만 층으로 본다. 서버 상태 없음, 토큰은 Contents 읽기 전용.

```
참여자 브라우저 ──(GitHub 로그인)──▶ github.com ──code──▶ pages.dev/auth/callback ──token(#fragment)──▶ 뷰어
뷰어 ──Bearer token──▶ api.github.com/repos/<owner>/office-<project>/contents/…   (ETag로 304면 무료)
```

## 1. GitHub App 만들기 (한 번)

GitHub → Settings → Developer settings → **GitHub Apps** → New GitHub App

| 항목 | 값 |
|---|---|
| App name | Agent Office (고유해야 함, 예: `agent-office-aababc1`) |
| Homepage URL | `https://<프로젝트>.pages.dev` (3단계 후 확정, 임시값 가능) |
| Callback URL | `https://<프로젝트>.pages.dev/auth/callback` |
| Expire user authorization tokens | ✅ (8시간 만료, 뷰어가 refresh 처리) |
| Request user authorization (OAuth) during installation | ✅ |
| Webhook → Active | ☐ 끔 |
| Repository permissions | **Contents: Read-only** (Metadata는 자동 Read-only) |
| Where can this app be installed? | Only on this account |

만든 뒤 **Client ID**를 적어두고, **Generate a new client secret**으로 secret을 한 번만 복사한다.

## 2. App 설치 (data repo마다)

App 페이지 → Install App → `aababc1` → **Only select repositories** → data repo들(`office-metacrc`, …)을 선택. 새 프로젝트 repo가 생기면 여기에 추가한다. 설치된 repo 밖은 토큰으로도 읽을 수 없다.

## 3. Cloudflare Pages

Workers & Pages → Create → Pages → **Connect to Git** → `aababc1/agent-office`

| 항목 | 값 |
|---|---|
| Framework preset | None |
| Build command | (비움) |
| Build output directory | `viewer` |
| Environment variables (Production) | `GH_CLIENT_ID`, `GH_CLIENT_SECRET`(Encrypt) |

`functions/` 폴더는 repo 루트에 있어서 Pages가 자동으로 `/auth/login`, `/auth/callback`, `/auth/refresh`로 올린다. 배포되면 `https://<이름>.pages.dev`가 나오고, 1단계의 Callback URL을 이 주소로 맞춘다. 이후 `main`에 push할 때마다 자동 재배포.

## 4. 참여자 추가

프로젝트 data repo → Settings → Collaborators → 참여자 GitHub 계정을 **Read**로 추가. 참여자는 뷰어를 열고 "GitHub로 로그인" → App 승인 → 자기 층만 보인다. 떠난 사람은 collaborator에서 빼면 다음 폴링부터 그 층이 사라진다.

## 5. data repo 규칙

- 프로젝트당 private repo 하나: `office-<project>` (추출기의 `OFFICE_DATA_REPO`)
- 한 repo = 층 하나. repo 안의 `index.json`을 뷰어가 읽어 층 이름을 정한다
- `viewer/floors.json`에 `[{"name":"metaCRC","repo":"aababc1/office-metacrc"}]`를 적어두면 권한 없는 사람에게도 그 층이 🔒 잠긴 채로 보인다(이름만 노출). 비워두면 자기 층만 보인다

## 로컬·오프라인 확인

`viewer/config.js`의 `OFFICE_MODE`를 `'static'`으로 바꾸면 `viewer/data/`를 그대로 읽는다. `python3 -m http.server`로 띄워 보면 된다. Claude artifact 미리보기는 데이터를 내장하므로 로그인이 없다.
