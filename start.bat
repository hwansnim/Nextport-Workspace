@echo off
REM 하루픽스 공동구매 컨텐츠 툴 - 실행 스크립트
chcp 65001 > nul
cd /d "%~dp0"

echo ====================================
echo  하루픽스 공동구매 컨텐츠 툴
echo ====================================
echo.

REM Python 확인
python --version > nul 2>&1
if errorlevel 1 (
  echo [에러] Python이 설치되어 있지 않습니다.
  echo https://www.python.org/downloads/ 에서 Python 3.10 이상 설치 후 다시 실행하세요.
  pause
  exit /b 1
)

REM venv 자동 생성 (처음 1번만)
if not exist ".venv\" (
  echo [최초 1회] 가상환경 생성 중...
  python -m venv .venv
  call .venv\Scripts\activate.bat
  echo [최초 1회] 패키지 설치 중... (5~10분 걸릴 수 있어요)
  python -m pip install --upgrade pip
  python -m pip install -r requirements.txt
  echo [최초 1회] Playwright 브라우저 설치 중...
  python -m playwright install chromium
) else (
  call .venv\Scripts\activate.bat
)

REM config.json 없으면 안내
if not exist "config.json" (
  echo.
  echo [알림] config.json 이 없습니다.
  echo config.example.json 을 복사해서 config.json 으로 만들고
  echo Gemini API 키를 채워주세요.
  echo.
  echo 자세한 설치 방법은 README.md 를 보세요.
  pause
)

echo.
echo 서버 시작... 브라우저에서 http://127.0.0.1:5000 열어주세요.
echo (종료: Ctrl+C)
echo.
python app.py

pause
