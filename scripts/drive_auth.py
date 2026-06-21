"""
구글 드라이브 OAuth 1회 로그인 → token.json 생성.
실행하면 브라우저가 열리고, 사용자가 동의(허용)하면 token.json 저장됨.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCOPES = ["https://www.googleapis.com/auth/drive"]

from google_auth_oauthlib.flow import InstalledAppFlow

creds_file = ROOT / "credentials.json"
token_file = ROOT / "token.json"

if not creds_file.exists():
    print("ERROR: credentials.json 없음", flush=True)
    sys.exit(1)

flow = InstalledAppFlow.from_client_secrets_file(str(creds_file), SCOPES)
# access_type=offline + prompt=consent → refresh_token 확실히 받기
creds = flow.run_local_server(
    port=0,
    access_type="offline",
    prompt="consent",
    authorization_prompt_message="브라우저에서 로그인/허용 해주세요:\n{url}",
    success_message="완료! 이 창은 닫아도 됩니다.",
    open_browser=True,
)
token_file.write_text(creds.to_json(), encoding="utf-8")
print("TOKEN_SAVED:", token_file, flush=True)
print("refresh_token 있음:", bool(creds.refresh_token), flush=True)
