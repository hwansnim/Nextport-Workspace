"""
Google Drive 업로더
- OAuth 인증 (credentials.json + token.json)
- 셀러 폴더 자동 생성
- 파일 업로드 (rel_path 기반 하위 폴더 생성)
- 텍스트 파일 read/write (manifest 용)
"""
from __future__ import annotations

import io
import json
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("drive")

SCOPES = ["https://www.googleapis.com/auth/drive"]


class DriveStore:
    def __init__(self, config: dict[str, Any]):
        # Lazy import (의존성 없을 때 graceful)
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build

        self._Request = Request
        self._Credentials = Credentials
        self._InstalledAppFlow = InstalledAppFlow

        project_root = Path(__file__).resolve().parent.parent
        creds_file = project_root / config.get("google", {}).get("credentials_file", "credentials.json")
        token_file = project_root / "token.json"

        creds = None
        if token_file.exists():
            creds = self._Credentials.from_authorized_user_file(str(token_file), SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                if not creds_file.exists():
                    raise FileNotFoundError(
                        f"credentials.json 없음. Google Cloud Console에서 OAuth client (Desktop app) 만들고 "
                        f"다운로드 후 {creds_file} 위치에 놓아주세요."
                    )
                flow = self._InstalledAppFlow.from_client_secrets_file(str(creds_file), SCOPES)
                creds = flow.run_local_server(port=0)
            token_file.write_text(creds.to_json(), encoding="utf-8")

        self.service = build("drive", "v3", credentials=creds, cache_discovery=False)
        self.root_folder_name = config.get("google", {}).get("drive_root_folder_name", "공동구매_셀러_아카이브")
        self.root_folder_id: Optional[str] = None
        self.seller_folder_id: Optional[str] = None
        self._folder_cache: dict[str, str] = {}  # path -> id

    # ─── 헬퍼 ─────────────────────────────────────
    def _find_or_create_folder(self, name: str, parent_id: Optional[str] = None) -> str:
        cache_key = f"{parent_id or 'root'}::{name}"
        if cache_key in self._folder_cache:
            return self._folder_cache[cache_key]

        q = [
            f"name = '{name.replace(chr(39), chr(92) + chr(39))}'",
            "mimeType = 'application/vnd.google-apps.folder'",
            "trashed = false",
        ]
        if parent_id:
            q.append(f"'{parent_id}' in parents")
        else:
            q.append("'root' in parents")
        res = self.service.files().list(q=" and ".join(q), fields="files(id, name)", pageSize=10).execute()
        files = res.get("files", [])
        if files:
            fid = files[0]["id"]
        else:
            body = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
            if parent_id:
                body["parents"] = [parent_id]
            created = self.service.files().create(body=body, fields="id").execute()
            fid = created["id"]
        self._folder_cache[cache_key] = fid
        return fid

    def _ensure_path_folders(self, rel_path: str) -> tuple[str, str]:
        """rel_path('highlights/[01]_xxx/file.jpg')의 부모 폴더 ID와 파일명 반환."""
        if self.seller_folder_id is None:
            raise RuntimeError("ensure_seller_folder() 먼저 호출")
        parts = [p for p in rel_path.replace("\\", "/").split("/") if p]
        if not parts:
            raise ValueError("empty path")
        filename = parts[-1]
        parent_id = self.seller_folder_id
        for d in parts[:-1]:
            parent_id = self._find_or_create_folder(d, parent_id)
        return parent_id, filename

    def _find_file(self, name: str, parent_id: str) -> Optional[str]:
        q = (
            f"name = '{name.replace(chr(39), chr(92) + chr(39))}' "
            f"and '{parent_id}' in parents and trashed = false"
        )
        res = self.service.files().list(q=q, fields="files(id, name)", pageSize=5).execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    # ─── 공개 API ─────────────────────────────────
    def ensure_root(self) -> str:
        self.root_folder_id = self._find_or_create_folder(self.root_folder_name)
        return self.root_folder_id

    def ensure_seller_folder(self, seller_folder_name: str) -> str:
        if self.root_folder_id is None:
            self.ensure_root()
        self.seller_folder_id = self._find_or_create_folder(seller_folder_name, self.root_folder_id)
        return self.seller_folder_id

    def upload_bytes(self, rel_path: str, data: bytes, mime_type: Optional[str] = None) -> str:
        from googleapiclient.http import MediaIoBaseUpload

        parent_id, filename = self._ensure_path_folders(rel_path)
        if mime_type is None:
            mime_type, _ = mimetypes.guess_type(filename)
            mime_type = mime_type or "application/octet-stream"
        media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime_type, resumable=False)

        existing_id = self._find_file(filename, parent_id)
        if existing_id:
            updated = self.service.files().update(fileId=existing_id, media_body=media).execute()
            return updated["id"]
        body = {"name": filename, "parents": [parent_id]}
        created = self.service.files().create(body=body, media_body=media, fields="id").execute()
        return created["id"]

    def write_text(self, rel_path: str, text: str) -> str:
        return self.upload_bytes(rel_path, text.encode("utf-8"), mime_type="application/json; charset=utf-8")

    def read_text(self, rel_path: str) -> Optional[str]:
        from googleapiclient.http import MediaIoBaseDownload

        if self.seller_folder_id is None:
            return None
        parts = [p for p in rel_path.replace("\\", "/").split("/") if p]
        parent_id = self.seller_folder_id
        for d in parts[:-1]:
            parent_id = self._find_or_create_folder(d, parent_id)
        file_id = self._find_file(parts[-1], parent_id)
        if not file_id:
            return None
        buf = io.BytesIO()
        request = self.service.files().get_media(fileId=file_id)
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buf.getvalue().decode("utf-8", errors="replace")
