"""
DM 발송 스케줄러.

규칙:
  - 차수(send_count) <= 10
  - 마지막 발송 후 7일 이상 경과 (또는 미발송)
  - 같은 인플루언서한테는 매번 다른 계정 사용 (used_account_ids 누적)
  - 상태가 답장받음/컨펌/거절/비공개면 자동 제외
  - 활성 계정 중 daily_limit 안 찬 계정만 후보
  - 차단/사람인증/휴식 계정은 제외
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

MIN_INTERVAL_DAYS = 7
MAX_SEND_COUNT = 10
EXCLUDED_INFLUENCER_STATUSES = {"답장받음", "컨펌", "거절", "비공개"}
SENDABLE_ACCOUNT_STATUS = {"활성"}


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _days_since(date_str: str) -> int:
    """YYYY-MM-DD → 오늘과의 일수 차. 빈값이면 매우 큰 값(=항상 가능)."""
    if not date_str:
        return 99999
    try:
        d = datetime.strptime(date_str[:10], "%Y-%m-%d")
        return (datetime.now() - d).days
    except (ValueError, TypeError):
        return 99999


def _account_available(acc: dict) -> bool:
    if acc.get("status") not in SENDABLE_ACCOUNT_STATUS:
        return False
    # 일일 한도 체크 (today 가 다르면 리셋된 것으로 간주)
    today = _today()
    if acc.get("daily_reset_date") != today:
        return True  # 새로운 날 → 0건
    sent = acc.get("daily_sent_today", 0)
    limit = acc.get("daily_limit", 50)
    return sent < limit


def _pick_account_for(influencer: dict, accounts: list[dict]) -> Optional[dict]:
    """이 인플루언서한테 보낼 수 있는 계정 1개 추천.
    - used_account_ids 에 없는 계정 우선
    - 활성 + daily_limit 안 찬 것
    - last_used_at 오래된 순서로 (사용 빈도 분산)
    """
    used = set(influencer.get("used_account_ids") or [])
    candidates = [a for a in accounts
                  if a.get("id") not in used
                  and _account_available(a)]
    if not candidates:
        return None
    # last_used_at 오래된 (또는 없는) 계정 우선
    candidates.sort(key=lambda a: a.get("last_used_at") or "")
    return candidates[0]


def build_queue(
    influencers: list[dict],
    accounts: list[dict],
    max_per_run: int = 100,
) -> dict:
    """오늘 발송 가능한 (인플루언서, 추천계정) 페어 산출."""
    queue = []
    reasons = {
        "ok": 0,
        "excluded_status": 0,
        "max_count_reached": 0,
        "too_recent": 0,
        "no_account": 0,
    }
    # 일일 한도 시뮬레이션용 카운터
    daily_counter = {a["id"]: a.get("daily_sent_today", 0) if a.get("daily_reset_date") == _today() else 0
                     for a in accounts}

    for inf in influencers:
        if inf.get("status") in EXCLUDED_INFLUENCER_STATUSES:
            reasons["excluded_status"] += 1
            continue
        if (inf.get("send_count") or 0) >= MAX_SEND_COUNT:
            reasons["max_count_reached"] += 1
            continue
        if _days_since(inf.get("last_sent_date", "")) < MIN_INTERVAL_DAYS:
            reasons["too_recent"] += 1
            continue

        # 계정 선택 (사용된 계정 + 일일 한도 시뮬레이션 반영)
        used = set(inf.get("used_account_ids") or [])
        sim_accounts = []
        for a in accounts:
            if a.get("id") in used:
                continue
            if a.get("status") not in SENDABLE_ACCOUNT_STATUS:
                continue
            if daily_counter.get(a["id"], 0) >= a.get("daily_limit", 50):
                continue
            sim_accounts.append(a)
        if not sim_accounts:
            reasons["no_account"] += 1
            continue
        sim_accounts.sort(key=lambda a: a.get("last_used_at") or "")
        picked = sim_accounts[0]
        daily_counter[picked["id"]] = daily_counter.get(picked["id"], 0) + 1

        queue.append({
            "influencer_id": inf["id"],
            "influencer_handle": inf.get("instagram_id"),
            "seller_name": inf.get("seller_name"),
            "next_send_count": (inf.get("send_count") or 0) + 1,
            "last_sent_date": inf.get("last_sent_date", ""),
            "days_since_last": _days_since(inf.get("last_sent_date", "")),
            "account_id": picked["id"],
            "account_handle": picked.get("instagram_id"),
        })
        reasons["ok"] += 1
        if len(queue) >= max_per_run:
            break

    return {
        "queue": queue,
        "reasons": reasons,
        "max_send_count": MAX_SEND_COUNT,
        "min_interval_days": MIN_INTERVAL_DAYS,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def record_send(
    influencer: dict,
    account: dict,
    message: str,
    status: str = "ok",
    note: str = "",
) -> dict:
    """발송 결과를 인플루언서 + 계정 레코드에 반영. 호출자가 _save_* 책임."""
    today = _today()
    now = datetime.now().isoformat(timespec="seconds")

    # 인플루언서
    influencer["send_count"] = (influencer.get("send_count") or 0) + 1
    influencer["last_sent_date"] = today
    influencer["last_sent_account_id"] = account.get("instagram_id") or account.get("id")
    influencer.setdefault("used_account_ids", []).append(account["id"])
    influencer.setdefault("history", []).append({
        "date": today,
        "timestamp": now,
        "account_id": account["id"],
        "account_handle": account.get("instagram_id"),
        "message_preview": message[:120],
        "status": status,
        "note": note,
        "send_count": influencer["send_count"],
    })
    if status == "ok":
        influencer["status"] = f"{influencer['send_count']}차완료"

    # 계정
    if account.get("daily_reset_date") != today:
        account["daily_sent_today"] = 0
        account["daily_reset_date"] = today
    account["daily_sent_today"] = (account.get("daily_sent_today") or 0) + 1
    account["total_sent"] = (account.get("total_sent") or 0) + 1
    account["last_used_at"] = now

    return {"ok": True, "send_count": influencer["send_count"]}
