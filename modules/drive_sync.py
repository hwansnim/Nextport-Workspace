"""
드라이브 백업 동기화 — data/*.json 을 구글 드라이브 폴더와 양방향 동기화.

- 인증: 로컬은 token.json 파일, 클라우드(Render)는 환경변수 GOOGLE_TOKEN_JSON.
- 서버 시작 시: 드라이브 폴더 → 로컬 data/ 다운로드 (드라이브가 진실의 원천).
- 데이터 변경 시: 백그라운드 워처가 바뀐 파일을 드라이브로 업로드 (디바운스 ~2초).

Render 무료(휘발성 디스크) + 팀 공유를 위해 도입. 단일 인스턴스라 동시편집 충돌 거의 없음.
"""
from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("drive_sync")

SCOPES = ["https://www.googleapis.com/auth/drive"]
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FOLDER_ID = "1ovjCalrOI26ICfuTQ7wLCVs6hQdn2hON"  # 넥스트포트_워크스페이스_데이터

# 머신 전용/임시 파일 — 동기화 제외
EXCLUDE = {"tunnel.json"}

# 동기화 대상 = data/ 바로 아래 *.json (하위폴더/대용량/제외목록 빼고)
def _data_files(data_dir: Path):
    return [p for p in data_dir.glob("*.json") if p.is_file() and p.name not in EXCLUDE]


def _folder_id() -> str:
    return os.environ.get("DRIVE_DATA_FOLDER_ID") or DEFAULT_FOLDER_ID


def _load_creds():
    """token.json 파일 또는 GOOGLE_TOKEN_JSON 환경변수에서 자격증명 로드 + 자동 갱신."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    raw = os.environ.get("GOOGLE_TOKEN_JSON")
    if raw:
        info = json.loads(raw)
    else:
        tf = ROOT / "token.json"
        if not tf.exists():
            return None
        info = json.loads(tf.read_text(encoding="utf-8"))
    creds = Credentials.from_authorized_user_info(info, SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return creds


_service = None


def _get_service():
    global _service
    if _service is not None:
        return _service
    creds = _load_creds()
    if not creds:
        return None
    from googleapiclient.discovery import build
    _service = build("drive", "v3", credentials=creds, cache_discovery=False)
    return _service


def enabled() -> bool:
    """동기화 가능 여부 (자격증명 존재)."""
    return bool(os.environ.get("GOOGLE_TOKEN_JSON")) or (ROOT / "token.json").exists()


def _remote_index(svc) -> dict[str, str]:
    """드라이브 폴더 안의 {파일명: 파일id}."""
    fid = _folder_id()
    q = f"'{fid}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'"
    out: dict[str, str] = {}
    page = None
    while True:
        res = svc.files().list(q=q, fields="nextPageToken, files(id,name)", pageSize=200, pageToken=page).execute()
        for f in res.get("files", []):
            out[f["name"]] = f["id"]
        page = res.get("nextPageToken")
        if not page:
            break
    return out


def download_all(data_dir: Path) -> int:
    """드라이브 폴더의 모든 *.json 을 로컬 data/ 로 다운로드. 받은 개수 반환."""
    svc = _get_service()
    if not svc:
        return 0
    from googleapiclient.http import MediaIoBaseDownload
    idx = _remote_index(svc)
    n = 0
    for name, fid in idx.items():
        if not name.endswith(".json") or name in EXCLUDE:
            continue
        try:
            buf = io.BytesIO()
            dl = MediaIoBaseDownload(buf, svc.files().get_media(fileId=fid))
            done = False
            while not done:
                _, done = dl.next_chunk()
            (data_dir / name).write_bytes(buf.getvalue())
            n += 1
        except Exception as e:
            log.warning(f"[drive_sync] 다운로드 실패 {name}: {e}")
    log.info(f"[drive_sync] 드라이브 → 로컬 {n}개 다운로드")
    return n


def upload(path: Path) -> bool:
    """파일 1개를 드라이브 폴더에 업서트(있으면 갱신, 없으면 생성)."""
    svc = _get_service()
    if not svc:
        return False
    from googleapiclient.http import MediaFileUpload
    fid = _folder_id()
    name = path.name
    try:
        idx = _remote_index(svc)
        media = MediaFileUpload(str(path), mimetype="application/json", resumable=False)
        if name in idx:
            svc.files().update(fileId=idx[name], media_body=media).execute()
        else:
            svc.files().create(
                body={"name": name, "parents": [fid]},
                media_body=media, fields="id",
            ).execute()
        return True
    except Exception as e:
        log.warning(f"[drive_sync] 업로드 실패 {name}: {e}")
        return False


_watch_thread: Optional[threading.Thread] = None


def start_watcher(data_dir: Path, debounce: float = 2.0, interval: float = 1.5):
    """data/*.json mtime 감시 → 안정되면(디바운스) 드라이브로 업로드."""
    global _watch_thread
    if _watch_thread and _watch_thread.is_alive():
        return
    if not enabled():
        return

    state: dict[str, float] = {}  # name -> 마지막 업로드한 mtime

    def loop():
        # 초기 mtime 기록 (시작 직후 전체 업로드 폭주 방지 — 다운로드로 이미 최신)
        for p in _data_files(data_dir):
            state[p.name] = p.stat().st_mtime
        while True:
            try:
                now = time.time()
                for p in _data_files(data_dir):
                    m = p.stat().st_mtime
                    if state.get(p.name) == m:
                        continue
                    # 변경됨 + 안정(디바운스 경과) 시에만 업로드
                    if now - m >= debounce:
                        if upload(p):
                            state[p.name] = m
                            log.info(f"[drive_sync] 로컬 → 드라이브 업로드: {p.name}")
            except Exception as e:
                log.warning(f"[drive_sync] 워처 오류: {e}")
            time.sleep(interval)

    _watch_thread = threading.Thread(target=loop, name="drive-sync", daemon=True)
    _watch_thread.start()
    log.info("[drive_sync] 워처 시작")
