"""
Activity Log — 모든 사용자 액션 기록 (탭 전환, 발송, 임포트, 편집 등).
주기적으로 Google Drive 자동 sync → 다른 PC에서 이어 작업 가능.

저장 위치 (로컬): data/activity_log.jsonl (append-only JSON Lines)
Drive 위치:    [넥스트포트 공동구매 워크스페이스] / activity_log_YYYY-MM-DD.jsonl
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("activity_log")
_lock = threading.Lock()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOG_FILE = DATA_DIR / "activity_log.jsonl"

# Drive 자동 sync 설정
DRIVE_ROOT_FOLDER = "[넥스트포트 공동구매 워크스페이스]"
SYNC_INTERVAL_SECONDS = 300   # 5분마다
_last_synced_at: float = 0.0


def log_action(
    action: str,
    *,
    tab: str = "",
    target: str = "",
    detail: dict[str, Any] | None = None,
    user: str = "hwansnim",
) -> None:
    """액션 1건 append. 절대 raise 안 함 (보조 기능)."""
    try:
        entry = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "user": user,
            "action": action,
            "tab": tab,
            "target": target,
            "detail": detail or {},
        }
        DATA_DIR.mkdir(exist_ok=True)
        with _lock:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        log.warning(f"활동 로그 기록 실패: {e}")


def read_recent(limit: int = 200) -> list[dict]:
    """최근 N건 (역순)."""
    if not LOG_FILE.exists():
        return []
    try:
        with open(LOG_FILE, encoding="utf-8") as f:
            lines = f.readlines()
        entries = []
        for line in reversed(lines[-limit:]):
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries
    except Exception as e:
        log.warning(f"활동 로그 읽기 실패: {e}")
        return []


def sync_to_drive(config: dict, *, force: bool = False) -> dict:
    """
    Drive 의 [넥스트포트 공동구매 워크스페이스] 폴더로 sync.
    - activity_log.jsonl  → 그날 날짜별 파일
    - 주요 데이터 파일 (influencers.json, our_accounts.json, inbox_messages.json, campaigns_v2.json) 백업
    """
    global _last_synced_at
    import time

    now = time.time()
    if not force and (now - _last_synced_at) < SYNC_INTERVAL_SECONDS:
        return {"skipped": True, "reason": f"{int(now - _last_synced_at)}초 전 sync. 다음 sync까지 {int(SYNC_INTERVAL_SECONDS - (now - _last_synced_at))}초"}

    try:
        from drive import DriveStore  # type: ignore
    except ImportError:
        return {"error": "drive 모듈 import 실패"}

    # DriveStore 는 root_folder_name 을 config 에서 가져오므로 override
    cfg2 = dict(config)
    cfg2.setdefault("google", {})
    cfg2["google"] = {**cfg2.get("google", {}), "drive_root_folder_name": DRIVE_ROOT_FOLDER}

    try:
        store = DriveStore(cfg2)
        store.ensure_root()
        store.ensure_seller_folder("workspace_data")  # 하위 폴더 1개로 사용
    except FileNotFoundError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Drive 연결 실패: {e}"}

    uploaded = []
    failed = []

    # 1) activity_log → 날짜별 파일
    today = datetime.now().strftime("%Y-%m-%d")
    if LOG_FILE.exists():
        try:
            data = LOG_FILE.read_bytes()
            store.upload_bytes(f"activity_log_{today}.jsonl", data, mime_type="application/x-ndjson")
            uploaded.append(f"activity_log_{today}.jsonl")
        except Exception as e:
            failed.append(("activity_log", str(e)))

    # 2) 주요 데이터 백업
    for fname in [
        "influencers.json",
        "our_accounts.json",
        "inbox_messages.json",
        "campaigns_v2.json",
        "dm_templates_v2.json",
        "events.json",
        "meetings.json",
    ]:
        fp = DATA_DIR / fname
        if not fp.exists():
            continue
        try:
            store.upload_bytes(f"backup/{fname}", fp.read_bytes(), mime_type="application/json")
            uploaded.append(f"backup/{fname}")
        except Exception as e:
            failed.append((fname, str(e)))

    _last_synced_at = now
    return {
        "ok": True,
        "uploaded": uploaded,
        "failed": failed,
        "synced_at": datetime.now().isoformat(timespec="seconds"),
        "drive_folder": DRIVE_ROOT_FOLDER,
    }


def get_sync_status() -> dict:
    import time
    if _last_synced_at == 0:
        return {"synced": False, "next_in_seconds": 0}
    elapsed = time.time() - _last_synced_at
    return {
        "synced": True,
        "last_synced_at": datetime.fromtimestamp(_last_synced_at).isoformat(timespec="seconds"),
        "elapsed_seconds": int(elapsed),
        "next_in_seconds": max(0, int(SYNC_INTERVAL_SECONDS - elapsed)),
    }
