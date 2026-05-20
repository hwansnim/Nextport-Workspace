"""
작업로그.html 자동 업데이트 — Claude 가 매 세션 끝날 때 호출.

작동:
1. H:\\내 드라이브\\넥스트포트\\공구\\작업로그.html 읽음
2. <script id="log-data"> 안의 JSON 파싱
3. 새 세션 항목 만들거나 마지막 세션 업데이트
4. 다시 저장

호출 방법:
  python scripts/update_log.py "세션 제목" "요약 한 줄"
  python scripts/update_log.py --auto  # Git 로그에서 자동 추출
"""
from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import sys
from datetime import datetime
from pathlib import Path


# Windows 콘솔 utf-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


LOG_FILE = Path("H:/내 드라이브/넥스트포트/공구/작업로그.html")
FALLBACK = Path.home() / "Desktop" / "공구" / "작업로그.html"


def find_log():
    if LOG_FILE.exists():
        return LOG_FILE
    if FALLBACK.exists():
        return FALLBACK
    return None


def parse_log(path: Path) -> dict:
    html = path.read_text(encoding="utf-8")
    m = re.search(r'<script id="log-data" type="application/json">(.*?)</script>',
                  html, re.DOTALL)
    if not m:
        return {"version": 1, "sessions": []}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {"version": 1, "sessions": []}


def save_log(path: Path, data: dict):
    html = path.read_text(encoding="utf-8")
    json_str = json.dumps(data, ensure_ascii=False, indent=2)
    # </script> 이스케이프
    json_str = json_str.replace("</script>", "<\\/script>")
    new_html = re.sub(
        r'(<script id="log-data" type="application/json">)(.*?)(</script>)',
        lambda mm: mm.group(1) + "\n" + json_str + "\n  " + mm.group(3),
        html, count=1, flags=re.DOTALL,
    )
    path.write_text(new_html, encoding="utf-8")


def next_id(sessions: list) -> str:
    nums = []
    for s in sessions:
        sid = str(s.get("id", ""))
        if sid.startswith("s"):
            try:
                nums.append(int(sid[1:]))
            except ValueError:
                pass
    n = (max(nums) if nums else 0) + 1
    return f"s{n:03d}"


def get_pc_label() -> str:
    try:
        return f"{socket.gethostname()} (Windows)"
    except Exception:
        return "PC"


def get_recent_files() -> list[str]:
    """최근 30분 안에 변경된 코드/데이터 파일들."""
    try:
        root = Path(__file__).resolve().parent.parent
        import time
        cutoff = time.time() - 30 * 60
        recent = []
        for p in root.rglob("*"):
            if any(part.startswith(".") for part in p.parts):
                continue
            if "venv" in p.parts or "__pycache__" in p.parts:
                continue
            if p.suffix not in (".py", ".js", ".css", ".html", ".json", ".md"):
                continue
            try:
                if p.stat().st_mtime > cutoff:
                    rel = str(p.relative_to(root)).replace("\\", "/")
                    recent.append(rel)
            except Exception:
                pass
        return recent[:20]
    except Exception:
        return []


def add_session(title: str = "", summary: str = "", status: str = "in_progress"):
    log_path = find_log()
    if not log_path:
        print("[update_log] 작업로그.html 없음. 건너뜀.")
        return

    data = parse_log(log_path)
    sessions = data.setdefault("sessions", [])

    now = datetime.now().isoformat(timespec="seconds")
    sid = next_id(sessions)
    recent_files = get_recent_files()

    new_session = {
        "id": sid,
        "started_at": now,
        "ended_at": now,
        "computer": get_pc_label(),
        "title": title or "(자동 기록)",
        "user_intent": summary or "(자동)",
        "status": status,
        "actions": [{"type": "auto", "text": f"변경된 파일 {len(recent_files)}개 감지"}],
        "files": [{"path": f, "action": "edited", "summary": ""} for f in recent_files],
        "conversation": [],
        "next_steps": "",
    }
    sessions.insert(0, new_session)
    # 최대 100개 유지
    data["sessions"] = sessions[:100]
    save_log(log_path, data)
    print(f"[update_log] {sid} 추가됨 → {log_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("title", nargs="?", default="")
    parser.add_argument("summary", nargs="?", default="")
    parser.add_argument("--status", default="in_progress",
                        choices=["completed", "in_progress", "paused", "cancelled"])
    args = parser.parse_args()
    add_session(args.title, args.summary, args.status)


if __name__ == "__main__":
    main()
