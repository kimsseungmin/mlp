# 웹 브라우징 어노테이션 도구 (한국어)

> 영문 문서는 [README.md](./README.md) 참고

사람이 웹을 브라우징하는 행동을 **molmoweb 스타일의 액션 trajectory**(화면 + 클릭/입력 좌표)로 수집하는 자체 호스팅 도구입니다.

- **`browser_app.py`** — FastHTML 서버. 태스크 페이지를 띄우고, `/upload`로 들어온 세션 데이터를 파싱해 디스크에 저장합니다.
- **`molmoweb_extension/`** — 크롬 확장. 시크릿 창에서 상호작용을 기록하고 서버로 전송합니다.

데모 영상: [`annotation_tool_demo.mp4`](./annotation_tool_demo.mp4)

---

## 1. 사전 준비

- Python **3.12+** (f-string 파싱 때문에 3.12 이상 권장)
- `python-fasthtml`은 **0.13.x** 권장 (0.14+에서 `picolink` 제거됨)
- Google Chrome

## 2. 태스크 설정

`configs/example_tasks.json`을 복사·편집합니다. 각 태스크는 아래 키가 필요합니다.

| 키 | 설명 |
| --- | --- |
| `domain` | 짧은 도메인 라벨 |
| `instruction` | 참가자에게 보여줄 지시문 (사이드패널에 표시) |
| `task_name` | 표시용 이름 |

> `task_steps`는 더 이상 필수가 아닙니다. 지시문만으로 진행합니다.

## 3. 설치 및 실행

### macOS / Linux

```bash
cd annotation
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python browser_app.py --config configs/example_tasks.json
```

### Windows (PowerShell)

> ⚠️ `requirements.txt`는 Unix에서 freeze한 것이라 `uvloop`(Windows 미지원)이 포함돼 있습니다. Windows에서는 `-r requirements.txt` 대신 **직접 의존성만** 설치하세요.

```powershell
# git clone 이후
cd molmoweb-annotation

# Python 3.12+ 가상환경
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
#   실행 정책 오류가 나면 먼저:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# 의존성 (uvloop 회피 — 직접 의존성만, pip가 플랫폼에 맞게 나머지 해결)
python -m pip install --upgrade pip
python -m pip install "python-fasthtml==0.13.3" paramiko

# 실행
python browser_app.py --config configs\example_tasks.json
```

cmd(명령 프롬프트)를 쓰면 활성화만 `.venv\Scripts\activate.bat` 로 다르고 나머지는 동일합니다.

브라우저에서 `http://127.0.0.1:5001/` 접속 → 태스크 선택 → 안내 따라가기.

환경변수: `ANNOTATION_CONFIG`(태스크 JSON), `ANNOTATION_PORT`(기본 5001), `ANNOTATION_DATA_DIR`(저장 경로, 기본 `uploads/`).
## 4. 크롬 확장 로드

1. `chrome://extensions` → **개발자 모드** 켜기 → **압축해제된 확장 프로그램 로드** → `molmoweb_extension` 폴더 선택
2. 확장 **세부정보** → **시크릿 모드에서 허용** 켜기
3. 확장은 `localhost:5001` / `127.0.0.1:5001`에서만 주입됩니다. 다른 포트/호스트면 `manifest.json`의 `content_scripts[0].matches`에 추가 후 **새로고침**.

> ⚠️ 세션 시작 직후 **사이드패널을 바로 열어야** 데이터가 정상 저장됩니다.

---

## 5. 자동으로 기록되는 액션

각 액션이 발생하면 그 순간 화면이 캡처되어 한 스텝으로 남습니다. **평소엔 그냥 두면** 아래가 자동으로 기록돼요.

| 액션 | 설명 | 같이 저장되는 것 |
| --- | --- | --- |
| `click` | 페이지 클릭 (클릭한 순간 화면) | 클릭 좌표 `x,y` + 요소 `bbox`(픽셀) + `viewport_width/height` |
| `type` | 입력칸 타이핑(멈추면 1장) | 입력칸 `bbox` + 입력값 `value` |
| `scroll` | 스크롤 (8px 미만 미세 스크롤은 무시) | 스크롤 양/방향 |
| `goto` | 주소창에 URL 직접 입력 | 도착 `url` |
| (link load) | 링크 클릭으로 도착한 페이지 | `url` |
| (enter result) | 검색 등 Enter 후 결과 페이지 | 클릭한 검색창 `bbox` + `typed_value` |
| `sendFinalAnswer` | 최종 답변 제출 | 마지막 화면 + 답변 텍스트 |

- 클릭은 **pointerdown 순간**에 찍어, 클릭한 화면과 bbox가 맞물립니다.
- content script가 **모든 프레임(`allFrames`)** 에 주입돼, 사이트 안에 임베드된 **iframe**(예: 간편인증 위젯) 안의 클릭/입력도 잡습니다.
- 좌표는 **픽셀 + viewport** 로 저장돼, 다운스트림에서 `round(x / viewport_width * 999)` 식으로 **0~999 정규화**할 수 있습니다.

사이드패널에는 캡처될 때마다 **스크린샷 카운터(1, 2, 3…)** 와 최신 화면이 표시됩니다.

## 6. 수동 캡처 — 자동이 놓치거나 좌표가 어긋날 때

대부분은 자동으로 잡히지만, **자동이 못 잡거나 bbox가 어긋나는 경우**가 있습니다. 그럴 때만 사이드패널의 수동 버튼으로 보정합니다. (정상 동작은 수동으로 또 찍지 마세요 — 중복 스텝이 생깁니다.)

**왜 필요한가 (자동의 한계):**

- **cross-origin iframe** (카카오/PASS 등 **간편인증** 위젯): 이벤트는 `allFrames`로 잡혀도, 좌표가 *iframe 기준*이라 전체 화면 위 bbox가 어긋날 수 있습니다.
- **별도 팝업 "창"**: 새 창으로 열리는 인증은 녹화 창만 추적하므로 자동 캡처가 안 됩니다.
- **큰 컨테이너 클릭**: 자동 bbox가 의도보다 큰 래퍼로 잡힐 때.
- **자동이 놓친 화면/상태**: 액션 이벤트가 안 잡힌 경우.

**수동 버튼:**

| 버튼 | 동작 |
| --- | --- |
| **📸 click — 캡처 후 영역 드래그** | 현재 화면을 캡처해 **큰 창**으로 띄움 → 클릭한 영역을 **마우스로 드래그** → `click`(bbox 픽셀+viewport)로 저장 |
| **📸 type** | 옆 칸에 **입력한 값**을 적고 누르면 `type`(value + 화면)으로 저장 |
| **⌨️ hotkey** | 옆 칸에 `ctrl+c` 처럼 조합키를 적고 누르면 `hotkey`(keys 배열 + 화면)로 저장. `+`로 분리, 소문자 정규화. **Enter는 제외**(효과가 결과 페이지로 잡힘) |
| **⏳ wait** | 로딩 대기 등을 `wait` 스텝으로 (선택) |
| **◀ go_back / go_forward ▶** | 브라우저 뒤로/앞으로 가기. **누르기 전 화면**을 관찰로 캡처 → 그다음 실제 뒤로/앞으로 버튼을 누름 |

> **go_back/go_forward는 왜 수동인가?** 브라우저 뒤로가기는 페이지 안 DOM 이벤트가 아니라 브라우저 UI라, "누르기 직전" 화면을 자동으로 가로챌 훅이 없습니다. 자동 감지는 이미 이동한 *뒤*에야 알게 돼 틀린 화면(도착 후)을 찍게 되므로, **누르기 전 화면**을 정확히 남기려면 수동 버튼이 맞습니다. 뒤로 간 결과 화면은 그다음 액션이 자동으로 관찰로 캡처합니다.

> 권장 흐름: **일단 자동으로 쭉 진행 → 세션 끝나고 `trajectory.html`을 보고 빠졌거나 박스가 틀린 스텝만** 다음 세션에서 수동으로 보정.

## 6-1. trajectory 편집 — 잘못 기록된 스텝 정리

`trajectory.html`을 **서버로 열면**(`/data/...`) 각 스텝을 편집할 수 있습니다.

| 기능 | 동작 | 되돌리기 |
| --- | --- | --- |
| **🗑 제외** (스텝별) | 잘못 기록된 스텝을 `trajectory.json` / `trajectory.html`에서 제거하고 남은 스텝을 1..N으로 재번호. **이미지·`metadata.json`은 보존** | 가능 (프레임 원본 디스크에 남음) |
| **🧹 고아 이미지 정리** | 어느 스텝도 참조하지 않는 `images/*.png`를 삭제 | **불가 (png 영구 삭제)** |

- **제외**는 학습 산출물(json/html)에서만 빼고 원본(이미지+metadata)은 남기므로 안전합니다.
- **고아 정리**는 실제 파일을 지우므로 확인창에서 경고 후 진행됩니다.

## 7. 저장 결과

세션이 끝나면 `ANNOTATION_DATA_DIR` 아래에 저장됩니다.

```
{study_id}/{task_id}/
  trajectory.json     # 스크린샷이 있는 스텝만 (type, 좌표, bbox, value, url ...)
  trajectory.html     # 사람이 보는 뷰어 (스텝마다 스샷 + bbox 박스 + 라벨)
  images/frame_N.png  # 각 스텝 스크린샷
{study_id}/{task_id}.webm       # 화면 녹화 (있을 때)
{study_id}/{task_id}/metadata.json  # 기록된 모든 이벤트 (스샷 유무 무관, 전체 행동 로그)
configs/{study_id}/{task_id}.json   # 세션 메타데이터 스냅샷
```

- **`trajectory.json` / `trajectory.html`** = 스크린샷이 찍힌 스텝만 추린 것
- **`metadata.json`** = 확장이 기록한 **모든 이벤트** (스크린샷 base64는 제외해 가볍게) — molmoweb처럼 전체 행동 로그가 필요하면 여기를 보세요.
- click 스텝의 `bbox`는 **픽셀 + viewport**, 수동 드래그는 `bbox_pct`(0~1 비율)도 함께 저장됩니다.

### trajectory 뷰어

서버 실행 중 브라우저에서:

- 목록: `http://127.0.0.1:5001/trajectories`
- 직접: `http://127.0.0.1:5001/data/{study_id}/{task_id}/trajectory.html`

**click 스텝에만** 해당 요소의 **bbox가 빨간 박스로** 화면 위에 그려지고(scroll/type/goto 등은 박스 없음), 입력값·goto URL이 함께 표시됩니다.

## 7-1. 원격 서버로 업로드 (`/server`)

수집한 `uploads/` 전체를 `.tar.gz`로 묶어 **원격 서버(SSH)** 로 보낼 수 있습니다.

1. `.env`에 SSH 접속 정보를 넣습니다 (`.env`는 gitignore 대상):

   ```
   ANNOTATION_SSH_HOST=ssh-xxxx.example.com
   ANNOTATION_SSH_PORT=22
   ANNOTATION_SSH_USER=your-user
   ANNOTATION_SSH_PASSWORD=your-password
   ANNOTATION_SSH_REMOTE_DIR=main-workspace/yerin_annotation
   ```

2. 브라우저에서 **`http://127.0.0.1:5001/server`** 접속 → 파일 이름 입력 폼이 뜸 → 이름 넣고 **전송**.
   - `uploads/` 전체 → `<이름>.tar.gz`로 묶여 원격 `ANNOTATION_SSH_REMOTE_DIR/`에 업로드 (폴더 없으면 자동 생성).
   - 이름을 비우면 `uploads_<타임스탬프>.tar.gz`로 저장.

- 전송은 `paramiko`(SFTP)로 처리합니다. `requirements.txt`에 포함.
- 익스텐션 코드는 전송에 포함되지 않습니다 — 오직 `uploads/`(수집 데이터)만 갑니다.

## 8. 원본(molmoweb annotation)에서 바뀐 점

원래는 "이벤트 통짜(`.gz`) 저장 + 태스크 스텝 체크 UI" 방식이었으나, **molmoweb식 액션 trajectory 자동 기록 + 뷰어**로 개편했습니다.

**서버 (`browser_app.py`)**
- 저장 형식 변경: `.gz` 통짜 → `trajectory.json` + `trajectory.html` + `images/` + `metadata.json`
- 스크린샷이 있는 이벤트만 trajectory 스텝으로, 전체 이벤트는 `metadata.json`으로 분리
- 클릭 요소 **bbox를 스크린샷 위에 빨간 박스**로 렌더, 입력값/클릭좌표/goto URL/답변 라벨 표시
- `/data` 정적 서빙 + `/trajectories` 목록 페이지 추가
- `task_steps`를 선택 사항으로 변경

**확장 — 서비스 워커 (`worker.js`)**
- 캡처 정책 재설계: 거의 모든 이벤트 → **click / type(input) / scroll / goto / 링크도착 / Enter결과 / 최종답변**만 캡처
- 클릭을 **클릭 순간(pointerdown)** 에 캡처(지연 제거) → 클릭한 화면 + bbox 정렬
- 내비게이션 분류: `direct_navigation`→`goto`, 링크 도착 페이지 캡처
- **`go_back`/`go_forward`는 수동 버튼으로 전환** — 자동 감지는 주입 race·방향 구분 불가로 불안정, "누르기 전 화면"을 못 잡음
- content script를 **`allFrames`** 로 주입 → iframe(간편인증 등) 안 액션도 기록
- 마지막 클릭/입력값을 `chrome.storage.local`에 저장했다가 검색 결과/수동 캡처에 `bbox`·값 첨부 (한 번 쓰면 소비)
- 수동 캡처 핸들러: `openDrawWindow`(큰 창 그리기), `recordDrawnBbox`(드래그한 영역을 픽셀 bbox로 기록), `captureForDraw`

**확장 — 콘텐츠 스크립트 (`event-collector.js`)**
- "너무 빠르게 동작" 빨간 경고 배너 비활성화(스크린샷 오염 방지)
- 클릭 bbox는 **가장 가까운 의미있는 컨트롤**(a/button/role…)로 잡고, 너무 크면 실제 클릭 요소로 보정
- **8px 미만 미세 스크롤 무시**(로딩 중 레이아웃 흔들림이 scroll로 잡히던 문제)

**확장 — 사이드패널 (`side-panel.*`) / 그리기 창 (`draw.html`, `draw.js`)**
- 태스크 스텝 체크 트래커 제거, **Final Answer** 접이식 섹션 추가
- **스크린샷 카운터 뱃지(1, 2, 3…)** + 최신 화면 표시
- **수동 캡처**: 📸 click(→큰 창에서 영역 드래그) / 📸 type(입력값) / **⌨️ hotkey(ctrl+c 등)** / ⏳ wait / **◀ go_back · go_forward ▶**
- **trajectory 편집**: `trajectory.html`에서 잘못된 스텝 **🗑 제외**(재번호), **🧹 고아 이미지 정리**

**서버 (`browser_app.py`) — 추가 기능**
- `trajectory.html`에서 스텝 제외(`/trajectory/delete_step`) · 고아 이미지 정리(`/trajectory/clean_orphans`)
- `hotkey` 스텝의 keys를 뷰어에 `ctrl+c` 형태로 표시
- **`/server`** — `uploads/` 전체를 `.tar.gz`로 묶어 SSH(SFTP)로 원격 전송 (자격증명은 `.env`)

**설정 / 문서**
- 예시 config에서 `task_steps` 제거, 저장 레이아웃 문서 갱신, 한국어 README 추가
- `paramiko` 의존성 추가(`/server` 전송용), 버전 고정(pinned `requirements.txt`)

## 9. 참고

- `uploads/`는 `.gitignore`에 포함되어 있어 참가자 데이터는 커밋되지 않습니다.
- 대규모 사용 시 시크릿 창 권장(`worker.js`의 `incognito: true`).
- 객체 스토리지가 필요하면 `ANNOTATION_DATA_DIR`을 `aws s3 sync`/`rclone` 등으로 동기화하세요.
