# 🚀 넥스트포트 워크스페이스 — Fly.io 배포 가이드

## 📌 목표
- PC 꺼도 작동
- `nextport-workspace.fly.dev` 같은 영구 URL
- 한국 가까운 도쿄 서버 (빠름)
- 무료 사용량 안에서 시작 (한도 넘으면 월 $3~5)

---

## ✅ 미리 준비

- [ ] Fly.io 계정 (https://fly.io/app/sign-up) — 이메일만
- [ ] 신용카드 — 무료 한도 안이면 청구 X. **사용량 알람** 박을 거임
- [ ] Gemini API 키 (이미 있는 거)

---

## 1단계 ️ Fly CLI 설치

**Windows PowerShell** 관리자 권한으로:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

설치 후 새 터미널 열고:
```
fly version
```
버전 뜨면 OK.

---

## 2단계 ️ Fly 로그인

```
fly auth login
```
브라우저로 자동 로그인.

---

## 3단계 ️ 프로젝트 폴더에서 시작

```
cd C:\Users\user\Documents\harufix-cowork-tool
fly launch --no-deploy
```

물어보는 거:
- App name? → **nextport-workspace** (또는 너 원하는 거)
- Region? → **nrt (Tokyo)** ← 한국 가까움
- PostgreSQL? → **No**
- Redis? → **No**
- Deploy now? → **No** (아직 환경변수 안 박힘)

---

## 4단계 ️ 환경변수 박기 (Gemini API key)

```
fly secrets set GEMINI_API_KEY=<여기에 너 키 박기>
```

---

## 5단계 ️ Volume 만들기 (데이터 영구 저장)

```
fly volumes create nextport_data --size 1 --region nrt
```

1GB 무료. 충분.

---

## 6단계 ️ 첫 배포

```
fly deploy
```

5~10분 걸림. 첫 빌드 = 의존성 다운 + 컨테이너 만들기.

성공하면 URL 떠:
```
https://nextport-workspace.fly.dev
```

---

## 7단계 ️ 첫 접속 확인

브라우저로 https://nextport-workspace.fly.dev

- ✅ 워크스페이스 정상 뜨면 → 끝
- ❌ 빈 화면 / 에러 → `fly logs` 로 디버깅

---

## 8단계 ️ 초기 데이터 박기 (선택)

빈 시스템이라 캠페인 데이터 없음.

**옵션 A**: 워크스페이스에서 직접 캠페인 추가 (수동)

**옵션 B**: PC 데이터 그대로 옮기기:
```
# PC 에서 data 폴더 압축
# Fly volume에 업로드 (fly ssh sftp 사용)
fly ssh sftp
> put data/campaigns.json /app/data/campaigns.json
> put data/meetings.json /app/data/meetings.json
> put data/events.json /app/data/events.json
> put data/brands.json /app/data/brands.json
> put data/products.json /app/data/products.json
> put data/sellers.json /app/data/sellers.json
> exit
```

또는 GitHub 통해 (다음 단계).

---

## 9단계 ️ 셀러한테 URL 전달

영구 URL:
```
https://nextport-workspace.fly.dev/s/<셀러토큰>
```

워크스페이스에서 캠페인 클릭 → 셀러 페이지 카드 → 🔗 복사 → 카톡으로 셀러한테.

---

## 🆘 문제 생기면

```
fly logs              # 실시간 로그
fly status            # 앱 상태
fly ssh console       # 컨테이너 안 들어가기
fly deploy --rebuild  # 다시 배포 (캐시 무시)
```

---

## 💰 예상 비용

- 무료 한도: 작은 머신 1대 ($1.94/월 가치)
- 작은 사용량 = $0 (무료 한도 안)
- 셀러 10~50명 접속 = 무료
- 셀러 100명+ 자주 접속 = 월 $3~5

**카드 등록 필수**. 한도 알람 박아두면 안전.

---

## 🔧 PC 로컬 환경 (현재 그대로)

배포한 후에도 PC 로컬 환경은 그대로 작동:
- `start.bat` 실행 → 로컬 워크스페이스
- 인스타 스크래퍼 / Playwright 등 PC에서만 작동
- cloudflared 도 PC 모드에서만

**클라우드 = 메인 운영**, **PC = 개발/테스트** 로 분리.

---

## 📦 data 동기화 (PC ↔ 클라우드)

지금: 별개 데이터 (PC와 클라우드 분리)

원하면 추후 박을 수 있는 동기화:
- 클라우드 = source of truth
- PC = 클라우드 API로 데이터 fetch
- 또는 둘 다 같은 GitHub repo 참조

지금은 일단 클라우드 데이터만 사용 권장.
