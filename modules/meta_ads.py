"""
메타(페이스북) 마케팅 API — 광고 성과(insights) 조회.
토큰은 사용자가 직접 설정창에 입력 → data/meta_config.json(깃 제외)에만 저장.
앱은 토큰을 절대 코드/깃에 박지 않는다.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("meta_ads")

GRAPH_VER = "v21.0"
GRAPH = f"https://graph.facebook.com/{GRAPH_VER}"

# 조회 필드 (광고 성과)
_FIELDS = "campaign_name,adset_name,ad_name,spend,impressions,clicks,ctr,cpc,cpm,reach,purchase_roas,actions,action_values"


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _roas(row: dict) -> float:
    """purchase_roas는 [{action_type, value}] 형태."""
    pr = row.get("purchase_roas") or []
    for x in pr:
        if "purchase" in (x.get("action_type") or "") or x.get("action_type") == "omni_purchase":
            return _num(x.get("value"))
    return _num(pr[0].get("value")) if pr else 0.0


def _action(row: dict, *types: str) -> float:
    acts = row.get("actions") or []
    total = 0.0
    for a in acts:
        if a.get("action_type") in types:
            total += _num(a.get("value"))
    return total


def normalize(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        spend = _num(r.get("spend"))
        purchases = _action(r, "purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase")
        out.append({
            "campaign": r.get("campaign_name", ""),
            "adset": r.get("adset_name", ""),
            "ad": r.get("ad_name", ""),
            "spend": round(spend),
            "impressions": int(_num(r.get("impressions"))),
            "clicks": int(_num(r.get("clicks"))),
            "ctr": round(_num(r.get("ctr")), 2),
            "cpc": round(_num(r.get("cpc"))),
            "cpm": round(_num(r.get("cpm"))),
            "reach": int(_num(r.get("reach"))),
            "roas": round(_roas(r), 2),
            "purchases": int(purchases),
            "cpa": round(spend / purchases) if purchases else 0,
        })
    return out


def fetch_insights(token: str, account_id: str, date_preset: str = "last_7d",
                   level: str = "campaign") -> list[dict]:
    """광고계정 성과 조회. account_id는 'act_' 접두사 없어도 됨."""
    import requests
    if not token:
        raise ValueError("메타 액세스 토큰이 설정되지 않았습니다. 효율 분석 > 연결 설정에서 입력하세요.")
    if not account_id:
        raise ValueError("광고계정 ID가 필요합니다.")
    acct = account_id if str(account_id).startswith("act_") else f"act_{account_id}"
    level = level if level in ("account", "campaign", "adset", "ad") else "campaign"
    params = {
        "access_token": token,
        "level": level,
        "date_preset": date_preset or "last_7d",
        "fields": _FIELDS,
        "limit": 300,
    }
    try:
        r = requests.get(f"{GRAPH}/{acct}/insights", params=params, timeout=40)
        j = r.json()
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"메타 API 호출 실패: {e}")
    if isinstance(j, dict) and j.get("error"):
        err = j["error"]
        raise ValueError(f"메타 API 오류: {err.get('message', err)}")
    return normalize(j.get("data", []) if isinstance(j, dict) else [])


def verify_token(token: str) -> dict:
    """토큰 유효성 + 접근 가능한 광고계정 목록(이름·id) 확인."""
    import requests
    if not token:
        raise ValueError("토큰이 비어 있습니다.")
    try:
        r = requests.get(f"{GRAPH}/me/adaccounts",
                         params={"access_token": token, "fields": "account_id,name,currency", "limit": 200}, timeout=30)
        j = r.json()
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"메타 API 호출 실패: {e}")
    if isinstance(j, dict) and j.get("error"):
        raise ValueError(f"토큰 오류: {j['error'].get('message')}")
    accts = [{"id": a.get("account_id"), "name": a.get("name"), "currency": a.get("currency")}
             for a in (j.get("data") or [])]
    return {"ok": True, "accounts": accts}
