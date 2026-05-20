# 넥스트포트 공구 워크스페이스

공동구매 마켓 통합 관리 시스템 — 셀러 캠페인 / 캘린더 / 미팅 분석 / AI 자동화 / 셀러 모바일 페이지.

## 🎯 주요 기능

- **셀러 캠페인 컨트롤 타워** — 캠페인 단독 상세 페이지, 마켓 준비 대시보드
- **캘린더** — 월 단위 간트형 + 셀러별 색상 + 공휴일 자동
- **대시보드** — 정산/매출/공헌이익 자동 계산
- **미팅 / 녹취록** — 오디오 업로드 → Gemini 자동 분석
- **AI 채팅 어시스턴트** — 캡처 던지면 자동 처리 (Function Calling)
- **셀러 모바일 페이지** — 플레이북 스타일, 토큰 URL
- **자동 스케줄 생성** — D-N 기반 일자 + Gemini 멘트
- **브랜드 / N차 / 다중 캠페인** 관리
- **자동 백업** — 매 작업 후 Google Drive

## 🏗 기술 스택

- **백엔드**: Python Flask
- **AI**: Google Gemini API (Function Calling, Audio, Multimodal)
- **데이터**: JSON 파일
- **호스팅**: Fly.io (Production) / 로컬 (Dev)
- **외부 노출 (로컬)**: Cloudflare Tunnel

## 🚀 실행

### 로컬 (PC)
```
start.bat
```
→ http://127.0.0.1:5000

### 클라우드 (Fly.io)
[DEPLOY_GUIDE.md](./DEPLOY_GUIDE.md) 참조.

## 📁 폴더 구조

```
.
├── app.py                  # Flask 메인 서버
├── modules/                # 기능 모듈
│   ├── chat_agent.py       # AI 채팅 + Function Calling
│   ├── meeting_analyzer.py # 미팅 녹취 분석
│   ├── schedule_gen.py     # 스케줄 생성
│   ├── scraper.py          # 인스타 스크래퍼 (로컬 전용)
│   ├── gemini.py           # Gemini 이미지 태깅
│   ├── manifest.py         # 셀러 manifest
│   ├── reindex.py          # 재인덱싱
│   └── drive.py            # Google Drive (로컬 전용)
├── templates/              # HTML
├── static/                 # JS / CSS
├── data/                   # JSON 데이터
└── scripts/                # 백업 / 유틸
```

## 🔐 환경변수 / 비밀

`config.json` (로컬) 또는 환경변수 (클라우드):
- `GEMINI_API_KEY` — Gemini API 키
- `ENV_MODE` — `local` (PC) 또는 `cloud` (Fly.io)

## 📚 추가 문서

- [CLAUDE.md](./CLAUDE.md) — Claude 작업 절대규칙 (다중 PC 동기화)
- [DEPLOY_GUIDE.md](./DEPLOY_GUIDE.md) — Fly.io 배포 단계
