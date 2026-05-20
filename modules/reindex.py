"""디스크의 기존 파일들을 manifest로 재인덱싱."""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("reindex")


def reindex_seller(seller_folder: Path, seller_id: str) -> dict[str, Any]:
    """디스크 파일 스캔해서 manifest.json 재구성."""
    if not seller_folder.exists():
        return {"error": "folder not found", "items_added": 0}

    manifest_path = seller_folder / "_manifest.json"
    existing = {}
    profile = {}
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            profile = data.get("profile", {})
            for it in data.get("items", []):
                existing[it.get("id") or it.get("file_path")] = it
        except Exception:
            pass

    new_items = []
    for category_dir in (seller_folder / "highlights").glob("*"):
        if not category_dir.is_dir():
            continue
        label = category_dir.name.replace("_", " ").strip()
        for f in sorted(category_dir.glob("*")):
            if not f.is_file():
                continue
            ext = f.suffix.lower()
            if ext not in (".jpg", ".jpeg", ".png", ".mp4", ".webp"):
                continue
            try:
                data = f.read_bytes()
            except Exception:
                continue
            content_hash = hashlib.sha256(data).hexdigest()[:16]
            # 파일명에서 인덱스/날짜 추출
            m = re.match(r"(\d{4}-\d{2}-\d{2})_(\d+)_", f.name)
            captured_at = None
            story_idx = None
            if m:
                captured_at = m.group(1) + "T00:00:00"
                story_idx = int(m.group(2))
            rel_path = f"highlights/{category_dir.name}/{f.name}"

            item_id = f"{seller_id}_h_{content_hash}"
            if item_id in existing:
                # 그대로 유지하되 hash 채움
                it = existing[item_id]
                it["content_hash"] = content_hash
                new_items.append(it)
                continue

            new_items.append({
                "id": item_id,
                "content_hash": content_hash,
                "type": "highlight_story",
                "media": "video" if ext == ".mp4" else "image",
                "highlight_label": label,
                "story_index": story_idx,
                "file_path": rel_path,
                "drive_id": None,
                "stored": "local",
                "size": len(data),
                "captured_at": captured_at or datetime.now().isoformat(timespec="seconds"),
                "alt_text": "",
            })

    out = {
        "version": 1,
        "seller_folder": seller_folder.name,
        "profile": profile,
        "items": new_items,
    }
    manifest_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"items_added": len(new_items), "manifest_path": str(manifest_path)}


if __name__ == "__main__":
    import sys
    root = Path(__file__).resolve().parent.parent / "data" / "local_archive"
    for seller_dir in root.iterdir():
        if seller_dir.is_dir():
            seller_id = seller_dir.name.split(".")[0]
            res = reindex_seller(seller_dir, seller_id)
            print(f"{seller_dir.name}: {res}")
