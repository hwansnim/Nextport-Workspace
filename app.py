"""
하루픽스 공동구매 컨텐츠 툴 - 셀러 아카이빙 서버
- Flask 웹 서버
- 셀러별 업데이트 트리거
- 진행 상황 표시
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_cors import CORS

# Project paths
ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
LOGS_DIR = ROOT / "logs"
MODULES_DIR = ROOT / "modules"
SELLERS_FILE = DATA_DIR / "sellers.json"
CONFIG_FILE = ROOT / "config.json"
CONFIG_EXAMPLE = ROOT / "config.example.json"

# Ensure dirs
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOGS_DIR / "server.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("app")

# Add modules to import path
sys.path.insert(0, str(MODULES_DIR))


def load_config() -> dict[str, Any]:
    cfg = {}
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    # 환경변수 우선 (Production 배포 시 비밀 박기)
    cfg.setdefault("gemini", {})
    env_key = os.getenv("GEMINI_API_KEY")
    if env_key:
        cfg["gemini"]["api_key"] = env_key
    # 환경 모드 (cloud / local)
    cfg["env_mode"] = os.getenv("ENV_MODE", "local")  # "cloud" or "local"
    return cfg


def load_sellers() -> list[dict[str, Any]]:
    if not SELLERS_FILE.exists():
        return []
    raw = json.loads(SELLERS_FILE.read_text(encoding="utf-8"))
    return raw.get("sellers", [])


def save_sellers(sellers: list[dict[str, Any]]) -> None:
    SELLERS_FILE.write_text(
        json.dumps({"sellers": sellers}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# In-memory job state. Each job tracks one update run.
JOBS: dict[str, dict[str, Any]] = {}
JOB_LOCK = threading.Lock()


def make_job(seller_id: str) -> str:
    job_id = uuid.uuid4().hex[:12]
    with JOB_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "seller_id": seller_id,
            "status": "queued",  # queued | running | done | error
            "progress": 0,
            "total": 0,
            "message": "대기 중...",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "errors": [],
            "items_added": 0,
        }
    return job_id


def update_job(job_id: str, **kwargs) -> None:
    with JOB_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(kwargs)


def run_archive_job(job_id: str, seller: dict[str, Any]) -> None:
    """백그라운드 스레드에서 실제 아카이빙 작업 실행."""
    update_job(job_id, status="running", message=f"{seller['name']} 아카이빙 시작...")
    try:
        # 실제 스크래퍼는 modules/scraper.py 에서 import (다음 단계에 구현)
        try:
            from scraper import archive_seller  # type: ignore
        except ImportError:
            update_job(
                job_id,
                status="error",
                message="스크래퍼 모듈이 아직 준비되지 않았어요. (modules/scraper.py)",
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )
            return

        cfg = load_config()
        result = archive_seller(
            seller=seller,
            config=cfg,
            on_progress=lambda **kw: update_job(job_id, **kw),
        )
        update_job(
            job_id,
            status="done",
            message=f"완료! {result.get('items_added', 0)}개 추가됨",
            items_added=result.get("items_added", 0),
            finished_at=datetime.now().isoformat(timespec="seconds"),
        )
    except Exception as e:  # noqa: BLE001
        log.exception("Archive job failed")
        update_job(
            job_id,
            status="error",
            message=f"에러: {e}",
            finished_at=datetime.now().isoformat(timespec="seconds"),
        )


# Flask app
app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
CORS(app)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/sellers", methods=["GET"])
def api_sellers():
    sellers = load_sellers()
    return jsonify({"sellers": sellers})


@app.route("/api/sellers", methods=["POST"])
def api_sellers_add():
    payload = request.get_json(force=True)
    sellers = load_sellers()
    new_id = f"{len(sellers) + 1:03d}"
    new_seller = {
        "id": new_id,
        "name": payload.get("name", "").strip(),
        "instagram": payload.get("instagram", "").strip().lstrip("@"),
        "display_name": payload.get("display_name", payload.get("name", "")).strip(),
        "notes": payload.get("notes", "").strip(),
        "active": True,
    }
    if not new_seller["name"] or not new_seller["instagram"]:
        return jsonify({"error": "name 과 instagram 필수"}), 400
    sellers.append(new_seller)
    save_sellers(sellers)
    return jsonify({"seller": new_seller})


@app.route("/api/instagram/login", methods=["POST"])
def api_instagram_login():
    """IG 로그인 전용 작업. Playwright 창을 띄워 사용자가 로그인할 시간 줌."""
    job_id = uuid.uuid4().hex[:12]
    with JOB_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "seller_id": "_login",
            "status": "running",
            "progress": 0,
            "total": 10,
            "message": "로그인 헬퍼 시작...",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "errors": [],
            "items_added": 0,
        }

    def run():
        try:
            from scraper import login_helper  # type: ignore
            cfg = load_config()
            result = login_helper(cfg, on_progress=lambda **kw: update_job(job_id, **kw))
            update_job(
                job_id,
                status="done" if result.get("logged_in") else "error",
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )
        except Exception as e:  # noqa: BLE001
            log.exception("Login helper failed")
            update_job(
                job_id, status="error", message=f"에러: {e}",
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/sellers/<seller_id>/update", methods=["POST"])
def api_seller_update(seller_id: str):
    sellers = load_sellers()
    seller = next((s for s in sellers if s["id"] == seller_id), None)
    if not seller:
        return jsonify({"error": "셀러 없음"}), 404
    job_id = make_job(seller_id)
    t = threading.Thread(target=run_archive_job, args=(job_id, seller), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/api/sellers/<seller_id>", methods=["PATCH"])
def api_seller_patch(seller_id: str):
    payload = request.get_json(force=True)
    sellers = load_sellers()
    seller = next((s for s in sellers if s["id"] == seller_id), None)
    if not seller:
        return jsonify({"error": "셀러 없음"}), 404
    for key in ("name", "instagram", "display_name", "notes", "active"):
        if key in payload:
            v = payload[key]
            if isinstance(v, str):
                v = v.strip().lstrip("@") if key == "instagram" else v.strip()
            seller[key] = v
    save_sellers(sellers)
    return jsonify({"seller": seller})


@app.route("/api/sellers/<seller_id>", methods=["DELETE"])
def api_seller_delete(seller_id: str):
    sellers = load_sellers()
    sellers = [s for s in sellers if s["id"] != seller_id]
    save_sellers(sellers)
    return jsonify({"ok": True})


@app.route("/api/sellers/<seller_id>/stats", methods=["GET"])
def api_seller_stats(seller_id: str):
    """셀러 manifest에서 통계 + 프로필 정보 반환."""
    sellers = load_sellers()
    seller = next((s for s in sellers if s["id"] == seller_id), None)
    if not seller:
        return jsonify({"error": "셀러 없음"}), 404
    seller_folder = f"{seller['id']}.{seller['name']}_@{seller['instagram']}"
    local_root = ROOT / "data" / "local_archive" / seller_folder
    manifest_path = local_root / "_manifest.json"
    if not manifest_path.exists():
        return jsonify({"profile": {}, "stats": {"total_items": 0}, "exists": False})
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        items = data.get("items", [])
        by_highlight = {}
        total_size = 0
        for it in items:
            label = it.get("highlight_label", "")
            if label:
                by_highlight[label] = by_highlight.get(label, 0) + 1
            total_size += it.get("size", 0) or 0
        return jsonify({
            "profile": data.get("profile", {}),
            "stats": {
                "total_items": len(items),
                "by_highlight": by_highlight,
                "total_size_bytes": total_size,
            },
            "exists": True,
            "local_path": str(local_root),
        })
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


@app.route("/api/sellers/<seller_id>/open", methods=["POST"])
def api_seller_open_folder(seller_id: str):
    """셀러 아카이브 폴더를 탐색기로 열기."""
    import subprocess

    sellers = load_sellers()
    seller = next((s for s in sellers if s["id"] == seller_id), None)
    if not seller:
        return jsonify({"error": "셀러 없음"}), 404
    seller_folder = f"{seller['id']}.{seller['name']}_@{seller['instagram']}"
    local_root = ROOT / "data" / "local_archive" / seller_folder
    if not local_root.exists():
        local_root.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.Popen(["explorer.exe", str(local_root)])
        return jsonify({"ok": True, "path": str(local_root)})
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


@app.route("/api/jobs/<job_id>", methods=["GET"])
def api_job_status(job_id: str):
    with JOB_LOCK:
        job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "작업 없음"}), 404
    return jsonify(job)


@app.route("/api/config", methods=["GET"])
def api_config_status():
    cfg = load_config()
    return jsonify({
        "config_exists": CONFIG_FILE.exists(),
        "gemini_set": bool(cfg.get("gemini", {}).get("api_key", "").strip())
                      and not cfg.get("gemini", {}).get("api_key", "").startswith("여기에"),
        "drive_credentials_present": (ROOT / cfg.get("google", {}).get("credentials_file", "credentials.json")).exists(),
    })


@app.route("/health")
def health():
    return {"ok": True, "time": datetime.now().isoformat(timespec="seconds")}


# ─── BACKUP STATUS ────────────────────────────────────────
@app.route("/api/backup_status", methods=["GET"])
def api_backup_status():
    """현재 백업 폴더 위치 + 마지막 백업 시각 반환."""
    candidates = [
        Path("H:/내 드라이브/넥스트포트/공구/백업"),
        Path("G:/내 드라이브/넥스트포트/공구/백업"),
        Path.home() / "Desktop" / "공구" / "백업",
    ]
    base = None
    for c in candidates:
        if c.exists():
            base = c
            break
    if not base:
        return jsonify({
            "connected": False,
            "path": None,
            "last_backup": None,
            "message": "백업 폴더 없음",
        })

    latest_manifest = base / "최신" / "manifest.json"
    last_at = None
    file_count = 0
    if latest_manifest.exists():
        try:
            d = json.loads(latest_manifest.read_text(encoding="utf-8"))
            last_at = d.get("timestamp")
            file_count = d.get("ok", 0)
        except Exception:
            pass

    # 히스토리 개수
    history = base / "히스토리"
    history_count = 0
    if history.exists():
        history_count = sum(1 for _ in history.iterdir() if _.is_dir())

    is_gdrive = "내 드라이브" in str(base)
    return jsonify({
        "connected": True,
        "path": str(base),
        "is_gdrive": is_gdrive,
        "last_backup": last_at,
        "file_count": file_count,
        "history_count": history_count,
        "label": "Google Drive 동기화" if is_gdrive else "로컬 백업",
    })


@app.route("/api/backup_status/open", methods=["POST"])
def api_backup_open():
    """백업 폴더를 탐색기로 열기."""
    import subprocess
    candidates = [
        Path("H:/내 드라이브/넥스트포트/공구/백업"),
        Path("G:/내 드라이브/넥스트포트/공구/백업"),
        Path.home() / "Desktop" / "공구" / "백업",
    ]
    base = next((c for c in candidates if c.exists()), None)
    if not base:
        return jsonify({"error": "백업 폴더 없음"}), 404
    try:
        subprocess.Popen(["explorer.exe", str(base)])
        return jsonify({"ok": True, "path": str(base)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/backup/run", methods=["POST"])
def api_backup_run():
    """수동 백업 트리거."""
    import subprocess
    try:
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "backup.py")],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace",
        )
        return jsonify({
            "ok": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── DASHBOARD (정산 + 매출 통합 뷰) ──────────────────────
@app.route("/api/dashboard", methods=["GET"])
def api_dashboard():
    """캠페인별 정산/매출 요약 + 자동 계산."""
    rows = []
    for c in load_campaigns():
        fi = c.get("financials") or {}
        st = c.get("settlement") or {}

        revenue = float(fi.get("revenue") or 0)
        seller_fee = float(fi.get("seller_fee") or 0)
        pg_fee = float(fi.get("pg_fee") or 0)
        event_cost = float(fi.get("event_cost") or 0)
        cost = float(fi.get("cost") or 0)
        shipping = float(fi.get("shipping") or 0)
        vat = float(fi.get("vat") or 0)
        total_cost = seller_fee + pg_fee + event_cost + cost + shipping + vat
        profit = revenue - total_cost
        rate = (profit / revenue * 100) if revenue > 0 else 0

        rows.append({
            "id": c["id"],
            "label": f"{c.get('seller_name','')} ({c.get('round',1)}차)",
            "seller_name": c.get("seller_name", ""),
            "seller_real_name": c.get("seller_real_name", ""),
            "owner": c.get("owner", ""),
            "brand": c.get("brand", ""),
            "product": c.get("product", ""),
            "round": c.get("round", 1),
            "live_start": c.get("live_start", ""),
            "live_end": c.get("live_end", ""),
            "open_kind": c.get("open_kind", ""),
            "status": c.get("status", ""),
            "settlement": st,
            "financials": fi,
            "calc": {
                "total_cost": total_cost,
                "contribution_profit": profit,
                "contribution_rate": round(rate, 2),
            },
        })
    # 시작일 순 정렬
    rows.sort(key=lambda r: r.get("live_start") or "9999-99-99")
    # 합계 (완료 건만)
    completed = [r for r in rows if r["status"] == "완료"]
    sum_rev = sum(float((r["financials"] or {}).get("revenue") or 0) for r in completed)
    sum_profit = sum(r["calc"]["contribution_profit"] for r in completed)
    return jsonify({
        "campaigns": rows,
        "totals": {
            "completed_count": len(completed),
            "total_revenue": sum_rev,
            "total_profit": sum_profit,
            "avg_rate": round(sum_profit / sum_rev * 100, 2) if sum_rev > 0 else 0,
        },
    })


# ─── HOLIDAYS (한국 공휴일) ────────────────────────────────
HOLIDAYS = {
    "2026-01-01": "신정",
    "2026-02-16": "설날",
    "2026-02-17": "설날",
    "2026-02-18": "설날",
    "2026-03-01": "삼일절",
    "2026-03-02": "삼일절 대체",
    "2026-05-05": "어린이날",
    "2026-05-24": "석가탄신일",
    "2026-05-25": "대체 휴일",
    "2026-06-03": "지방선거일",
    "2026-06-06": "현충일",
    "2026-08-15": "광복절",
    "2026-08-17": "광복절 대체",
    "2026-09-24": "추석",
    "2026-09-25": "추석",
    "2026-09-26": "추석",
    "2026-10-03": "개천절",
    "2026-10-05": "개천절 대체",
    "2026-10-09": "한글날",
    "2026-12-25": "성탄절",
}


@app.route("/api/holidays", methods=["GET"])
def api_holidays():
    return jsonify({"holidays": HOLIDAYS})


# ─── SELLER PUBLIC PAGE (모바일 친화 플레이북) ────────────
@app.route("/s/<token>")
def seller_page(token: str):
    """셀러용 공개 페이지. 토큰만 알면 접근."""
    return render_template("seller_page.html", token=token)


# ─── CLOUDFLARE TUNNEL (셀러 공개 모드) ────────────────────
TUNNEL_STATE = {
    "process": None,
    "url": None,
    "log": [],
    "started_at": None,
}
TUNNEL_LOCK = threading.Lock()
TUNNEL_EXE = ROOT / "cloudflared.exe"


def _tunnel_url_save(url: str | None):
    p = DATA_DIR / "tunnel.json"
    if url:
        p.write_text(json.dumps({"url": url, "saved_at": datetime.now().isoformat(timespec="seconds")},
                                ensure_ascii=False, indent=2), encoding="utf-8")
    elif p.exists():
        p.unlink()


def _tunnel_url_load() -> str | None:
    p = DATA_DIR / "tunnel.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("url")
    except Exception:
        return None


def _start_tunnel():
    import re
    import subprocess

    with TUNNEL_LOCK:
        if TUNNEL_STATE["process"] and TUNNEL_STATE["process"].poll() is None:
            return  # 이미 실행 중
        if not TUNNEL_EXE.exists():
            TUNNEL_STATE["log"].append(f"[ERR] cloudflared.exe 없음: {TUNNEL_EXE}")
            return

        TUNNEL_STATE["log"] = ["[INFO] cloudflared 시작 중..."]
        TUNNEL_STATE["url"] = None
        TUNNEL_STATE["started_at"] = datetime.now().isoformat(timespec="seconds")

        proc = subprocess.Popen(
            [str(TUNNEL_EXE), "tunnel", "--url", "http://localhost:5000",
             "--no-autoupdate"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
        TUNNEL_STATE["process"] = proc

    URL_RE = re.compile(r"(https?://[a-z0-9-]+\.trycloudflare\.com)")

    def read_output():
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                TUNNEL_STATE["log"].append(line)
                if len(TUNNEL_STATE["log"]) > 200:
                    TUNNEL_STATE["log"] = TUNNEL_STATE["log"][-200:]
                m = URL_RE.search(line)
                if m and not TUNNEL_STATE["url"]:
                    TUNNEL_STATE["url"] = m.group(1)
                    _tunnel_url_save(TUNNEL_STATE["url"])
                    log.info(f"Cloudflare Tunnel: {TUNNEL_STATE['url']}")
        TUNNEL_STATE["log"].append("[INFO] cloudflared 종료됨")

    threading.Thread(target=read_output, daemon=True).start()


def _stop_tunnel():
    with TUNNEL_LOCK:
        p = TUNNEL_STATE.get("process")
        if p and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        TUNNEL_STATE["process"] = None
        TUNNEL_STATE["url"] = None
        _tunnel_url_save(None)


@app.route("/api/tunnel/status", methods=["GET"])
def api_tunnel_status():
    p = TUNNEL_STATE.get("process")
    running = bool(p and p.poll() is None)
    url = TUNNEL_STATE.get("url") or _tunnel_url_load()
    return jsonify({
        "running": running,
        "url": url,
        "installed": TUNNEL_EXE.exists(),
        "started_at": TUNNEL_STATE.get("started_at"),
        "log_tail": TUNNEL_STATE["log"][-15:],
    })


@app.route("/api/tunnel/start", methods=["POST"])
def api_tunnel_start():
    if not TUNNEL_EXE.exists():
        return jsonify({"error": "cloudflared.exe 없음. 프로젝트 폴더에 다운로드 필요."}), 500
    _start_tunnel()
    # URL 생성까지 약간 대기
    import time
    for _ in range(20):
        if TUNNEL_STATE["url"]:
            break
        time.sleep(0.5)
    return jsonify({
        "running": True,
        "url": TUNNEL_STATE.get("url"),
        "started_at": TUNNEL_STATE.get("started_at"),
    })


@app.route("/api/tunnel/stop", methods=["POST"])
def api_tunnel_stop():
    _stop_tunnel()
    return jsonify({"running": False})


# ─── 셀러 아카이브 이미지 추천 ────────────────────────────
@app.route("/api/campaigns/<cid>/recommend_images", methods=["POST"])
def api_recommend_images(cid: str):
    """캠페인의 daily_schedule 각 STORY 슬롯에 어울리는 이미지를 셀러 아카이브에서 자동 추천.

    Gemini가 태깅한 story_slot_fit 점수 기반:
      slot 1 → STORY1_일상노출
      slot 2 → STORY2_고객반응
      slot 3 → STORY3_비포애프터
      slot 4 → STORY4_효능증명
      slot 5 → STORY5_공유어필
    """
    items = load_campaigns()
    c = next((x for x in items if x["id"] == cid), None)
    if not c:
        return jsonify({"error": "캠페인 없음"}), 404

    # 캠페인 셀러의 아카이브 manifest 찾기
    handle = c.get("seller_handle", "")
    seller = None
    for s in load_sellers():
        if s.get("instagram") == handle:
            seller = s
            break
    if not seller:
        return jsonify({"error": f"셀러 아카이브에 @{handle} 없음. 셀러 아카이브 탭에서 먼저 추가 + 업데이트 필요."}), 400

    seller_folder = f"{seller['id']}.{seller['name']}_@{seller['instagram']}"
    manifest_path = DATA_DIR / "local_archive" / seller_folder / "_manifest.json"
    if not manifest_path.exists():
        return jsonify({"error": f"@{handle} 의 manifest 없음. 셀러 아카이브 업데이트 먼저."}), 400

    try:
        mdata = json.loads(manifest_path.read_text(encoding="utf-8"))
        archive_items = mdata.get("items", [])
    except Exception as e:
        return jsonify({"error": f"manifest 읽기 실패: {e}"}), 500

    if not archive_items:
        return jsonify({"error": "아카이브 항목 없음"}), 400

    # 슬롯명 → 매니페스트의 story_slot_fit 키 매핑
    SLOT_KEY = {
        1: "STORY1_일상노출",
        2: "STORY2_고객반응",
        3: "STORY3_비포애프터",
        4: "STORY4_효능증명",
        5: "STORY5_공유어필",
    }

    # 슬롯별로 이미지 점수순 정렬 (이미 사용된 이미지는 제외)
    used = set()
    daily = c.get("daily_schedule", [])
    for d in daily:
        for s in (d.get("stories") or []):
            if s.get("image_url"):
                used.add(s["image_url"])

    matched_count = 0
    for d in daily:
        for s in d.get("stories") or []:
            if s.get("image_url"):
                continue  # 이미 있으면 건드리지 않음
            slot_no = s.get("slot", 1)
            key = SLOT_KEY.get(slot_no, "")
            if not key:
                continue
            # 후보 정렬 (점수 높은 순, 이미 사용된 거 제외)
            scored = []
            for it in archive_items:
                if not it.get("local_path"):
                    continue
                # 로컬 경로를 URL로 (정적 서빙 안 되어 있을 수도)
                local = it["local_path"]
                # 점수
                fit = (it.get("gemini") or {}).get("story_slot_fit") or {}
                score = fit.get(key, 0)
                if score <= 0:
                    continue
                # URL은 셀러 아카이브 폴더 경로
                if local in used:
                    continue
                scored.append((score, local))
            scored.sort(reverse=True)
            if scored:
                _score, path = scored[0]
                s["image_url"] = path  # 로컬 경로 (브라우저에서 직접 못 봐도 일단 채움)
                used.add(path)
                matched_count += 1

    c["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_campaigns(items)

    return jsonify({
        "ok": True,
        "matched": matched_count,
        "campaign": c,
        "message": f"{matched_count}개 슬롯에 이미지 자동 추천됨"
                   + ("" if matched_count else " — 아카이브 manifest에 story_slot_fit 태그 없음 (구버전). 셀러 아카이브 업데이트 시 자동 태깅됨."),
    })


# ─── GEMINI 자동 멘트 생성 ────────────────────────────────
@app.route("/api/campaigns/<cid>/generate_captions", methods=["POST"])
def api_generate_captions(cid: str):
    """한 일자의 STORY 슬롯 멘트 + 게시물 멘트를 Gemini로 자동 생성.

    컨텍스트:
      - 캠페인 (셀러 / 제품 / 브랜드 / 가이드라인 / 일정)
      - 제품 정보 (USP / 상세 / 가격 / 금지 멘트)
      - 셀러 톤 (셀러 아카이브에서 — 있으면)
      - 그 날의 stage (사전/라이브/사후) + day_label
    """
    items = load_campaigns()
    c = next((x for x in items if x["id"] == cid), None)
    if not c:
        return jsonify({"error": "캠페인 없음"}), 404

    payload = request.get_json(force=True) or {}
    day_index = payload.get("day_index")
    day = payload.get("day") or {}
    if day_index is None:
        return jsonify({"error": "day_index 필수"}), 400

    # 제품 정보 가져오기
    product = None
    for p in load_products():
        if c.get("product") and (c["product"] in p.get("name", "") or p.get("name", "") in c.get("product", "")):
            product = p
            break

    # 셀러 아카이브 톤 정보 (있으면)
    seller_archive_info = ""
    handle = c.get("seller_handle")
    if handle:
        for s in load_sellers():
            if s.get("instagram") == handle:
                seller_folder = f"{s['id']}.{s['name']}_@{s['instagram']}"
                manifest_path = DATA_DIR / "local_archive" / seller_folder / "_manifest.json"
                if manifest_path.exists():
                    try:
                        mdata = json.loads(manifest_path.read_text(encoding="utf-8"))
                        prof = mdata.get("profile", {})
                        seller_archive_info = f"\n셀러 인스타 바이오: {prof.get('header_text','')[:300]}\n"
                    except Exception:
                        pass
                break

    # 가이드라인 (캠페인 notes + 제품 정보 합성)
    stories = day.get("stories") or []
    feed = day.get("feed_post") or {}

    prompt = f"""너는 인플루언서 공동구매 마켓의 인스타 스토리/게시물 멘트를 작성하는 카피라이터야.
대화 톤: 한국어 캐주얼 반말. 광고 느낌 절대 X. 친구한테 말하듯 자연스럽게. 이모지 적절히.

[캠페인 정보]
- 셀러: {c.get('seller_name','')} ({c.get('round',1)}차)
- 셀러 인스타 핸들: @{c.get('seller_handle','')}
- 브랜드: {c.get('brand','')}
- 제품: {c.get('product','')}
- 마켓 시작일: {c.get('live_start','')} / 종료일: {c.get('live_end','')}
- 단계: {day.get('kind','')} ({day.get('day_label','')})
- 오늘 날짜: {day.get('date','')}

[제품 상세]
{('USP: ' + product['usp']) if product and product.get('usp') else ''}
{('상세: ' + product['detail']) if product and product.get('detail') else ''}
{('가격/혜택: ' + product['price']) if product and product.get('price') else ''}

[금지 멘트]
{(product.get('avoid','') if product else '광고 느낌 멘트 X / 효능 단정 X')}
{seller_archive_info}
[캠페인 가이드라인]
{c.get('notes','')}

[작성할 슬롯 ({len(stories)}개 STORY + 1개 게시물)]
"""
    for s in stories:
        prompt += f"\nSLOT {s.get('slot', '?')}: {s.get('label', '')}\n  (기존 멘트: {s.get('caption', '')[:80]})\n"
    if feed:
        prompt += f"\nFEED: {feed.get('label', '게시물')}\n  (기존 멘트: {feed.get('caption', '')[:80]})\n"

    prompt += """

각 슬롯에 어울리는 멘트를 작성해. 출력은 다음 JSON 형식으로 (이게 끝):

{
  "stories": [
    {"slot": 1, "label": "[적절한 라벨]", "caption": "셀러가 인스타에 그대로 올릴 멘트. 줄바꿈 자유."},
    ...
  ],
  "feed": {"label": "[게시물 라벨]", "caption": "게시물 멘트"}
}

규칙:
- caption은 인스타 스토리에 그대로 올릴 수 있게. 한 문장씩 줄바꿈 가능.
- 단계별 톤:
  · 사전(pre): 일상 + 호기심 유발. 제품 직접 언급 X 또는 살짝.
  · 라이브(live): 마켓 알림 + 구매 유도. 명확하게.
  · 사후(post): 감사 + 구매자 케어 + 다음 N차 기대.
- 슬롯 라벨도 자연스럽게 (예: "[아침 한 포 루틴]", "[고객 반응]", "[3일째 후기]")
- 금지 멘트 무조건 회피.
- JSON 외 다른 텍스트 X.
"""

    try:
        import google.generativeai as genai
        cfg = load_config()
        api_key = cfg.get("gemini", {}).get("api_key", "")
        if not api_key:
            return jsonify({"error": "Gemini API key 없음"}), 500
        genai.configure(api_key=api_key)
        model_name = cfg.get("gemini", {}).get("caption_model") or "gemini-2.5-flash"
        model = genai.GenerativeModel(model_name, generation_config={
            "response_mime_type": "application/json",
            "max_output_tokens": 4096,
            "temperature": 0.85,
        })
        resp = model.generate_content(prompt)
        text = (resp.text or "").strip()
        # JSON 파싱
        if text.startswith("```"):
            text = text.strip("`").lstrip("json").strip()
        result = json.loads(text)
    except Exception as e:  # noqa: BLE001
        log.exception("caption gen failed")
        return jsonify({"error": f"생성 실패: {e}"}), 500

    # day 객체에 적용
    gen_stories = result.get("stories", []) or []
    for i, s in enumerate(day.get("stories") or []):
        if i < len(gen_stories):
            g = gen_stories[i]
            if g.get("label"): s["label"] = g["label"]
            if g.get("caption"): s["caption"] = g["caption"]

    gen_feed = result.get("feed") or {}
    if day.get("feed_post"):
        if gen_feed.get("label"): day["feed_post"]["label"] = gen_feed["label"]
        if gen_feed.get("caption"): day["feed_post"]["caption"] = gen_feed["caption"]

    # 캠페인 저장
    if day_index < len(c.get("daily_schedule", [])):
        c["daily_schedule"][day_index] = day
    else:
        c.setdefault("daily_schedule", []).append(day)
    c["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_campaigns(items)

    return jsonify({"ok": True, "day": day})


# ─── 카톡 대화 분석 ────────────────────────────────────────
@app.route("/api/campaigns/<cid>/kakao_log", methods=["POST"])
def api_kakao_log(cid: str):
    items = load_campaigns()
    c = next((x for x in items if x["id"] == cid), None)
    if not c:
        return jsonify({"error": "캠페인 없음"}), 404
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "txt 파일 필수"}), 400
    try:
        raw = f.read().decode("utf-8", errors="replace")
    except Exception as e:
        return jsonify({"error": f"파일 읽기 실패: {e}"}), 500
    if len(raw) > 40000:
        raw = raw[-40000:]

    prompt = f"""너는 비즈니스 카톡 대화 분석가야.
캠페인: {c.get('seller_name','')} {c.get('round',1)}차 / {c.get('brand','')} {c.get('product','')}
라이브: {c.get('live_start','')} ~ {c.get('live_end','')}

[카톡 원문]
{raw}

다음 JSON 출력:
{{
  "summary": "핵심 5~8문장 한국어 요약",
  "decisions": ["..."],
  "action_items": [{{"who":"...","what":"...","when":"..."}}],
  "stage_signals": ["진행 단계 신호"],
  "concerns": ["우려사항"]
}}
JSON만 출력."""

    try:
        import google.generativeai as genai
        cfg = load_config()
        key = cfg.get("gemini", {}).get("api_key", "")
        if not key:
            return jsonify({"error": "Gemini API key 없음"}), 500
        genai.configure(api_key=key)
        model = genai.GenerativeModel(
            cfg.get("gemini", {}).get("model") or "gemini-2.5-flash",
            generation_config={"response_mime_type": "application/json", "max_output_tokens": 4096},
        )
        resp = model.generate_content(prompt)
        text = (resp.text or "").strip()
        if text.startswith("```"):
            text = text.strip("`").lstrip("json").strip()
        result = json.loads(text)
    except Exception as e:
        log.exception("kakao analyze failed")
        return jsonify({"error": f"분석 실패: {e}"}), 500

    logs = c.get("kakao_logs") or []
    logs.append({
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "filename": f.filename,
        "summary": result.get("summary", ""),
        "decisions": result.get("decisions", []),
        "action_items": result.get("action_items", []),
        "stage_signals": result.get("stage_signals", []),
        "concerns": result.get("concerns", []),
    })
    c["kakao_logs"] = logs
    c["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_campaigns(items)
    return jsonify({"ok": True, "summary": result.get("summary", ""), "log": logs[-1]})


# ─── GOOGLE SHEETS IMPORT (셀러 스케줄 자동 가져오기) ────
@app.route("/api/campaigns/<cid>/import_sheet", methods=["POST"])
def api_import_sheet(cid: str):
    """캠페인의 시트 URL에서 daily_schedule 자동 import.

    시트는 '링크가 있는 모든 사람이 볼 수 있음' 권한 필요.
    인식하는 컬럼 (한글/영문):
      - 날짜 / date
      - D-라벨 / day_label / D
      - 종류 / kind / type
      - 제목 / title
      - 부제 / subtitle
      - 메모 / notes
    """
    import re
    import urllib.request
    import csv as csv_mod
    from io import StringIO

    items = load_campaigns()
    c = next((x for x in items if x["id"] == cid), None)
    if not c:
        return jsonify({"error": "캠페인 없음"}), 404

    payload = request.get_json(silent=True) or {}
    sheet_url = (payload.get("sheet_url") or c.get("sheet_url") or "").strip()
    if not sheet_url:
        return jsonify({"error": "캠페인에 시트 URL이 없음. 먼저 시트 URL 박으세요."}), 400

    # 시트 ID + GID 추출
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", sheet_url)
    if not m:
        return jsonify({"error": "올바른 Google Sheets URL이 아님"}), 400
    sheet_id = m.group(1)
    gid_m = re.search(r"[#&?]gid=(\d+)", sheet_url)
    gid = gid_m.group(1) if gid_m else "0"

    # CSV export URL
    csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"

    try:
        req = urllib.request.Request(csv_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8")
    except Exception as e:
        return jsonify({
            "error": f"시트 가져오기 실패: {e}. 시트 공유 설정 확인 (링크 있는 사람 보기 가능).",
        }), 500

    # CSV 파싱
    reader = csv_mod.reader(StringIO(raw))
    rows = [row for row in reader]
    if len(rows) < 2:
        return jsonify({"error": "시트가 비어있음"}), 400

    # 시트 구조 자동 감지 — STORY 그리드형이 우선
    header_idx = None
    is_story_grid = False
    # 1단계: STORY 셀이 2개 이상인 행 (확실한 그리드형)
    for i, row in enumerate(rows[:20]):
        story_cells = sum(1 for c in row if "STORY" in (c or "").upper())
        if story_cells >= 2:
            header_idx = i
            is_story_grid = True
            break
    # 2단계: 단순 컬럼형 — 첫 셀이 정확히 "날짜"/"일자"/"date" 인 행
    if header_idx is None:
        for i, row in enumerate(rows[:15]):
            if not row:
                continue
            first = (row[0] or "").strip().lower()
            if first in ("날짜", "일자", "date"):
                header_idx = i
                break

    if header_idx is None:
        return jsonify({
            "error": "시트 헤더를 찾지 못함. STORY 1~5 같은 컬럼 또는 첫 컬럼에 '날짜' 헤더 필요.",
            "first_rows": [r[:5] for r in rows[:8]],
        }), 400

    # 캠페인 연도 추출 (날짜 파싱용)
    base_year = datetime.now().year
    if c.get("live_start"):
        try:
            base_year = int(c["live_start"][:4])
        except Exception:
            pass

    new_schedule = []

    if is_story_grid:
        # ── STORY 그리드형 (지나/양미라 시트 같은 양식) ──
        # header_idx: "날짜 / STORY 1 / STORY 2 / ... / 게시물 / 비고"
        headers = [(c or "").strip() for c in rows[header_idx]]
        # header_idx + 1 은 보통 슬롯별 가이드 (스킵)
        # header_idx + 2 부터 실제 날짜 행
        data_start = header_idx + 2

        # 한글 날짜 패턴: "4월 4일 (화)" / "4월 4일" / "4/4"
        import re as _re
        date_pat = _re.compile(r"(\d{1,2})\s*[월/]\s*(\d{1,2})")
        d_label_pat = _re.compile(r"(D[-+]?\d+|D[-]?Day|디데이)", _re.IGNORECASE)

        for row in rows[data_start:]:
            if not row or not any((c or "").strip() for c in row):
                continue
            date_cell = (row[0] if len(row) > 0 else "").strip()
            if not date_cell:
                continue

            # 날짜 추출
            m = date_pat.search(date_cell)
            if not m:
                continue
            month_n = int(m.group(1))
            day_n = int(m.group(2))
            date_str = f"{base_year}-{month_n:02d}-{day_n:02d}"

            # D-라벨 추출
            dl_m = d_label_pat.search(date_cell)
            day_label = dl_m.group(0) if dl_m else ""

            # STORY 1~5 + 게시물 + 비고 추출
            slot_parts = []
            for col_i in range(1, min(len(row), len(headers))):
                col_header = headers[col_i].strip()
                val = (row[col_i] or "").strip()
                if not val:
                    continue
                slot_parts.append(f"[{col_header}]\n{val}")

            # 카드 제목 = "이 날 할 일" 또는 첫 STORY 첫 줄
            first_line = ""
            if slot_parts:
                # 첫 STORY 내용 첫 줄 (라벨 줄 빼고)
                first_content = slot_parts[0].split("\n", 1)
                if len(first_content) > 1:
                    first_line = first_content[1].split("\n")[0]

            new_schedule.append({
                "date": date_str,
                "day_label": day_label,
                "kind": "content",
                "title": first_line[:60] if first_line else f"{month_n}월 {day_n}일 콘텐츠",
                "subtitle": f"STORY {len([s for s in slot_parts if s.startswith('[STORY')])}개 + 게시물 + 비고",
                "notes": "\n\n".join(slot_parts),
                "is_new": False,
            })
    else:
        # ── 단순 컬럼형 (기존 generic 파서) ──
        headers = [h.strip().lower() for h in rows[header_idx]]

        def find_col(*candidates):
            for cand in candidates:
                for i, h in enumerate(headers):
                    if cand in h:
                        return i
            return -1

        col_date = find_col("날짜", "일자", "date")
        col_label = find_col("d-라벨", "d-label", "라벨", "day_label", "차수일", "디데이", "d-")
        col_kind = find_col("종류", "구분", "kind", "type", "분류")
        col_title = find_col("제목", "타이틀", "title", "할일", "액션", "내용")
        col_sub = find_col("부제", "subtitle", "설명", "desc")
        col_notes = find_col("메모", "notes", "비고")

        kind_map = {
            "사전": "pre", "발송": "shipment", "콘텐츠": "content",
            "라이브": "live", "사후": "post", "기타": "other",
        }

        for row in rows[header_idx + 1:]:
            def cell(i):
                if i < 0 or i >= len(row):
                    return ""
                return (row[i] or "").strip()
            date_str = cell(col_date)
            if date_str:
                date_str = date_str.replace(".", "-").replace("/", "-").replace(" ", "")
                parts = date_str.split("-")
                if len(parts) == 3 and all(p.isdigit() for p in parts):
                    date_str = f"{parts[0]}-{int(parts[1]):02d}-{int(parts[2]):02d}"
            title = cell(col_title)
            if not date_str and not title:
                continue
            kind_raw = cell(col_kind).lower()
            new_schedule.append({
                "date": date_str,
                "day_label": cell(col_label),
                "kind": kind_map.get(kind_raw, "other"),
                "title": title,
                "subtitle": cell(col_sub),
                "notes": cell(col_notes),
                "is_new": False,
            })

    if not new_schedule:
        return jsonify({"error": "유효한 데이터 행이 없음", "headers_found": rows[header_idx] if header_idx is not None else []}), 400

    c["daily_schedule"] = new_schedule
    c["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_campaigns(items)

    return jsonify({
        "ok": True,
        "imported": len(new_schedule),
        "campaign": c,
        "headers_found": headers,
    })


@app.route("/api/seller/<token>", methods=["GET"])
def api_seller_data(token: str):
    """토큰 또는 slug로 캠페인 조회."""
    campaigns = load_campaigns()
    c = next((x for x in campaigns
              if x.get("seller_token") == token or x.get("seller_slug") == token), None)
    if not c:
        return jsonify({"error": "유효하지 않은 링크"}), 404

    # 브랜드 정보
    brand = None
    if c.get("brand_id"):
        brand = next((b for b in load_brands() if b["id"] == c["brand_id"]), None)
    # 제품 정보 (브랜드 매칭)
    product = None
    for p in load_products():
        if p.get("name") and (c.get("product") in p["name"] or p["name"] in c.get("product", "")):
            product = p
            break

    # D-N 계산
    from datetime import date
    today = datetime.now().date()
    d_label = "—"
    if c.get("live_start"):
        try:
            ls = datetime.strptime(c["live_start"], "%Y-%m-%d").date()
            le = datetime.strptime(c["live_end"], "%Y-%m-%d").date() if c.get("live_end") else None
            if today < ls:
                days = (ls - today).days
                d_label = f"D-{days}"
            elif le and today > le:
                d_label = "종료"
            else:
                d_label = "라이브 중 🔴"
        except ValueError:
            pass

    # 같은 셀러의 다른 차수들 (N차 스위치용) — slug 우선, fallback token
    same_seller = [
        {"id": x["id"], "round": x.get("round", 1),
         "token": x.get("seller_slug") or x.get("seller_token", ""),
         "status": x.get("status", ""), "live_start": x.get("live_start", "")}
        for x in campaigns
        if x.get("seller_name") == c.get("seller_name") and x.get("brand_id") == c.get("brand_id")
    ]
    same_seller.sort(key=lambda x: x.get("round") or 0)

    # 이 캠페인 관련 이벤트 (캘린더 직접 추가 + 캠페인 파생)
    related_events = []
    for ev in load_events():
        if ev.get("ref_id") == c["id"] or ev.get("ref_kind") == "":
            # 무관한 이벤트는 제외 (ref_id가 이 캠페인 또는 아예 비어있고 날짜가 라이브 기간 근처)
            if ev.get("ref_id") == c["id"]:
                related_events.append(ev)
    # 캠페인 자체에서 파생되는 이벤트
    derived = _derive_campaign_events(c)
    # 발송일/라이브 시작/종료가 의미있음 — 합치기
    for ev in derived:
        related_events.append(ev)
    related_events.sort(key=lambda x: x.get("date", ""))

    # 정산 자동 계산
    fi = c.get("financials") or {}
    revenue = float(fi.get("revenue") or 0)
    costs = {
        "seller_fee": float(fi.get("seller_fee") or 0),
        "pg_fee": float(fi.get("pg_fee") or 0),
        "event_cost": float(fi.get("event_cost") or 0),
        "cost": float(fi.get("cost") or 0),
        "shipping": float(fi.get("shipping") or 0),
        "vat": float(fi.get("vat") or 0),
    }
    total_cost = sum(costs.values())
    profit = revenue - total_cost
    rate = (profit / revenue * 100) if revenue > 0 else 0

    return jsonify({
        "campaign": {
            "id": c["id"],
            "seller_name": c.get("seller_name", ""),
            "seller_real_name": c.get("seller_real_name", ""),
            "round": c.get("round", 1),
            "brand": c.get("brand", ""),
            "product": c.get("product", ""),
            "live_start": c.get("live_start", ""),
            "live_end": c.get("live_end", ""),
            "open_kind": c.get("open_kind", ""),
            "stage": c.get("stage", ""),
            "stage_label": STAGE_LABEL.get(c.get("stage", ""), c.get("stage", "")),
            "status": c.get("status", ""),
            "notes": c.get("notes", ""),
            "sheet_url": c.get("sheet_url", ""),
            "daily_schedule": c.get("daily_schedule") or [],
            "faq": c.get("faq") or [],
            "d_label": d_label,
            "shipment": c.get("shipment") or {"qty": 0, "date": ""},
            "settlement": c.get("settlement") or {},
        },
        "brand": brand,
        "product": product,
        "other_rounds": same_seller,
        "events": related_events,
        "financials": {
            "revenue": revenue,
            "costs": costs,
            "total_cost": total_cost,
            "profit": profit,
            "rate": round(rate, 2),
            "has_data": revenue > 0,
        },
    })


# ─── PRODUCTS ─────────────────────────────────────────────
PRODUCTS_FILE = DATA_DIR / "products.json"


def load_products() -> list[dict[str, Any]]:
    if not PRODUCTS_FILE.exists():
        return []
    raw = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    return raw.get("products", [])


def save_products(products: list[dict[str, Any]]) -> None:
    PRODUCTS_FILE.write_text(
        json.dumps({"products": products}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


@app.route("/api/products", methods=["GET"])
def api_products_list():
    return jsonify({"products": load_products()})


@app.route("/api/products", methods=["POST"])
def api_products_add():
    payload = request.get_json(force=True)
    products = load_products()
    new_id = f"p{len(products) + 1:03d}"
    new = {
        "id": new_id,
        "name": payload.get("name", "").strip(),
        "usp": payload.get("usp", "").strip(),
        "detail": payload.get("detail", "").strip(),
        "price": payload.get("price", "").strip(),
        "avoid": payload.get("avoid", "").strip(),
    }
    if not new["name"]:
        return jsonify({"error": "name 필수"}), 400
    products.append(new)
    save_products(products)
    return jsonify({"product": new})


@app.route("/api/products/<pid>", methods=["PATCH"])
def api_products_patch(pid: str):
    payload = request.get_json(force=True)
    products = load_products()
    p = next((x for x in products if x["id"] == pid), None)
    if not p:
        return jsonify({"error": "not found"}), 404
    for k in ("name", "usp", "detail", "price", "avoid"):
        if k in payload:
            p[k] = (payload[k] or "").strip()
    save_products(products)
    return jsonify({"product": p})


@app.route("/api/products/<pid>", methods=["DELETE"])
def api_products_delete(pid: str):
    products = [x for x in load_products() if x["id"] != pid]
    save_products(products)
    return jsonify({"ok": True})


# ─── SCHEDULE GENERATOR ───────────────────────────────────
@app.route("/api/schedule/generate", methods=["POST"])
def api_schedule_generate():
    payload = request.get_json(force=True)
    job_id = uuid.uuid4().hex[:12]
    with JOB_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "kind": "schedule",
            "status": "running",
            "progress": 0, "total": 10,
            "message": "스케줄 생성 시작…",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "errors": [],
            "result_url": None,
        }

    def run():
        try:
            from schedule_gen import generate_schedule
            cfg = load_config()
            result = generate_schedule(payload, cfg, on_progress=lambda **kw: update_job(job_id, **kw))
            if result.get("error"):
                update_job(job_id, status="error", message=result["error"], finished_at=datetime.now().isoformat(timespec="seconds"))
                return
            update_job(
                job_id,
                status="done",
                message=f"완료! {result.get('rows_count', 0)}일 × {result.get('slots_per_row', 0)}슬롯",
                result_url=result.get("result_url"),
                finished_at=datetime.now().isoformat(timespec="seconds"),
            )
        except Exception as e:  # noqa: BLE001
            log.exception("Schedule gen failed")
            update_job(job_id, status="error", message=f"에러: {e}", finished_at=datetime.now().isoformat(timespec="seconds"))

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/generated/<path:filename>")
def serve_generated(filename: str):
    return send_from_directory(DATA_DIR / "generated", filename)


# ─── CAMPAIGNS (셀러 캠페인) ──────────────────────────────
CAMPAIGNS_FILE = DATA_DIR / "campaigns.json"
MEETINGS_FILE = DATA_DIR / "meetings.json"
EVENTS_FILE = DATA_DIR / "events.json"
BRANDS_FILE = DATA_DIR / "brands.json"
MEETINGS_DIR = DATA_DIR / "meetings"
MEETINGS_DIR.mkdir(exist_ok=True)

# Google Drive 동기화 폴더 (자동 이관 위치)
DRIVE_MEETING_DIRS = [
    Path("H:/내 드라이브/넥스트포트/공구/녹취"),
    Path("G:/내 드라이브/넥스트포트/공구/녹취"),
]


def _find_drive_meeting_dir() -> Path | None:
    """녹취 자동 이관 가능한 Drive 폴더 찾기."""
    for d in DRIVE_MEETING_DIRS:
        if d.exists() or d.parent.exists():
            d.mkdir(parents=True, exist_ok=True)
            return d
    return None


def _safe_filename(s: str, fallback: str = "untitled") -> str:
    """파일명에 못 쓰는 글자 제거 + 공백 → _."""
    import re
    s = (s or "").strip()
    if not s:
        return fallback
    # Windows 금지 문자 + 제어 문자 제거
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s)
    s = re.sub(r"\s+", "_", s)
    # 양옆 ., _ 제거
    s = s.strip("._")
    return s[:60] or fallback


STAGE_ORDER = [
    "contact",           # 컨택
    "confirmed",         # 셀러 컨펌
    "shipped",           # 제품 발송
    "received",          # 수령 확인
    "sheet_drafted",     # 시트 작성
    "sheet_confirmed",   # 시트 컨펌
    "live",              # 라이브 중
    "complete",          # 종료/정산
]
STAGE_LABEL = {
    "contact": "컨택",
    "confirmed": "셀러 컨펌",
    "shipped": "제품 발송",
    "received": "수령 확인",
    "sheet_drafted": "시트 작성",
    "sheet_confirmed": "시트 컨펌",
    "live": "라이브",
    "complete": "완료",
}


def _read_json(path: Path, key: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    return raw.get(key, [])


def _write_json(path: Path, key: str, items: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps({key: items}, ensure_ascii=False, indent=2), encoding="utf-8")


def _next_id(items: list[dict[str, Any]], prefix: str) -> str:
    nums = []
    for it in items:
        s = str(it.get("id", ""))
        if s.startswith(prefix):
            try:
                nums.append(int(s[len(prefix):]))
            except ValueError:
                pass
    n = (max(nums) if nums else 0) + 1
    return f"{prefix}{n:03d}"


def load_campaigns() -> list[dict[str, Any]]:
    return _read_json(CAMPAIGNS_FILE, "campaigns")


def save_campaigns(items: list[dict[str, Any]]) -> None:
    _write_json(CAMPAIGNS_FILE, "campaigns", items)


def load_meetings() -> list[dict[str, Any]]:
    return _read_json(MEETINGS_FILE, "meetings")


def save_meetings(items: list[dict[str, Any]]) -> None:
    _write_json(MEETINGS_FILE, "meetings", items)


def load_events() -> list[dict[str, Any]]:
    return _read_json(EVENTS_FILE, "events")


def save_events(items: list[dict[str, Any]]) -> None:
    _write_json(EVENTS_FILE, "events", items)


CAMPAIGN_FIELDS = (
    "seller_name", "seller_handle", "seller_real_name", "owner",
    "brand", "brand_id", "product", "round",
    "contact_type", "stage", "live_start", "live_end", "open_kind",
    "sheet_url", "status", "notes", "seller_slug",
    "daily_schedule", "faq",
    "reels", "banner", "plan", "kakao_logs",
)


SELLER_SLUG_MAP = {
    "지나": "jina", "양미라": "yangmira", "한연아": "hanyeona",
    "윰니": "yumni", "김희연": "kimheeyeon", "오늘희": "onulhui", "느루": "neuru",
    "야곰": "yagom", "박예은": "parkyeeun", "이지비메": "easydiet",
}


def _make_slug(seller_name: str, seller_handle: str, round_no: int, fallback: str) -> str:
    """캠페인 slug 자동 생성."""
    import re
    base = SELLER_SLUG_MAP.get((seller_name or "").strip())
    if not base and seller_handle:
        base = re.sub(r"[^a-zA-Z0-9_]", "", seller_handle).lower()
    if not base:
        base = fallback
    return f"{base}-{round_no}"


def load_brands() -> list[dict[str, Any]]:
    return _read_json(BRANDS_FILE, "brands")


def save_brands(items: list[dict[str, Any]]) -> None:
    _write_json(BRANDS_FILE, "brands", items)


def _brand_id_from_name(brand_name: str) -> str:
    """기존 brand 텍스트 → brand_id 추정 (마이그레이션용)."""
    if not brand_name:
        return ""
    for b in load_brands():
        if b["name"] == brand_name or b["id"] == brand_name:
            return b["id"]
    return ""


@app.route("/api/brands", methods=["GET"])
def api_brands_list():
    items = load_brands()
    # 캠페인 개수 카운트
    camps = load_campaigns()
    for b in items:
        bid = b["id"]
        b["campaign_count"] = sum(
            1 for c in camps if c.get("brand_id") == bid or _brand_id_from_name(c.get("brand", "")) == bid
        )
    return jsonify({"brands": items})


@app.route("/api/brands", methods=["POST"])
def api_brands_add():
    payload = request.get_json(force=True)
    items = load_brands()
    import re
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name 필수"}), 400
    # id 자동 생성 — 영문/숫자만 + 짧게
    bid = payload.get("id") or re.sub(r"[^a-zA-Z0-9]", "", name.lower()) or f"b{len(items)+1}"
    if any(b["id"] == bid for b in items):
        bid = f"{bid}_{len(items)+1}"
    new = {
        "id": bid,
        "name": name,
        "category": (payload.get("category") or "").strip(),
        "color": (payload.get("color") or "#888").strip(),
        "emoji": (payload.get("emoji") or "🏷️").strip(),
        "active": payload.get("active", True),
        "notes": (payload.get("notes") or "").strip(),
    }
    items.append(new)
    save_brands(items)
    return jsonify({"brand": new})


@app.route("/api/brands/<bid>", methods=["PATCH"])
def api_brands_patch(bid: str):
    payload = request.get_json(force=True)
    items = load_brands()
    b = next((x for x in items if x["id"] == bid), None)
    if not b:
        return jsonify({"error": "not found"}), 404
    for k in ("name", "category", "color", "emoji", "active", "notes"):
        if k in payload:
            v = payload[k]
            if isinstance(v, str):
                v = v.strip()
            b[k] = v
    save_brands(items)
    return jsonify({"brand": b})


@app.route("/api/brands/<bid>", methods=["DELETE"])
def api_brands_delete(bid: str):
    items = [b for b in load_brands() if b["id"] != bid]
    save_brands(items)
    return jsonify({"ok": True})


@app.route("/api/campaigns", methods=["GET"])
def api_campaigns_list():
    return jsonify({"campaigns": load_campaigns()})


@app.route("/api/campaigns", methods=["POST"])
def api_campaigns_add():
    payload = request.get_json(force=True)
    items = load_campaigns()
    now = datetime.now().isoformat(timespec="seconds")
    brand_str = (payload.get("brand") or "").strip()
    brand_id = (payload.get("brand_id") or "").strip() or _brand_id_from_name(brand_str)
    # brand_id 있으면 brand 이름은 마스터에서 가져옴
    if brand_id:
        b = next((x for x in load_brands() if x["id"] == brand_id), None)
        if b:
            brand_str = b["name"]
    new = {
        "id": _next_id(items, "c"),
        "seller_name": (payload.get("seller_name") or "").strip(),
        "seller_handle": (payload.get("seller_handle") or "").strip().lstrip("@"),
        "brand": brand_str,
        "brand_id": brand_id,
        "product": (payload.get("product") or "").strip(),
        "round": int(payload.get("round") or 1),
        "contact_type": payload.get("contact_type") or "direct",
        "stage": payload.get("stage") or "contact",
        "live_start": payload.get("live_start") or "",
        "live_end": payload.get("live_end") or "",
        "shipment": payload.get("shipment") or {"qty": 0, "date": ""},
        "sheet_url": (payload.get("sheet_url") or "").strip(),
        "status": payload.get("status") or "예정",
        "notes": (payload.get("notes") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    if not new["seller_name"]:
        return jsonify({"error": "seller_name 필수"}), 400
    # seller_token + slug 자동 생성
    import secrets
    new["seller_token"] = secrets.token_urlsafe(8).replace("-", "a").replace("_", "b")[:10]
    explicit_slug = (payload.get("seller_slug") or "").strip()
    base_slug = explicit_slug or _make_slug(new["seller_name"], new["seller_handle"], new["round"], new["id"])
    # 중복 회피
    existing = {c.get("seller_slug") for c in items}
    slug = base_slug
    i = 2
    while slug in existing:
        slug = f"{base_slug}-{i}"
        i += 1
    new["seller_slug"] = slug
    items.append(new)
    save_campaigns(items)
    return jsonify({"campaign": new})


@app.route("/api/campaigns/<cid>", methods=["PATCH"])
def api_campaigns_patch(cid: str):
    payload = request.get_json(force=True)
    items = load_campaigns()
    c = next((x for x in items if x["id"] == cid), None)
    if not c:
        return jsonify({"error": "not found"}), 404
    for k in CAMPAIGN_FIELDS:
        if k in payload:
            v = payload[k]
            if k == "round":
                v = int(v or 1)
            elif isinstance(v, str):
                v = v.strip()
                if k == "seller_handle":
                    v = v.lstrip("@")
            c[k] = v
    if "shipment" in payload:
        sh = payload["shipment"] or {}
        c["shipment"] = {
            "qty": int(sh.get("qty") or 0),
            "date": (sh.get("date") or "").strip(),
        }
    if "daily_schedule" in payload:
        c["daily_schedule"] = payload["daily_schedule"] or []
    if "faq" in payload:
        c["faq"] = payload["faq"] or []
    for asset_field in ("reels", "banner", "plan"):
        if asset_field in payload:
            v = payload[asset_field] or {}
            c[asset_field] = {
                "stage": (v.get("stage") or "").strip() if isinstance(v.get("stage"), str) else str(v.get("stage") or ""),
                "notes": (v.get("notes") or "").strip() if isinstance(v.get("notes"), str) else str(v.get("notes") or ""),
            }
    if "settlement" in payload:
        st = payload["settlement"] or {}
        c["settlement"] = {
            "rs_percent": float(st.get("rs_percent") or 0) if st.get("rs_percent") not in (None, "") else None,
            "type": (st.get("type") or "").strip(),
            "pg_logistics": (st.get("pg_logistics") or "").strip(),
            "completed_date": (st.get("completed_date") or "").strip(),
            "base_date": (st.get("base_date") or "").strip(),
        }
    if "financials" in payload:
        fi = payload["financials"] or {}
        # 숫자 필드만 받아서 깔끔히 저장
        cleaned = {}
        for k in ("revenue", "seller_fee", "pg_fee", "event_cost", "cost", "shipping", "vat"):
            v = fi.get(k)
            if v in (None, ""):
                continue
            try:
                cleaned[k] = float(v)
            except (TypeError, ValueError):
                pass
        c["financials"] = cleaned
    c["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_campaigns(items)
    return jsonify({"campaign": c})


@app.route("/api/campaigns/<cid>", methods=["DELETE"])
def api_campaigns_delete(cid: str):
    items = [c for c in load_campaigns() if c["id"] != cid]
    save_campaigns(items)
    return jsonify({"ok": True})


# ─── EVENTS (캘린더 직접 추가 이벤트) ─────────────────────
EVENT_FIELDS = ("date", "time", "kind", "title", "ref_id", "ref_kind", "color", "notes")
EVENT_KINDS = ("meeting", "shipment", "live_start", "live_end", "deadline", "other")


@app.route("/api/events", methods=["GET"])
def api_events_list():
    return jsonify({"events": load_events()})


@app.route("/api/events", methods=["POST"])
def api_events_add():
    payload = request.get_json(force=True)
    items = load_events()
    new = {
        "id": _next_id(items, "e"),
        "date": (payload.get("date") or "").strip(),
        "time": (payload.get("time") or "").strip(),
        "kind": payload.get("kind") or "other",
        "title": (payload.get("title") or "").strip(),
        "ref_id": payload.get("ref_id") or "",
        "ref_kind": payload.get("ref_kind") or "",
        "color": payload.get("color") or "",
        "notes": (payload.get("notes") or "").strip(),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    if not new["date"] or not new["title"]:
        return jsonify({"error": "date 와 title 필수"}), 400
    items.append(new)
    save_events(items)
    return jsonify({"event": new})


@app.route("/api/events/<eid>", methods=["PATCH"])
def api_events_patch(eid: str):
    payload = request.get_json(force=True)
    items = load_events()
    e = next((x for x in items if x["id"] == eid), None)
    if not e:
        return jsonify({"error": "not found"}), 404
    for k in EVENT_FIELDS:
        if k in payload:
            v = payload[k]
            if isinstance(v, str):
                v = v.strip()
            e[k] = v
    save_events(items)
    return jsonify({"event": e})


@app.route("/api/events/<eid>", methods=["DELETE"])
def api_events_delete(eid: str):
    items = [x for x in load_events() if x["id"] != eid]
    save_events(items)
    return jsonify({"ok": True})


# ─── CALENDAR (캠페인 + 미팅 + events 합쳐서 반환) ────────
def _derive_campaign_events(campaign: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    seller = campaign.get("seller_name", "")
    rd = campaign.get("round", 1)
    cid = campaign.get("id", "")
    # 라이브 시작
    if campaign.get("live_start"):
        out.append({
            "id": f"{cid}.live_start",
            "date": campaign["live_start"],
            "time": "",
            "kind": "live_start",
            "title": f"🔴 {seller} {rd}차 라이브 시작",
            "ref_id": cid, "ref_kind": "campaign",
            "auto": True,
        })
    # 라이브 종료
    if campaign.get("live_end"):
        out.append({
            "id": f"{cid}.live_end",
            "date": campaign["live_end"],
            "time": "",
            "kind": "live_end",
            "title": f"⚪ {seller} {rd}차 라이브 종료",
            "ref_id": cid, "ref_kind": "campaign",
            "auto": True,
        })
    # 발송
    sh = campaign.get("shipment") or {}
    if sh.get("date"):
        qty = sh.get("qty", 0)
        out.append({
            "id": f"{cid}.shipment",
            "date": sh["date"],
            "time": "",
            "kind": "shipment",
            "title": f"🎁 {seller} 발송{' (' + str(qty) + '개)' if qty else ''}",
            "ref_id": cid, "ref_kind": "campaign",
            "auto": True,
        })
    return out


def _derive_meeting_events(meeting: dict[str, Any]) -> list[dict[str, Any]]:
    if not meeting.get("date"):
        return []
    return [{
        "id": f"{meeting['id']}.meeting",
        "date": meeting["date"],
        "time": meeting.get("time", ""),
        "kind": "meeting",
        "title": f"🎤 {meeting.get('title', '미팅')}",
        "ref_id": meeting["id"], "ref_kind": "meeting",
        "auto": True,
    }]


@app.route("/api/calendar", methods=["GET"])
def api_calendar():
    """모든 이벤트(캠페인 파생 + 미팅 파생 + 직접 추가) 합쳐서 반환."""
    out = []
    for c in load_campaigns():
        out.extend(_derive_campaign_events(c))
    for m in load_meetings():
        out.extend(_derive_meeting_events(m))
    for e in load_events():
        item = dict(e)
        item["auto"] = False
        out.append(item)
    # 날짜 기준 정렬
    out.sort(key=lambda x: (x.get("date", ""), x.get("time", "")))
    return jsonify({"events": out})


# ─── TODAY (오늘/이번주 할 일) ────────────────────────────
@app.route("/api/today", methods=["GET"])
def api_today():
    today = datetime.now().date()
    from datetime import timedelta
    week_end = today + timedelta(days=7)
    urgent, this_week, overdue, undated = [], [], [], []

    for c in load_campaigns():
        if c.get("status") in ("완료",):
            continue
        ls = c.get("live_start") or ""
        seller = c.get("seller_name", "")
        rd = c.get("round", 1)
        stage_label = STAGE_LABEL.get(c.get("stage", ""), c.get("stage", ""))
        if not ls:
            undated.append({
                "campaign_id": c["id"],
                "title": f"{seller} {rd}차",
                "stage": stage_label,
                "status": c.get("status", ""),
            })
            continue
        try:
            d = datetime.strptime(ls, "%Y-%m-%d").date()
        except ValueError:
            continue
        days = (d - today).days
        item = {
            "campaign_id": c["id"],
            "title": f"{seller} {rd}차 라이브 시작",
            "live_start": ls,
            "days": days,
            "stage": stage_label,
            "status": c.get("status", ""),
        }
        if days < 0 and c.get("stage") != "complete":
            overdue.append(item)
        elif days <= 3:
            urgent.append(item)
        elif days <= 14:
            this_week.append(item)

    return jsonify({
        "today": today.isoformat(),
        "urgent": urgent,
        "this_week": this_week,
        "overdue": overdue,
        "undated": undated,
    })


# ─── MEETINGS (미팅 + 녹취 분석) ──────────────────────────
MEETING_FIELDS = (
    "campaign_id", "title", "date", "time",
    "attendees", "agenda", "manual_notes",
    "transcript", "summary", "decisions",
    "action_items", "key_points", "follow_up_topics",
)


@app.route("/api/meetings", methods=["GET"])
def api_meetings_list():
    return jsonify({"meetings": load_meetings()})


@app.route("/api/meetings", methods=["POST"])
def api_meetings_add():
    payload = request.get_json(force=True)
    items = load_meetings()
    now = datetime.now().isoformat(timespec="seconds")
    new = {
        "id": _next_id(items, "m"),
        "campaign_id": payload.get("campaign_id") or "",
        "title": (payload.get("title") or "").strip() or "(제목 없음)",
        "date": (payload.get("date") or "").strip(),
        "time": (payload.get("time") or "").strip(),
        "attendees": payload.get("attendees") or [],
        "agenda": (payload.get("agenda") or "").strip(),
        "audio_file": "",
        "transcript": "",
        "summary": "",
        "decisions": [],
        "action_items": [],
        "key_points": [],
        "follow_up_topics": [],
        "manual_notes": "",
        "created_at": now,
        "updated_at": now,
        "analysis_status": "none",
    }
    items.append(new)
    save_meetings(items)
    return jsonify({"meeting": new})


@app.route("/api/meetings/<mid>", methods=["PATCH"])
def api_meetings_patch(mid: str):
    payload = request.get_json(force=True)
    items = load_meetings()
    m = next((x for x in items if x["id"] == mid), None)
    if not m:
        return jsonify({"error": "not found"}), 404
    for k in MEETING_FIELDS:
        if k in payload:
            v = payload[k]
            if isinstance(v, str):
                v = v.strip()
            m[k] = v
    m["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_meetings(items)
    return jsonify({"meeting": m})


@app.route("/api/meetings/<mid>", methods=["DELETE"])
def api_meetings_delete(mid: str):
    items = load_meetings()
    m = next((x for x in items if x["id"] == mid), None)
    if m and m.get("audio_file"):
        try:
            Path(m["audio_file"]).unlink(missing_ok=True)
        except Exception:
            pass
    items = [x for x in items if x["id"] != mid]
    save_meetings(items)
    return jsonify({"ok": True})


@app.route("/api/meetings/<mid>/upload", methods=["POST"])
def api_meeting_upload(mid: str):
    """녹취 업로드 → Drive 동기화 폴더로 자동 이관 + 이름 자동 변경.

    파일명 규칙: {YYYYMMDD}_{미팅제목}_{미팅ID}.{ext}
    Drive 폴더 없으면 fallback으로 data/meetings/ 에 저장.
    """
    items = load_meetings()
    m = next((x for x in items if x["id"] == mid), None)
    if not m:
        return jsonify({"error": "not found"}), 404
    f = request.files.get("audio")
    if not f:
        return jsonify({"error": "audio 파일 필수"}), 400

    # 확장자 정리
    ext = (Path(f.filename or "audio.m4a").suffix or ".m4a").lower()
    if ext not in (".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac", ".webm", ".mp4"):
        ext = ".m4a"

    # 의미있는 파일명 생성
    date_part = (m.get("date") or datetime.now().strftime("%Y-%m-%d")).replace("-", "")
    title_part = _safe_filename(m.get("title", ""), fallback="미팅")
    new_name = f"{date_part}_{title_part}_{mid}{ext}"

    # 저장 위치: Drive 폴더 우선, fallback 로컬
    drive_dir = _find_drive_meeting_dir()
    if drive_dir:
        save_path = drive_dir / new_name
        m["audio_location"] = "drive"
    else:
        save_path = MEETINGS_DIR / new_name
        m["audio_location"] = "local"

    # 같은 이름 있으면 _2, _3... 붙임
    if save_path.exists():
        i = 2
        while True:
            cand = save_path.with_stem(f"{save_path.stem}_{i}")
            if not cand.exists():
                save_path = cand
                break
            i += 1

    try:
        f.save(str(save_path))
    except Exception as e:
        return jsonify({"error": f"파일 저장 실패: {e}"}), 500

    m["audio_file"] = str(save_path)
    m["audio_filename"] = save_path.name
    m["audio_folder"] = str(save_path.parent)
    m["analysis_status"] = "uploaded"
    m["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_meetings(items)
    return jsonify({"meeting": m, "saved_to": str(save_path), "drive_synced": drive_dir is not None})


@app.route("/api/meetings/open_folder", methods=["POST"])
def api_meeting_open_folder():
    """녹취 폴더를 탐색기로 열기."""
    import subprocess
    drive_dir = _find_drive_meeting_dir()
    target = drive_dir or MEETINGS_DIR
    if not target.exists():
        target.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.Popen(["explorer.exe", str(target)])
        return jsonify({"ok": True, "path": str(target), "is_drive": drive_dir is not None})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/meetings/<mid>/analyze_text", methods=["POST"])
def api_meeting_analyze_text(mid: str):
    """클로바노트 등에서 받은 텍스트를 붙여넣어 Gemini가 요약/액션 추출."""
    payload = request.get_json(force=True)
    transcript = (payload.get("transcript") or "").strip()
    if not transcript:
        return jsonify({"error": "transcript 필수"}), 400

    items = load_meetings()
    m = next((x for x in items if x["id"] == mid), None)
    if not m:
        return jsonify({"error": "not found"}), 404

    job_id = uuid.uuid4().hex[:12]
    with JOB_LOCK:
        JOBS[job_id] = {
            "id": job_id, "kind": "meeting_analyze_text", "meeting_id": mid,
            "status": "running", "progress": 0, "total": 10,
            "message": "텍스트 분석 시작…",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None, "errors": [],
        }

    def run():
        try:
            from meeting_analyzer import MeetingAnalyzer  # type: ignore
            cfg = load_config()
            analyzer = MeetingAnalyzer(cfg)
            result = analyzer.analyze_text(transcript, on_progress=lambda **kw: update_job(job_id, **kw))
            if result.get("_error"):
                update_job(job_id, status="error", message=result["_error"],
                           finished_at=datetime.now().isoformat(timespec="seconds"))
                return
            items2 = load_meetings()
            mm = next((x for x in items2 if x["id"] == mid), None)
            if mm:
                mm["transcript"] = result.get("transcript", transcript)
                mm["summary"] = result.get("summary", "")
                mm["decisions"] = result.get("decisions", [])
                mm["action_items"] = result.get("action_items", [])
                mm["key_points"] = result.get("key_points", [])
                mm["follow_up_topics"] = result.get("follow_up_topics", [])
                mm["analysis_status"] = "done"
                mm["updated_at"] = datetime.now().isoformat(timespec="seconds")
                save_meetings(items2)
            update_job(job_id, status="done", message="분석 완료!",
                       progress=10, total=10,
                       finished_at=datetime.now().isoformat(timespec="seconds"))
        except Exception as e:  # noqa: BLE001
            log.exception("meeting analyze_text failed")
            update_job(job_id, status="error", message=f"에러: {e}",
                       finished_at=datetime.now().isoformat(timespec="seconds"))

    threading.Thread(target=run, daemon=True).start()

    m["analysis_status"] = "analyzing"
    save_meetings(items)
    return jsonify({"job_id": job_id})


@app.route("/api/meetings/<mid>/analyze", methods=["POST"])
def api_meeting_analyze(mid: str):
    items = load_meetings()
    m = next((x for x in items if x["id"] == mid), None)
    if not m:
        return jsonify({"error": "not found"}), 404
    if not m.get("audio_file"):
        return jsonify({"error": "오디오 파일 먼저 업로드"}), 400

    job_id = uuid.uuid4().hex[:12]
    with JOB_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "kind": "meeting_analyze",
            "meeting_id": mid,
            "status": "running",
            "progress": 0, "total": 10,
            "message": "분석 시작…",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
            "errors": [],
        }

    def run():
        try:
            from meeting_analyzer import MeetingAnalyzer  # type: ignore
            cfg = load_config()
            analyzer = MeetingAnalyzer(cfg)
            result = analyzer.analyze_audio(
                Path(m["audio_file"]),
                on_progress=lambda **kw: update_job(job_id, **kw),
            )
            if result.get("_error"):
                # 마킹
                items2 = load_meetings()
                mm = next((x for x in items2 if x["id"] == mid), None)
                if mm:
                    mm["analysis_status"] = "error"
                    mm["updated_at"] = datetime.now().isoformat(timespec="seconds")
                    save_meetings(items2)
                update_job(job_id, status="error", message=result["_error"],
                           finished_at=datetime.now().isoformat(timespec="seconds"))
                return

            # 미팅 업데이트
            items2 = load_meetings()
            mm = next((x for x in items2 if x["id"] == mid), None)
            if mm:
                mm["transcript"] = result.get("transcript", "")
                mm["summary"] = result.get("summary", "")
                mm["decisions"] = result.get("decisions", [])
                mm["action_items"] = result.get("action_items", [])
                mm["key_points"] = result.get("key_points", [])
                mm["follow_up_topics"] = result.get("follow_up_topics", [])
                mm["analysis_status"] = "done"
                mm["updated_at"] = datetime.now().isoformat(timespec="seconds")
                save_meetings(items2)

            update_job(job_id, status="done", message="분석 완료!",
                       progress=10, total=10,
                       finished_at=datetime.now().isoformat(timespec="seconds"))
        except Exception as e:  # noqa: BLE001
            log.exception("meeting analyze failed")
            update_job(job_id, status="error", message=f"에러: {e}",
                       finished_at=datetime.now().isoformat(timespec="seconds"))

    threading.Thread(target=run, daemon=True).start()

    # 미팅 상태 분석 중으로 마킹
    m["analysis_status"] = "analyzing"
    save_meetings(items)

    return jsonify({"job_id": job_id})


# ─── AI CHAT WIDGET (격리 모듈) ──────────────────────────
CHAT_FILE = DATA_DIR / "chat_history.json"
CHAT_UPLOADS_DIR = DATA_DIR / "chat_uploads"
CHAT_UPLOADS_DIR.mkdir(exist_ok=True)


def load_chat() -> dict:
    if not CHAT_FILE.exists():
        return {"messages": []}
    try:
        return json.loads(CHAT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"messages": []}


def save_chat(data: dict) -> None:
    CHAT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/api/chat/messages", methods=["GET"])
def api_chat_messages():
    return jsonify(load_chat())


@app.route("/api/chat/new", methods=["POST"])
def api_chat_new():
    save_chat({"messages": []})
    return jsonify({"ok": True})


@app.route("/api/chat/send", methods=["POST"])
def api_chat_send():
    text = (request.form.get("text") or "").strip()
    image_file = request.files.get("image")

    if not text and not image_file:
        return jsonify({"error": "메시지 또는 이미지 필수"}), 400

    data = load_chat()

    # 이미지 저장
    image_url = None
    image_bytes = None
    image_mime = None
    if image_file:
        ext = (Path(image_file.filename or "img.png").suffix or ".png").lower()
        if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
            ext = ".png"
        fname = f"img_{uuid.uuid4().hex[:10]}{ext}"
        fpath = CHAT_UPLOADS_DIR / fname
        image_file.save(str(fpath))
        try:
            image_bytes = fpath.read_bytes()
        except Exception:
            image_bytes = None
        image_mime = image_file.mimetype or "image/png"
        image_url = f"/chat_uploads/{fname}"

    # 사용자 메시지 누적 저장
    now = datetime.now().isoformat(timespec="seconds")
    user_msg = {"role": "user", "text": text, "image": image_url, "at": now}
    data["messages"].append(user_msg)
    save_chat(data)

    # Gemini history 형식 변환 (현재 메시지 빼고)
    history_for_gemini = []
    for m in data["messages"][:-1]:
        role = "user" if m["role"] == "user" else "model"
        history_for_gemini.append({"role": role, "parts": [m.get("text", "") or "(이미지)"]})

    # Gemini 호출 (자동 도구 호출)
    tool_calls = []
    try:
        from chat_agent import ChatAgent  # type: ignore
        agent = ChatAgent(load_config())
        result = agent.send(history_for_gemini, text,
                            image_bytes=image_bytes, image_mime=image_mime)
        if isinstance(result, dict):
            reply_text = result.get("text", "")
            tool_calls = result.get("tool_calls", [])
        else:
            reply_text = str(result)
    except Exception as e:  # noqa: BLE001
        log.exception("chat send failed")
        reply_text = f"❌ 에러: {e}"

    assistant_msg = {
        "role": "assistant",
        "text": reply_text,
        "image": None,
        "tool_calls": tool_calls,
        "at": datetime.now().isoformat(timespec="seconds"),
    }
    data["messages"].append(assistant_msg)
    save_chat(data)

    # 어떤 데이터가 바뀌었는지 클라이언트에게 알려줌 (UI 새로고침용)
    changed = set()
    for tc in tool_calls:
        n = tc.get("name", "")
        if "campaign" in n: changed.update({"campaigns", "calendar", "dashboard", "today"})
        if "event" in n: changed.add("calendar")
        if "meeting" in n: changed.update({"meetings", "calendar"})
        if "brand" in n: changed.add("brands")

    return jsonify({"reply": assistant_msg, "changed": list(changed)})


@app.route("/chat_uploads/<path:filename>")
def serve_chat_upload(filename: str):
    return send_from_directory(CHAT_UPLOADS_DIR, filename)


# ═══════════════════════════════════════════════════════════
# 📨 DM 영업 시스템 — v2 (인플루언서 5000 + 계정 100+)
# ═══════════════════════════════════════════════════════════

INFLUENCERS_FILE = DATA_DIR / "influencers.json"
OUR_ACCOUNTS_FILE = DATA_DIR / "our_accounts.json"
IMPORTS_DIR = DATA_DIR / "imports"
IMPORTS_DIR.mkdir(exist_ok=True)


def _load_influencers() -> list[dict]:
    if not INFLUENCERS_FILE.exists():
        return []
    return json.loads(INFLUENCERS_FILE.read_text(encoding="utf-8")).get("influencers", [])


def _save_influencers(items: list[dict]) -> None:
    INFLUENCERS_FILE.write_text(
        json.dumps({"influencers": items, "schema_version": 2,
                    "updated_at": datetime.now().isoformat(timespec="seconds")},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_our_accounts() -> list[dict]:
    if not OUR_ACCOUNTS_FILE.exists():
        return []
    return json.loads(OUR_ACCOUNTS_FILE.read_text(encoding="utf-8")).get("accounts", [])


def _save_our_accounts(items: list[dict]) -> None:
    OUR_ACCOUNTS_FILE.write_text(
        json.dumps({"accounts": items, "schema_version": 2,
                    "updated_at": datetime.now().isoformat(timespec="seconds")},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ─── 인플루언서 마스터 (5,000명) ─────────────────────────
@app.route("/api/influencers", methods=["GET"])
def api_influencers_list():
    items = _load_influencers()
    # 페이지네이션
    page = int(request.args.get("page", 1))
    page_size = int(request.args.get("page_size", 50))
    q = (request.args.get("q") or "").strip().lower()
    status_filter = (request.args.get("status") or "").strip()

    filtered = items
    if q:
        filtered = [it for it in filtered if
                    q in (it.get("instagram_id", "") or "").lower() or
                    q in (it.get("seller_name", "") or "").lower()]
    if status_filter:
        filtered = [it for it in filtered if it.get("status") == status_filter]

    total = len(filtered)
    start = (page - 1) * page_size
    end = start + page_size
    return jsonify({
        "influencers": filtered[start:end],
        "total": total,
        "page": page,
        "page_size": page_size,
        "summary": _influencer_summary(items),
    })


def _influencer_summary(items: list[dict]) -> dict:
    by_status: dict[str, int] = {}
    for it in items:
        s = it.get("status") or "미발송"
        by_status[s] = by_status.get(s, 0) + 1
    return {"total": len(items), "by_status": by_status}


@app.route("/api/influencers/<iid>", methods=["PATCH"])
def api_influencers_patch(iid: str):
    payload = request.get_json(force=True)
    items = _load_influencers()
    it = next((x for x in items if x["id"] == iid), None)
    if not it:
        return jsonify({"error": "not found"}), 404
    for k in ("seller_name", "status", "notes", "history_text"):
        if k in payload:
            it[k] = (payload[k] or "").strip()
    _save_influencers(items)
    return jsonify({"influencer": it})


@app.route("/api/influencers/<iid>", methods=["DELETE"])
def api_influencers_delete(iid: str):
    items = [x for x in _load_influencers() if x["id"] != iid]
    _save_influencers(items)
    return jsonify({"ok": True})


# ─── 우리 계정 마스터 (100+) ─────────────────────────────
@app.route("/api/our_accounts", methods=["GET"])
def api_our_accounts_list():
    items = _load_our_accounts()
    # 비번 마스킹
    out = []
    for a in items:
        masked = dict(a)
        if masked.get("login_pw"): masked["login_pw"] = "*" * 8
        if masked.get("linked_email_pw"): masked["linked_email_pw"] = "*" * 8
        out.append(masked)
    # 기기별 그룹 카운트
    by_device = {}
    for it in items:
        d = it.get("device") or "(미지정)"
        by_device[d] = by_device.get(d, 0) + 1
    by_status = {}
    for it in items:
        s = it.get("status") or "활성"
        by_status[s] = by_status.get(s, 0) + 1
    return jsonify({
        "accounts": out,
        "summary": {
            "total": len(items),
            "by_status": by_status,
            "by_device": by_device,
        }
    })


@app.route("/api/our_accounts/<aid>", methods=["PATCH"])
def api_our_accounts_patch(aid: str):
    payload = request.get_json(force=True)
    items = _load_our_accounts()
    a = next((x for x in items if x["id"] == aid), None)
    if not a:
        return jsonify({"error": "not found"}), 404
    for k in ("status", "daily_limit", "notes", "phone", "device", "account_owner"):
        if k in payload:
            v = payload[k]
            if k == "daily_limit":
                v = int(v or 50)
            elif isinstance(v, str):
                v = v.strip()
            a[k] = v
    if "login_pw" in payload and payload["login_pw"]:
        a["login_pw"] = payload["login_pw"]
    _save_our_accounts(items)
    return jsonify({"account": {**a, "login_pw": "*" * 8}})


@app.route("/api/our_accounts/<aid>", methods=["DELETE"])
def api_our_accounts_delete(aid: str):
    items = [x for x in _load_our_accounts() if x["id"] != aid]
    _save_our_accounts(items)
    return jsonify({"ok": True})


# ─── 엑셀 자동 임포트 ────────────────────────────────────
@app.route("/api/dm/import/preview", methods=["GET"])
def api_dm_import_preview():
    """data/imports/ 폴더의 xlsx 파일 목록 + 미리보기 정보."""
    files = []
    if IMPORTS_DIR.exists():
        for p in sorted(IMPORTS_DIR.glob("*.xlsx")):
            files.append({
                "name": p.name,
                "size_kb": round(p.stat().st_size / 1024, 1),
                "modified": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
            })
    return jsonify({"files": files, "imports_dir": str(IMPORTS_DIR)})


@app.route("/api/dm/import/influencers", methods=["POST"])
def api_dm_import_influencers():
    payload = request.get_json(force=True) or {}
    fname = (payload.get("filename") or "").strip()
    if not fname:
        return jsonify({"error": "filename 필수"}), 400
    fpath = IMPORTS_DIR / fname
    if not fpath.exists():
        return jsonify({"error": f"파일 없음: {fpath}"}), 404

    try:
        from dm_importer import import_influencers  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"importer 모듈 실패: {e}"}), 500

    mode = (payload.get("mode") or "add").strip().lower()
    if mode not in ("add", "update"):
        mode = "add"

    existing = _load_influencers()
    result = import_influencers(fpath, existing, mode=mode)
    if result.get("error"):
        return jsonify(result), 400

    new_items = result.pop("items", [])
    existing.extend(new_items)
    _save_influencers(existing)

    return jsonify({**result, "mode": mode, "total_after": len(existing)})


@app.route("/api/dm/import/accounts", methods=["POST"])
def api_dm_import_accounts():
    payload = request.get_json(force=True) or {}
    fname = (payload.get("filename") or "").strip()
    if not fname:
        return jsonify({"error": "filename 필수"}), 400
    fpath = IMPORTS_DIR / fname
    if not fpath.exists():
        return jsonify({"error": f"파일 없음: {fpath}"}), 404

    try:
        from dm_importer import import_accounts  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"importer 모듈 실패: {e}"}), 500

    mode = (payload.get("mode") or "add").strip().lower()
    if mode not in ("add", "update"):
        mode = "add"

    existing = _load_our_accounts()
    result = import_accounts(fpath, existing, mode=mode)
    if result.get("error"):
        return jsonify(result), 400

    new_items = result.pop("items", [])
    existing.extend(new_items)
    _save_our_accounts(existing)

    return jsonify({**result, "mode": mode, "total_after": len(existing)})


@app.route("/api/dm/import/template/<kind>", methods=["GET"])
def api_dm_import_template(kind):
    """양식 엑셀 다운로드. kind = 'influencers' | 'accounts'"""
    tpl_dir = IMPORTS_DIR / "templates"
    mapping = {
        "influencers": "influencers_template.xlsx",
        "accounts": "accounts_template.xlsx",
    }
    fname = mapping.get(kind)
    if not fname:
        return jsonify({"error": "kind는 influencers / accounts"}), 400
    fpath = tpl_dir / fname
    if not fpath.exists():
        return jsonify({
            "error": "양식 파일 없음",
            "hint": "python scripts/make_templates.py 실행",
        }), 404
    return send_from_directory(tpl_dir, fname, as_attachment=True)


# ═══════════════════════════════════════════════════════════
# 🚀 Phase B — 발송 큐 (오늘 보낼 후보 자동 산출)
# ═══════════════════════════════════════════════════════════

DM_TEMPLATES_V2_FILE = DATA_DIR / "dm_templates_v2.json"

# 라이브 발송 상태 (in-memory) — 서버 재시작 시 초기화
DM_LIVE_STATE = {
    "current": None,       # {influencer_handle, account_handle, started_at, message_preview}
    "log": [],             # [{ts, account, target, status, message}], 최근 200개
    "paused": False,
    "running": False,
}
DM_LIVE_LOG_MAX = 200


def _dm_live_emit(event: dict) -> None:
    """라이브 로그에 1건 추가 (오래된 항목 잘라냄)."""
    event["ts"] = datetime.now().isoformat(timespec="seconds")
    DM_LIVE_STATE["log"].insert(0, event)
    if len(DM_LIVE_STATE["log"]) > DM_LIVE_LOG_MAX:
        DM_LIVE_STATE["log"] = DM_LIVE_STATE["log"][:DM_LIVE_LOG_MAX]


def _load_dm_templates_v2() -> list[dict]:
    if not DM_TEMPLATES_V2_FILE.exists():
        return [{"id": "tpl_default", "name": "기본 1차", "body": "안녕하세요! 넥스트포트에서 공동구매 제안드립니다 :)"}]
    try:
        with open(DM_TEMPLATES_V2_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("templates", [])
    except Exception:
        return []


def _save_dm_templates_v2(items: list[dict]) -> None:
    DM_TEMPLATES_V2_FILE.write_text(
        json.dumps({"templates": items, "updated_at": datetime.now().isoformat(timespec="seconds")},
                   ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/api/dm/queue/today", methods=["GET"])
def api_dm_queue_today():
    """오늘 발송 가능한 (인플루언서, 추천계정) 페어 산출."""
    try:
        from dm_scheduler import build_queue  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"scheduler 모듈 실패: {e}"}), 500
    max_per_run = int(request.args.get("max", 100))
    influencers = _load_influencers()
    accounts = _load_our_accounts()
    return jsonify(build_queue(influencers, accounts, max_per_run=max_per_run))


@app.route("/api/dm/templates_v2", methods=["GET", "POST"])
def api_dm_templates_v2():
    if request.method == "POST":
        payload = request.get_json(force=True) or {}
        items = payload.get("templates") or []
        _save_dm_templates_v2(items)
        return jsonify({"ok": True, "count": len(items)})
    return jsonify({"templates": _load_dm_templates_v2()})


@app.route("/api/dm/send", methods=["POST"])
def api_dm_send_one():
    """큐의 한 페어를 즉시 발송. body: {influencer_id, account_id, message}"""
    # 클라우드 환경에서는 발송 차단
    if (load_config() or {}).get("env_mode") == "cloud":
        return jsonify({"error": "클라우드 환경에서는 DM 발송 비활성화"}), 403

    payload = request.get_json(force=True) or {}
    inf_id = payload.get("influencer_id")
    acc_id = payload.get("account_id")
    message = (payload.get("message") or "").strip()
    if not (inf_id and acc_id and message):
        return jsonify({"error": "influencer_id, account_id, message 필수"}), 400

    influencers = _load_influencers()
    accounts = _load_our_accounts()
    inf = next((x for x in influencers if x["id"] == inf_id), None)
    acc = next((x for x in accounts if x["id"] == acc_id), None)
    if not inf or not acc:
        return jsonify({"error": "인플루언서 또는 계정 없음"}), 404

    try:
        from dm_sender import DMSender  # type: ignore
        from dm_scheduler import record_send  # type: ignore
        from dm_inbox import upsert_conversation, append_message  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"모듈 실패: {e}"}), 500

    # 라이브 상태 업데이트 — UI 가 polling
    DM_LIVE_STATE["current"] = {
        "influencer_handle": inf.get("instagram_id"),
        "seller_name": inf.get("seller_name"),
        "account_handle": acc.get("instagram_id"),
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "message_preview": message[:80],
        "send_count": (inf.get("send_count") or 0) + 1,
    }
    DM_LIVE_STATE["running"] = True
    _dm_live_emit({
        "type": "start",
        "account": acc.get("instagram_id"),
        "target": inf.get("instagram_id"),
        "message": message[:80],
    })

    sender = DMSender()
    ok = False
    err_msg = ""
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=False)
            ctx = browser.new_context()
            page = ctx.new_page()
            if not sender.login(page, acc):
                err_msg = "로그인 실패"
            else:
                ok, err_msg = sender.send_dm(page, {"instagram_id": inf["instagram_id"]}, message)
            ctx.close()
            browser.close()
    except ImportError:
        DM_LIVE_STATE["current"] = None
        DM_LIVE_STATE["running"] = False
        return jsonify({"error": "Playwright 미설치"}), 500
    except Exception as e:
        err_msg = str(e)

    # 라이브 로그 — 종료
    _dm_live_emit({
        "type": "done",
        "account": acc.get("instagram_id"),
        "target": inf.get("instagram_id"),
        "status": "ok" if ok else "fail",
        "error": err_msg if not ok else "",
    })
    DM_LIVE_STATE["current"] = None
    DM_LIVE_STATE["running"] = False

    # 결과 기록
    status = "ok" if ok else "fail"
    record_send(inf, acc, message, status=status, note=err_msg)
    _save_influencers(influencers)
    _save_our_accounts(accounts)

    # 인박스에도 우리가 보낸 메시지로 기록
    if ok:
        inbox = _load_inbox()
        conv = upsert_conversation(inbox, acc, inf["instagram_id"], inf)
        append_message(conv, "us", message)
        _save_inbox(inbox)

    return jsonify({"ok": ok, "error": err_msg if not ok else None, "send_count": inf.get("send_count")})


# ═══════════════════════════════════════════════════════════
# 📥 Phase C — 통합 DM 답장 인박스
# ═══════════════════════════════════════════════════════════

INBOX_FILE = DATA_DIR / "inbox_messages.json"


def _load_inbox() -> list[dict]:
    if not INBOX_FILE.exists():
        return []
    try:
        with open(INBOX_FILE, encoding="utf-8") as f:
            return json.load(f).get("conversations", [])
    except Exception:
        return []


def _save_inbox(conversations: list[dict]) -> None:
    INBOX_FILE.write_text(json.dumps({
        "conversations": conversations,
        "schema_version": 1,
        "synced_at": datetime.now().isoformat(timespec="seconds"),
    }, ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/api/dm/inbox", methods=["GET"])
def api_dm_inbox_list():
    try:
        from dm_inbox import list_conversations, summarize  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"인박스 모듈 실패: {e}"}), 500
    conversations = _load_inbox()
    result = list_conversations(
        conversations,
        q=request.args.get("q", "").strip(),
        only_unread=request.args.get("only_unread", "").lower() in ("1", "true", "yes"),
        account_id=request.args.get("account_id", "").strip(),
        page=int(request.args.get("page", 1)),
        page_size=int(request.args.get("page_size", 50)),
    )
    result["summary"] = summarize(conversations)
    return jsonify(result)


@app.route("/api/dm/inbox/<conv_id>", methods=["GET"])
def api_dm_inbox_conversation(conv_id):
    conversations = _load_inbox()
    conv = next((c for c in conversations if c.get("id") == conv_id), None)
    if not conv:
        return jsonify({"error": "대화 없음"}), 404
    return jsonify(conv)


@app.route("/api/dm/inbox/<conv_id>/read", methods=["POST"])
def api_dm_inbox_mark_read(conv_id):
    try:
        from dm_inbox import mark_read  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"인박스 모듈 실패: {e}"}), 500
    conversations = _load_inbox()
    conv = next((c for c in conversations if c.get("id") == conv_id), None)
    if not conv:
        return jsonify({"error": "대화 없음"}), 404
    mark_read(conv)
    _save_inbox(conversations)
    return jsonify({"ok": True})


@app.route("/api/dm/inbox/<conv_id>/reply", methods=["POST"])
def api_dm_inbox_reply(conv_id):
    """답장 보내기 — 그 conversation 의 our_account 로."""
    if (load_config() or {}).get("env_mode") == "cloud":
        return jsonify({"error": "클라우드 환경에서는 DM 발송 비활성화"}), 403

    payload = request.get_json(force=True) or {}
    message = (payload.get("message") or "").strip()
    if not message:
        return jsonify({"error": "message 필수"}), 400

    conversations = _load_inbox()
    conv = next((c for c in conversations if c.get("id") == conv_id), None)
    if not conv:
        return jsonify({"error": "대화 없음"}), 404

    accounts = _load_our_accounts()
    acc = next((a for a in accounts if a["id"] == conv.get("our_account_id")), None)
    if not acc:
        return jsonify({"error": "발송 계정 없음"}), 404

    try:
        from dm_sender import DMSender  # type: ignore
        from dm_inbox import append_message  # type: ignore
        from playwright.sync_api import sync_playwright  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"모듈 실패: {e}"}), 500

    sender = DMSender()
    ok = False
    err_msg = ""
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=False)
            ctx = browser.new_context()
            page = ctx.new_page()
            if not sender.login(page, acc):
                err_msg = "로그인 실패"
            else:
                ok, err_msg = sender.send_dm(page, {"instagram_id": conv["their_handle"]}, message)
            ctx.close()
            browser.close()
    except Exception as e:
        err_msg = str(e)

    if ok:
        append_message(conv, "us", message)
        _save_inbox(conversations)

    return jsonify({"ok": ok, "error": err_msg if not ok else None})


@app.route("/api/dm/inbox/sync", methods=["POST"])
def api_dm_inbox_sync():
    """모든 활성 계정에서 받은 DM 동기화 (Playwright). 무거움 — 백그라운드 실행 권장.
    body 옵션: {account_ids: ["acc0001",...]} 비우면 전체 활성 계정
    """
    if (load_config() or {}).get("env_mode") == "cloud":
        return jsonify({"error": "클라우드 환경에서는 비활성화"}), 403

    payload = request.get_json(silent=True) or {}
    filter_ids = set(payload.get("account_ids") or [])
    accounts = _load_our_accounts()
    influencers = _load_influencers()
    inf_by_handle = {x.get("instagram_id", "").lower(): x for x in influencers}
    targets = [a for a in accounts if a.get("status") == "활성"]
    if filter_ids:
        targets = [a for a in targets if a["id"] in filter_ids]

    if not targets:
        return jsonify({"error": "활성 계정 없음"}), 400

    try:
        from dm_sender import DMSender  # type: ignore
        from dm_inbox import upsert_conversation, append_message  # type: ignore
        from playwright.sync_api import sync_playwright  # type: ignore
    except ImportError as e:
        return jsonify({"error": f"모듈 실패: {e}"}), 500

    conversations = _load_inbox()
    total_new = 0
    per_account = []
    sender = DMSender()

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for acc in targets:
                ctx = browser.new_context()
                page = ctx.new_page()
                new_for_acc = 0
                try:
                    if not sender.login(page, acc):
                        per_account.append({"account": acc.get("instagram_id"), "error": "로그인 실패"})
                        ctx.close()
                        continue
                    # 인박스 페이지로 가서 최근 대화 목록 긁기
                    page.goto("https://www.instagram.com/direct/inbox/", timeout=30000)
                    page.wait_for_timeout(3000)
                    threads = page.locator('div[role="listitem"]').all()
                    for t in threads[:20]:
                        try:
                            handle = t.locator('span').first.text_content() or ""
                            preview = t.locator('span').nth(1).text_content() or ""
                            handle = handle.strip()
                            if not handle:
                                continue
                            inf = inf_by_handle.get(handle.lower())
                            conv = upsert_conversation(conversations, acc, handle, inf)
                            # 마지막 미리보기와 다르면 새 메시지로 간주
                            if preview and preview != conv.get("last_message_preview"):
                                append_message(conv, "them", preview)
                                new_for_acc += 1
                        except Exception:
                            continue
                    per_account.append({"account": acc.get("instagram_id"), "new": new_for_acc})
                    total_new += new_for_acc
                except Exception as e:
                    per_account.append({"account": acc.get("instagram_id"), "error": str(e)})
                finally:
                    ctx.close()
            browser.close()
    except Exception as e:
        return jsonify({"error": f"브라우저 실패: {e}"}), 500

    _save_inbox(conversations)
    return jsonify({"ok": True, "total_new": total_new, "per_account": per_account})


# ═══════════════════════════════════════════════════════════
# ▶️ Phase D — 라이브 발송 상태 & 회신 인플루언서 현황 & 데일리 통계
# ═══════════════════════════════════════════════════════════

@app.route("/api/dm/live", methods=["GET"])
def api_dm_live():
    """현재 발송 중 상태 + 최근 로그. UI가 2초 polling."""
    return jsonify({
        "current": DM_LIVE_STATE.get("current"),
        "running": DM_LIVE_STATE.get("running", False),
        "paused": DM_LIVE_STATE.get("paused", False),
        "log": DM_LIVE_STATE.get("log", [])[:100],
        "log_count": len(DM_LIVE_STATE.get("log", [])),
    })


@app.route("/api/dm/live/clear", methods=["POST"])
def api_dm_live_clear():
    DM_LIVE_STATE["log"] = []
    return jsonify({"ok": True})


@app.route("/api/dm/live/pause", methods=["POST"])
def api_dm_live_pause():
    DM_LIVE_STATE["paused"] = not DM_LIVE_STATE.get("paused", False)
    return jsonify({"paused": DM_LIVE_STATE["paused"]})


@app.route("/api/dm/replies", methods=["GET"])
def api_dm_replies():
    """답장 받은 인플루언서 현황 — 인박스 + 인플루언서 매칭."""
    q = request.args.get("q", "").strip().lower()
    conversations = _load_inbox()
    influencers = _load_influencers()
    inf_by_handle = {x.get("instagram_id", "").lower(): x for x in influencers}

    rows = []
    seen = set()  # (handle, account_id) 페어 dedup
    for c in conversations:
        if (c.get("unread_count") or 0) == 0 and c.get("status") != "replied":
            # 답장 없는 대화는 제외 (우리가 보낸 것만 있는 경우)
            has_them = any(m.get("from") == "them" for m in c.get("messages", []))
            if not has_them:
                continue
        handle = (c.get("their_handle") or "").lower()
        key = (handle, c.get("our_account_id"))
        if key in seen:
            continue
        seen.add(key)
        inf = inf_by_handle.get(handle)
        row = {
            "conv_id": c.get("id"),
            "influencer_handle": c.get("their_handle"),
            "seller_name": c.get("seller_name") or (inf.get("seller_name") if inf else ""),
            "our_account_handle": c.get("our_account_handle"),
            "send_count": inf.get("send_count") if inf else None,
            "last_sent_date": inf.get("last_sent_date") if inf else None,
            "last_reply_at": c.get("last_message_at"),
            "last_message_preview": c.get("last_message_preview"),
            "unread_count": c.get("unread_count") or 0,
            "influencer_id": inf.get("id") if inf else None,
        }
        if q:
            blob = " ".join(str(v or "").lower() for v in row.values())
            if q not in blob:
                continue
        rows.append(row)

    rows.sort(key=lambda r: r.get("last_reply_at") or "", reverse=True)
    return jsonify({"replies": rows, "total": len(rows)})


@app.route("/api/dm/daily_stats", methods=["GET"])
def api_dm_daily_stats():
    """데일리 DM 탭 상단 통계 카드."""
    try:
        from dm_scheduler import build_queue  # type: ignore
    except ImportError:
        return jsonify({"error": "scheduler 미설치"}), 500

    influencers = _load_influencers()
    accounts = _load_our_accounts()
    conversations = _load_inbox()
    today = datetime.now().strftime("%Y-%m-%d")

    q = build_queue(influencers, accounts, max_per_run=10000)
    active_accounts = sum(1 for a in accounts if a.get("status") == "활성")
    sent_today = sum(1 for inf in influencers
                     if (inf.get("last_sent_date") or "")[:10] == today)
    replies_total = sum(1 for c in conversations
                        if any(m.get("from") == "them" for m in c.get("messages", [])))

    return jsonify({
        "candidates": len(q.get("queue", [])),
        "active_accounts": active_accounts,
        "sent_today": sent_today,
        "replies": replies_total,
        "queue_reasons": q.get("reasons", {}),
    })


# ═══════════════════════════════════════════════════════════
# 📨 DM 영업 시스템 — Legacy (구버전, 곧 마이그레이션 예정)
# ═══════════════════════════════════════════════════════════

DM_ACCOUNTS_FILE = DATA_DIR / "dm_accounts.json"
DM_TARGETS_FILE = DATA_DIR / "dm_targets.json"
DM_TEMPLATES_FILE = DATA_DIR / "dm_templates.json"
DM_JOBS_FILE = DATA_DIR / "dm_jobs.json"


def _dm_read(path: Path, key: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8")).get(key, [])
    except Exception:
        return []


def _dm_write(path: Path, key: str, items: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps({key: items}, ensure_ascii=False, indent=2), encoding="utf-8")


# ─── 계정 풀 ──────────────────────────────────────────────
@app.route("/api/dm/accounts", methods=["GET"])
def api_dm_accounts_list():
    items = _dm_read(DM_ACCOUNTS_FILE, "accounts")
    # 비밀번호 마스킹
    out = []
    for a in items:
        masked = dict(a)
        pw = masked.get("password", "")
        if pw:
            masked["password"] = "*" * 8
        out.append(masked)
    return jsonify({"accounts": out})


@app.route("/api/dm/accounts", methods=["POST"])
def api_dm_accounts_add():
    payload = request.get_json(force=True)
    items = _dm_read(DM_ACCOUNTS_FILE, "accounts")
    now = datetime.now().isoformat(timespec="seconds")
    new = {
        "id": _next_id(items, "a"),
        "username": (payload.get("username") or "").strip().lstrip("@"),
        "password": payload.get("password") or "",
        "sender_name": (payload.get("sender_name") or "").strip(),
        "status": "active",  # active / warmup / blocked / disabled
        "daily_count": 0,
        "daily_limit": int(payload.get("daily_limit") or 50),
        "total_sent": 0,
        "last_used_at": None,
        "last_reset_date": now[:10],
        "notes": (payload.get("notes") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    if not new["username"] or not new["password"]:
        return jsonify({"error": "username과 password 필수"}), 400
    items.append(new)
    _dm_write(DM_ACCOUNTS_FILE, "accounts", items)
    return jsonify({"account": {**new, "password": "*" * 8}})


@app.route("/api/dm/accounts/bulk", methods=["POST"])
def api_dm_accounts_bulk():
    """엑셀로 100개 한 번에 박기. CSV/JSON 둘 다 지원."""
    payload = request.get_json(force=True)
    rows = payload.get("rows") or []
    items = _dm_read(DM_ACCOUNTS_FILE, "accounts")
    now = datetime.now().isoformat(timespec="seconds")
    added = 0
    existing = {a["username"] for a in items}
    for row in rows:
        u = (row.get("username") or "").strip().lstrip("@")
        p = row.get("password") or ""
        if not u or not p or u in existing:
            continue
        existing.add(u)
        items.append({
            "id": _next_id(items, "a"),
            "username": u,
            "password": p,
            "sender_name": (row.get("sender_name") or "").strip(),
            "status": "active",
            "daily_count": 0,
            "daily_limit": int(row.get("daily_limit") or 50),
            "total_sent": 0,
            "last_used_at": None,
            "last_reset_date": now[:10],
            "notes": "",
            "created_at": now,
            "updated_at": now,
        })
        added += 1
    _dm_write(DM_ACCOUNTS_FILE, "accounts", items)
    return jsonify({"added": added, "total": len(items)})


@app.route("/api/dm/accounts/<aid>", methods=["PATCH"])
def api_dm_accounts_patch(aid: str):
    payload = request.get_json(force=True)
    items = _dm_read(DM_ACCOUNTS_FILE, "accounts")
    a = next((x for x in items if x["id"] == aid), None)
    if not a:
        return jsonify({"error": "not found"}), 404
    for k in ("username", "password", "sender_name", "status", "daily_limit", "notes"):
        if k in payload and payload[k] != "":
            v = payload[k]
            if k == "username":
                v = str(v).strip().lstrip("@")
            elif k == "daily_limit":
                v = int(v)
            elif isinstance(v, str):
                v = v.strip()
            a[k] = v
    a["updated_at"] = datetime.now().isoformat(timespec="seconds")
    _dm_write(DM_ACCOUNTS_FILE, "accounts", items)
    return jsonify({"account": {**a, "password": "*" * 8}})


@app.route("/api/dm/accounts/<aid>", methods=["DELETE"])
def api_dm_accounts_delete(aid: str):
    items = [a for a in _dm_read(DM_ACCOUNTS_FILE, "accounts") if a["id"] != aid]
    _dm_write(DM_ACCOUNTS_FILE, "accounts", items)
    return jsonify({"ok": True})


# ─── 영업 명단 (타겟) ─────────────────────────────────────
@app.route("/api/dm/targets", methods=["GET"])
def api_dm_targets_list():
    return jsonify({"targets": _dm_read(DM_TARGETS_FILE, "targets")})


@app.route("/api/dm/targets", methods=["POST"])
def api_dm_targets_add():
    payload = request.get_json(force=True)
    items = _dm_read(DM_TARGETS_FILE, "targets")
    now = datetime.now().isoformat(timespec="seconds")
    new = {
        "id": _next_id(items, "t"),
        "username": (payload.get("username") or "").strip().lstrip("@"),
        "display_name": (payload.get("display_name") or "").strip(),
        "category": (payload.get("category") or "").strip(),
        "followers": int(payload.get("followers") or 0),
        "status": "pending",  # pending / sending / sent / replied / failed
        "notes": (payload.get("notes") or "").strip(),
        "last_sent_at": None,
        "last_sent_account": None,
        "reply_received": False,
        "created_at": now,
    }
    if not new["username"]:
        return jsonify({"error": "username 필수"}), 400
    items.append(new)
    _dm_write(DM_TARGETS_FILE, "targets", items)
    return jsonify({"target": new})


@app.route("/api/dm/targets/bulk", methods=["POST"])
def api_dm_targets_bulk():
    payload = request.get_json(force=True)
    rows = payload.get("rows") or []
    items = _dm_read(DM_TARGETS_FILE, "targets")
    now = datetime.now().isoformat(timespec="seconds")
    added = 0
    existing = {t["username"] for t in items}
    for row in rows:
        u = (row.get("username") or "").strip().lstrip("@")
        if not u or u in existing:
            continue
        existing.add(u)
        items.append({
            "id": _next_id(items, "t"),
            "username": u,
            "display_name": (row.get("display_name") or "").strip(),
            "category": (row.get("category") or "").strip(),
            "followers": int(row.get("followers") or 0),
            "status": "pending",
            "notes": (row.get("notes") or "").strip(),
            "last_sent_at": None,
            "last_sent_account": None,
            "reply_received": False,
            "created_at": now,
        })
        added += 1
    _dm_write(DM_TARGETS_FILE, "targets", items)
    return jsonify({"added": added, "total": len(items)})


@app.route("/api/dm/targets/<tid>", methods=["PATCH"])
def api_dm_targets_patch(tid: str):
    payload = request.get_json(force=True)
    items = _dm_read(DM_TARGETS_FILE, "targets")
    t = next((x for x in items if x["id"] == tid), None)
    if not t:
        return jsonify({"error": "not found"}), 404
    for k in ("display_name", "category", "followers", "status", "notes", "reply_received"):
        if k in payload:
            v = payload[k]
            if k == "followers":
                v = int(v or 0)
            elif isinstance(v, str):
                v = v.strip()
            t[k] = v
    _dm_write(DM_TARGETS_FILE, "targets", items)
    return jsonify({"target": t})


@app.route("/api/dm/targets/<tid>", methods=["DELETE"])
def api_dm_targets_delete(tid: str):
    items = [t for t in _dm_read(DM_TARGETS_FILE, "targets") if t["id"] != tid]
    _dm_write(DM_TARGETS_FILE, "targets", items)
    return jsonify({"ok": True})


# ─── 템플릿 ──────────────────────────────────────────────
@app.route("/api/dm/templates", methods=["GET"])
def api_dm_templates_list():
    return jsonify({"templates": _dm_read(DM_TEMPLATES_FILE, "templates")})


@app.route("/api/dm/templates", methods=["POST"])
def api_dm_templates_add():
    payload = request.get_json(force=True)
    items = _dm_read(DM_TEMPLATES_FILE, "templates")
    new = {
        "id": _next_id(items, "t"),
        "name": (payload.get("name") or "").strip(),
        "brand_id": (payload.get("brand_id") or "").strip(),
        "sender_name": (payload.get("sender_name") or "").strip(),
        "body": (payload.get("body") or "").strip(),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    if not new["name"] or not new["body"]:
        return jsonify({"error": "name과 body 필수"}), 400
    items.append(new)
    _dm_write(DM_TEMPLATES_FILE, "templates", items)
    return jsonify({"template": new})


@app.route("/api/dm/templates/<tid>", methods=["PATCH"])
def api_dm_templates_patch(tid: str):
    payload = request.get_json(force=True)
    items = _dm_read(DM_TEMPLATES_FILE, "templates")
    t = next((x for x in items if x["id"] == tid), None)
    if not t:
        return jsonify({"error": "not found"}), 404
    for k in ("name", "brand_id", "sender_name", "body"):
        if k in payload:
            t[k] = (payload[k] or "").strip()
    _dm_write(DM_TEMPLATES_FILE, "templates", items)
    return jsonify({"template": t})


@app.route("/api/dm/templates/<tid>", methods=["DELETE"])
def api_dm_templates_delete(tid: str):
    items = [t for t in _dm_read(DM_TEMPLATES_FILE, "templates") if t["id"] != tid]
    _dm_write(DM_TEMPLATES_FILE, "templates", items)
    return jsonify({"ok": True})


# ─── 발송 작업 ────────────────────────────────────────────
DM_JOBS_STATE: dict[str, dict] = {}  # 메모리에 진행률 추적


def _select_available_account(accounts: list[dict]) -> dict | None:
    """발송 가능한 계정 선택 — 오늘 한도 안 차고, 활성 상태."""
    today = datetime.now().date().isoformat()
    candidates = []
    for a in accounts:
        if a.get("status") != "active":
            continue
        # 일일 카운트 리셋
        if a.get("last_reset_date") != today:
            a["daily_count"] = 0
            a["last_reset_date"] = today
        if a.get("daily_count", 0) >= a.get("daily_limit", 50):
            continue
        candidates.append(a)
    if not candidates:
        return None
    # 마지막 사용 시간 오래된 거 우선
    candidates.sort(key=lambda x: x.get("last_used_at") or "")
    return candidates[0]


@app.route("/api/dm/send", methods=["POST"])
def api_dm_send():
    """선택한 target들에게 DM 발송 시작."""
    payload = request.get_json(force=True)
    target_ids = payload.get("target_ids") or []
    template_id = payload.get("template_id")
    if not target_ids:
        return jsonify({"error": "target_ids 필수"}), 400
    if not template_id:
        return jsonify({"error": "template_id 필수"}), 400

    accounts = _dm_read(DM_ACCOUNTS_FILE, "accounts")
    if not [a for a in accounts if a.get("status") == "active"]:
        return jsonify({"error": "활성 계정 없음. 먼저 계정 풀에 등록."}), 400

    templates = _dm_read(DM_TEMPLATES_FILE, "templates")
    template = next((t for t in templates if t["id"] == template_id), None)
    if not template:
        return jsonify({"error": "템플릿 없음"}), 400

    targets = _dm_read(DM_TARGETS_FILE, "targets")
    selected = [t for t in targets if t["id"] in target_ids]
    if not selected:
        return jsonify({"error": "선택된 타겟 없음"}), 400

    # cloud 모드면 실제 발송 X — UI만 제공
    cfg = load_config()
    if cfg.get("env_mode") == "cloud":
        return jsonify({
            "error": "DM 발송은 로컬 PC에서만 가능. 클라우드 모드에서는 명단 관리만.",
            "note": "PC에서 워크스페이스 켜고 발송하세요."
        }), 400

    # 작업 ID 생성
    job_id = uuid.uuid4().hex[:12]
    DM_JOBS_STATE[job_id] = {
        "id": job_id,
        "status": "running",
        "total": len(selected),
        "sent": 0,
        "failed": 0,
        "current": None,
        "log": [],
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None,
    }

    def run():
        try:
            from dm_sender import DMSender  # type: ignore
            sender = DMSender(state=DM_JOBS_STATE[job_id], log_callback=_log_callback(job_id))
            sender.run_batch(
                targets=selected,
                template=template,
                accounts_file=str(DM_ACCOUNTS_FILE),
                targets_file=str(DM_TARGETS_FILE),
            )
            DM_JOBS_STATE[job_id]["status"] = "done"
            DM_JOBS_STATE[job_id]["finished_at"] = datetime.now().isoformat(timespec="seconds")
        except Exception as e:  # noqa: BLE001
            log.exception("DM send job failed")
            DM_JOBS_STATE[job_id]["status"] = "error"
            DM_JOBS_STATE[job_id]["log"].append(f"❌ 에러: {e}")
            DM_JOBS_STATE[job_id]["finished_at"] = datetime.now().isoformat(timespec="seconds")

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


def _log_callback(job_id: str):
    def cb(msg: str):
        if job_id in DM_JOBS_STATE:
            logs = DM_JOBS_STATE[job_id]["log"]
            logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            if len(logs) > 200:
                DM_JOBS_STATE[job_id]["log"] = logs[-200:]
    return cb


@app.route("/api/dm/jobs/<jid>", methods=["GET"])
def api_dm_job_status(jid: str):
    state = DM_JOBS_STATE.get(jid)
    if not state:
        return jsonify({"error": "not found"}), 404
    return jsonify(state)


@app.route("/api/dm/jobs/<jid>/stop", methods=["POST"])
def api_dm_job_stop(jid: str):
    state = DM_JOBS_STATE.get(jid)
    if state:
        state["status"] = "stopping"
    return jsonify({"ok": True})


def main():
    cfg = load_config()
    host = cfg.get("server", {}).get("host", "127.0.0.1")
    port = int(cfg.get("server", {}).get("port", 5000))

    # Cloudflare Tunnel 자동 시작 (로컬 모드에서만)
    auto_tunnel = cfg.get("tunnel", {}).get("auto_start", True)
    if cfg.get("env_mode") == "cloud":
        log.info("Cloud 모드 — Cloudflare Tunnel 건너뜀")
    elif auto_tunnel and TUNNEL_EXE.exists():
        log.info("Cloudflare Tunnel 자동 시작 중...")
        try:
            _start_tunnel()
        except Exception as e:
            log.warning(f"Tunnel 자동 시작 실패 (무시): {e}")

    log.info(f"서버 시작 → http://{host}:{port}")
    app.run(host=host, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
