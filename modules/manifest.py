"""
manifest.json 관리자
- 셀러별 아카이브 메타데이터 저장
- Drive 또는 로컬에서 읽고 쓰기
- 중복 방지 (item_id 기반)
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("manifest")


class ManifestManager:
    FILE_NAME = "_manifest.json"
    META_FILE_NAME = "_meta.json"

    def __init__(self, seller_folder_name: str, *, drive: Any | None = None, local_root: Path | None = None):
        self.seller_folder_name = seller_folder_name
        self.drive = drive
        self.local_root = local_root
        self.data: dict[str, Any] = {
            "version": 1,
            "seller_folder": seller_folder_name,
            "profile": {},
            "items": [],
        }
        self._loaded = False

    def load(self) -> None:
        # Drive 우선
        if self.drive is not None:
            try:
                raw = self.drive.read_text(self.FILE_NAME)
                if raw:
                    self.data = json.loads(raw)
                    self._loaded = True
                    return
            except Exception as e:  # noqa: BLE001
                log.warning(f"Drive manifest 읽기 실패: {e}")
        # 로컬
        if self.local_root is not None:
            p = self.local_root / self.FILE_NAME
            if p.exists():
                try:
                    self.data = json.loads(p.read_text(encoding="utf-8"))
                    self._loaded = True
                    return
                except Exception as e:  # noqa: BLE001
                    log.warning(f"Local manifest 파싱 실패: {e}")
        self._loaded = True

    def save(self) -> None:
        raw = json.dumps(self.data, ensure_ascii=False, indent=2)
        if self.drive is not None:
            try:
                self.drive.write_text(self.FILE_NAME, raw)
                # _meta.json 별도로
                self.drive.write_text(self.META_FILE_NAME, json.dumps(self.data.get("profile", {}), ensure_ascii=False, indent=2))
                return
            except Exception as e:  # noqa: BLE001
                log.warning(f"Drive manifest 쓰기 실패: {e}")
        if self.local_root is not None:
            self.local_root.mkdir(parents=True, exist_ok=True)
            (self.local_root / self.FILE_NAME).write_text(raw, encoding="utf-8")
            (self.local_root / self.META_FILE_NAME).write_text(
                json.dumps(self.data.get("profile", {}), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def update_profile_meta(self, meta: dict[str, Any]) -> None:
        self.data.setdefault("profile", {}).update(meta)

    def has_item(self, item_id: str) -> bool:
        return any(it.get("id") == item_id for it in self.data.get("items", []))

    def has_hash(self, content_hash: str) -> bool:
        if not content_hash:
            return False
        return any(it.get("content_hash") == content_hash for it in self.data.get("items", []))

    def add_item(self, item: dict[str, Any]) -> None:
        self.data.setdefault("items", []).append(item)

    def backfill_hashes(self, local_root: Path) -> int:
        """기존 아이템 중 content_hash 없는 것들을 디스크 파일에서 계산해 채움."""
        import hashlib
        filled = 0
        for it in self.data.get("items", []):
            if it.get("content_hash"):
                continue
            fp = it.get("file_path")
            if not fp:
                continue
            full = local_root / fp
            if full.exists() and full.is_file():
                try:
                    data = full.read_bytes()
                    it["content_hash"] = hashlib.sha256(data).hexdigest()[:16]
                    filled += 1
                except Exception:
                    pass
        return filled

    def get_stats(self) -> dict[str, Any]:
        items = self.data.get("items", [])
        by_type = {}
        by_highlight = {}
        total_size = 0
        for it in items:
            t = it.get("type", "unknown")
            by_type[t] = by_type.get(t, 0) + 1
            label = it.get("highlight_label", "")
            if label:
                by_highlight[label] = by_highlight.get(label, 0) + 1
            total_size += it.get("size", 0) or 0
        return {
            "total_items": len(items),
            "by_type": by_type,
            "by_highlight": by_highlight,
            "total_size_bytes": total_size,
            "last_updated": self.data.get("profile", {}).get("last_scraped_at"),
        }
