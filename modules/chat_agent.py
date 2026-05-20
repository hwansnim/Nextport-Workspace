"""
넥스트포트 워크스페이스 - AI 채팅 어시스턴트 (Function Calling 버전)

- Gemini 멀티턴 대화 + 이미지 입력
- 자동 도구 호출: 사용자 요청 들으면 캠페인/이벤트/미팅 데이터 직접 수정
- 다른 기능과 완전 격리됨 (제거 시 영향 0)
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

log = logging.getLogger("chat_agent")


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


# ─── 데이터 헬퍼 (격리됨, app.py 의존 X) ──────────────────
def _read(name: str, key: str) -> list[dict]:
    p = DATA / name
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8")).get(key, [])
    except Exception:
        return []


def _write(name: str, key: str, items: list[dict]) -> None:
    p = DATA / name
    p.write_text(json.dumps({key: items}, ensure_ascii=False, indent=2), encoding="utf-8")


def _next_id(items: list[dict], prefix: str) -> str:
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


def _brand_lookup(query: str) -> dict | None:
    if not query:
        return None
    q = query.strip().lower()
    for b in _read("brands.json", "brands"):
        if b["id"].lower() == q or b["name"].lower() == q or q in b["name"].lower():
            return b
    return None


# ═══════════════════════════════════════════════════════════
# 도구 함수들 — Gemini가 자동 호출 가능
# Docstring + type hint가 Gemini의 함수 이해에 사용됨.
# ═══════════════════════════════════════════════════════════

def list_campaigns(status_filter: str = "") -> dict:
    """진행중인/예정인 모든 셀러 캠페인 목록을 조회한다.

    Args:
        status_filter: 상태로 필터링 (선택). '예정', '준비중', '진행중', '완료', '미정' 중 하나. 비우면 전체.

    Returns:
        {"campaigns": [...], "count": N}
    """
    items = _read("campaigns.json", "campaigns")
    if status_filter:
        items = [c for c in items if c.get("status") == status_filter]
    # 간략 정보만 (토큰 절약)
    brief = [{
        "id": c["id"],
        "seller_name": c.get("seller_name", ""),
        "round": c.get("round", 1),
        "brand": c.get("brand", ""),
        "live_start": c.get("live_start", ""),
        "live_end": c.get("live_end", ""),
        "status": c.get("status", ""),
        "stage": c.get("stage", ""),
        "notes": c.get("notes", "")[:50],
    } for c in items]
    return {"campaigns": brief, "count": len(brief)}


def find_campaign(seller_name: str, round_number: int = 0) -> dict:
    """셀러 이름 (+ 선택: 차수) 으로 캠페인을 찾는다. 캠페인 수정 전에 ID 확인용.

    Args:
        seller_name: 셀러 이름. 부분 매칭. 예: '양미라', '지나', '윰니'
        round_number: 차수 (1, 2, 3...). 0이면 모든 차수.

    Returns:
        {"campaigns": [...], "count": N}
    """
    items = _read("campaigns.json", "campaigns")
    found = []
    for c in items:
        if seller_name in c.get("seller_name", ""):
            if round_number == 0 or c.get("round", 1) == round_number:
                found.append(c)
    return {"campaigns": found, "count": len(found)}


def add_campaign(
    seller_name: str,
    brand: str,
    round_number: int = 1,
    live_start: str = "",
    live_end: str = "",
    status: str = "예정",
    open_kind: str = "",
    notes: str = "",
) -> dict:
    """새 셀러 캠페인을 추가한다.

    Args:
        seller_name: 셀러 이름. 예: '양미라', '김희연'
        brand: 브랜드 이름 또는 ID. '하루픽스' / 'harufix' / '이브노프' / 'ivenoff' 등.
        round_number: 차수. 기본 1차.
        live_start: 라이브 시작일. YYYY-MM-DD 형식. 미정이면 빈 문자열.
        live_end: 라이브 종료일. YYYY-MM-DD 형식.
        status: 상태. '예정', '준비중', '진행중', '완료', '미정' 중 하나. 기본 '예정'.
        open_kind: 오픈 종류. '본사오픈' / '타사오픈' / 빈 문자열.
        notes: 메모.

    Returns:
        {"ok": True, "id": 새 ID, "message": "..."}
    """
    brand_obj = _brand_lookup(brand)
    if not brand_obj:
        return {"ok": False, "error": f"브랜드 '{brand}'를 못 찾았어. 'harufix' 또는 'ivenoff' 또는 정확한 브랜드명 줘."}

    items = _read("campaigns.json", "campaigns")
    new_id = _next_id(items, "c")
    now = datetime.now().isoformat(timespec="seconds")
    new = {
        "id": new_id,
        "seller_name": seller_name,
        "seller_handle": "",
        "seller_real_name": seller_name,
        "owner": "김동환",
        "brand": brand_obj["name"],
        "brand_id": brand_obj["id"],
        "product": "",
        "round": round_number,
        "contact_type": "direct",
        "stage": "contact",
        "live_start": live_start,
        "live_end": live_end,
        "open_kind": open_kind,
        "shipment": {"qty": 0, "date": ""},
        "sheet_url": "",
        "status": status,
        "notes": notes,
        "settlement": {},
        "financials": {},
        "created_at": now,
        "updated_at": now,
    }
    items.append(new)
    _write("campaigns.json", "campaigns", items)
    return {
        "ok": True,
        "id": new_id,
        "message": f"{seller_name} {round_number}차 ({brand_obj['name']}) 캠페인 추가됨",
    }


def update_campaign(
    campaign_id: str,
    seller_name: str = "",
    seller_handle: str = "",
    seller_real_name: str = "",
    brand: str = "",
    product: str = "",
    round_number: int = 0,
    stage: str = "",
    live_start: str = "",
    live_end: str = "",
    open_kind: str = "",
    sheet_url: str = "",
    status: str = "",
    notes: str = "",
) -> dict:
    """캠페인의 정보를 수정한다. 셀러 이름/인스타 핸들/일정/상태/단계/시트URL/메모 모두 이 함수로.

    Args:
        campaign_id: 캠페인 ID (예: 'c001'). 모르면 find_campaign으로 먼저 조회.
        seller_name: 새 셀러 이름 (변경 시).
        seller_handle: 인스타그램 핸들 (@ 빼고). 예: 'jbe_gini', 'jjinalgoo'.
        seller_real_name: 실명.
        brand: 브랜드 이름 또는 ID. 'harufix' / '하루픽스' / 'ivenoff' / '이브노프'.
        product: 제품명.
        round_number: 차수. 0이면 변경 안 함.
        stage: 진행 단계. contact/confirmed/shipped/received/sheet_drafted/sheet_confirmed/live/complete.
        live_start: 라이브 시작일 (YYYY-MM-DD).
        live_end: 라이브 종료일.
        open_kind: '본사오픈' / '타사오픈'.
        sheet_url: 스케줄링 시트 URL.
        status: 상태. '예정'/'준비중'/'진행중'/'완료'/'미정'.
        notes: 메모.

    빈 문자열 / 0 인 인자는 변경하지 않음. 변경할 필드만 채워서 호출.

    Returns:
        {"ok": True, "campaign_id": "...", "updated_fields": [...]}
    """
    items = _read("campaigns.json", "campaigns")
    c = next((x for x in items if x["id"] == campaign_id), None)
    if not c:
        return {"ok": False, "error": f"캠페인 {campaign_id}를 못 찾았어"}

    updates = {
        "seller_name": seller_name,
        "seller_handle": seller_handle.lstrip("@") if seller_handle else "",
        "seller_real_name": seller_real_name,
        "product": product,
        "stage": stage,
        "live_start": live_start,
        "live_end": live_end,
        "open_kind": open_kind,
        "sheet_url": sheet_url,
        "status": status,
        "notes": notes,
    }
    updated_fields = []
    for k, v in updates.items():
        if v:
            c[k] = v
            updated_fields.append(k)
    if round_number and round_number > 0:
        c["round"] = round_number
        updated_fields.append("round")
    if brand:
        b = _brand_lookup(brand)
        if b:
            c["brand"] = b["name"]
            c["brand_id"] = b["id"]
            updated_fields.append("brand")
    c["updated_at"] = datetime.now().isoformat(timespec="seconds")
    _write("campaigns.json", "campaigns", items)
    return {
        "ok": True,
        "campaign_id": campaign_id,
        "updated_fields": updated_fields,
        "message": f"{c.get('seller_name','')} {c.get('round',1)}차 — {', '.join(updated_fields) or '변경 없음'}",
    }


def add_calendar_event(
    date: str,
    title: str,
    kind: str = "other",
    time_str: str = "",
    notes: str = "",
) -> dict:
    """캘린더에 단일 이벤트를 추가한다 (미팅/발송/마감/기타).

    Args:
        date: 날짜 (YYYY-MM-DD).
        title: 이벤트 제목. 예: '양미라 미팅', '제품 발송'.
        kind: 종류. 'meeting'(미팅), 'shipment'(발송), 'deadline'(마감), 'other'(기타).
        time_str: 시간 (HH:MM, 선택).
        notes: 메모.

    Returns:
        {"ok": True, "id": "..."}
    """
    items = _read("events.json", "events")
    new_id = _next_id(items, "e")
    new = {
        "id": new_id,
        "date": date,
        "time": time_str,
        "kind": kind,
        "title": title,
        "ref_id": "",
        "ref_kind": "",
        "color": "",
        "notes": notes,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    items.append(new)
    _write("events.json", "events", items)
    return {"ok": True, "id": new_id, "message": f"이벤트 추가: {date} {title}"}


def add_meeting(
    title: str,
    date: str = "",
    time_str: str = "",
    campaign_id: str = "",
    attendees_csv: str = "",
    agenda: str = "",
) -> dict:
    """새 미팅을 추가한다 (녹취 분석 + 메모용).

    Args:
        title: 미팅 제목.
        date: 미팅 날짜 (YYYY-MM-DD).
        time_str: 시간 (HH:MM).
        campaign_id: 연관 캠페인 ID (선택).
        attendees_csv: 참석자, 쉼표로 구분. 예: '김동환, 양미라'.
        agenda: 안건.

    Returns:
        {"ok": True, "id": "..."}
    """
    items = _read("meetings.json", "meetings")
    new_id = _next_id(items, "m")
    attendees = [s.strip() for s in (attendees_csv or "").split(",") if s.strip()]
    now = datetime.now().isoformat(timespec="seconds")
    new = {
        "id": new_id,
        "campaign_id": campaign_id,
        "title": title or "(제목 없음)",
        "date": date,
        "time": time_str,
        "attendees": attendees,
        "agenda": agenda,
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
    _write("meetings.json", "meetings", items)
    return {"ok": True, "id": new_id, "message": f"미팅 추가: {title}"}


def list_brands() -> dict:
    """등록된 모든 브랜드 목록을 조회한다 (캠페인 추가 전 브랜드 ID 확인용)."""
    return {"brands": _read("brands.json", "brands")}


def get_today_summary() -> dict:
    """오늘 / 이번 주 / 지연된 일정 요약 — 사용자가 '뭐 해야 해?' 물을 때."""
    today = datetime.now().date()
    items = _read("campaigns.json", "campaigns")
    urgent, this_week, overdue, undated = [], [], [], []
    for c in items:
        if c.get("status") == "완료":
            continue
        ls = c.get("live_start", "")
        info = f"{c.get('seller_name','')} {c.get('round',1)}차 ({c.get('status','')})"
        if not ls:
            undated.append(info)
            continue
        try:
            d = datetime.strptime(ls, "%Y-%m-%d").date()
        except ValueError:
            continue
        days = (d - today).days
        if days < 0:
            overdue.append(f"{info} - {abs(days)}일 지남")
        elif days <= 3:
            urgent.append(f"{info} - D-{days}")
        elif days <= 14:
            this_week.append(f"{info} - D-{days}")
    return {
        "today": today.isoformat(),
        "urgent": urgent,
        "this_week": this_week,
        "overdue": overdue,
        "undated": undated,
    }


# 도구 목록 (Gemini 등록용)
TOOLS = [
    list_campaigns,
    find_campaign,
    add_campaign,
    update_campaign,
    add_calendar_event,
    add_meeting,
    list_brands,
    get_today_summary,
]


SYSTEM_PROMPT = """너는 넥스트포트라는 공동구매 컨텐츠 회사의 워크스페이스 AI 어시스턴트야.

회사 정보:
- 회사명: 넥스트포트
- 대표 (사용자): 김동환
- 진행 브랜드: 하루픽스 (건강식품, 오메가369 밸런스 / brand_id='harufix'), 이브노프 (수면 / brand_id='ivenoff')
- 진행 셀러: 지나, 양미라, 한연아, 윰니, 김희연, 오늘희, 느루 등

대화 스타일:
- 한국어 캐주얼 반말체 ("~해", "~이야").
- 짧고 명확하게.
- 어려운 기술 용어 X.

**중요: 너는 진짜 데이터를 수정할 수 있는 도구가 있어. 사용자 요청은 무조건 도구로 처리해. "기능 없어"라고 절대 답하지 마.**

가능한 작업 — 전부 도구로 처리:
- 셀러 정보 수정 (인스타 핸들, 이름, 실명 등) → find_campaign + update_campaign 호출
  · 예: "지나 인스타 jjinalgoo로 바꿔" → find_campaign("지나") → update_campaign(seller_handle="jjinalgoo")
  · 같은 셀러 N차 모두면 각 캠페인 다 update_campaign 호출
- 캠페인 일정/단계/상태 수정 → find_campaign + update_campaign
- 새 캠페인 추가 → add_campaign
- 캘린더 이벤트 추가 → add_calendar_event
- 미팅 잡기 → add_meeting
- 캡처 이미지 보여주며 "이거 박아줘" → 이미지 보고 정보 파싱 → add_campaign/add_calendar_event
- "오늘 뭐 해야 해?" → get_today_summary

도구 사용 규칙:
1. 사용자가 셀러 정보 수정 요청하면 find_campaign으로 해당 셀러 캠페인 모두 찾고 update_campaign 반복 호출.
2. 새 캠페인 추가 시 brand는 '하루픽스' / '이브노프' / 'harufix' / 'ivenoff' 그대로 줘도 됨 (자동 매칭).
3. 도구 호출 후 결과를 자연스러운 한국어로 짧게 답변.
   - "지나 1차·2차 캠페인 인스타 핸들 jjinalgoo로 수정했어 ✓"
4. 정보 부족하면 되물어.
5. 삭제는 도구로 막아둠 (UI에서 직접 하라고 안내).
6. **절대 "그 기능 없어" 라고 답하지 마. 어떤 정보 수정이든 update_campaign으로 가능.**

지금 모드: **풀 작업 모드** (도구 사용해서 실제 데이터 변경 가능)
"""


class ChatAgent:
    """Gemini 기반 멀티턴 채팅 + 자동 함수 호출."""

    def __init__(self, config: dict[str, Any]):
        import google.generativeai as genai

        api_key = (config.get("gemini") or {}).get("api_key", "").strip()
        if not api_key or api_key.startswith("여기에"):
            raise ValueError("Gemini API key 미설정")

        self.genai = genai
        self.model_name = (
            (config.get("gemini") or {}).get("chat_model")
            or "gemini-2.5-flash"
        )
        genai.configure(api_key=api_key)
        # tools 등록한 모델
        self.model = genai.GenerativeModel(
            self.model_name,
            system_instruction=SYSTEM_PROMPT,
            tools=TOOLS,
            generation_config={
                "temperature": 0.4,
                "max_output_tokens": 4096,
            },
        )

    def send(
        self,
        history: list[dict],
        text: str,
        *,
        image_bytes: bytes | None = None,
        image_mime: str = "image/png",
    ) -> dict:
        """멀티턴 + 자동 도구 호출. 반환: {'text': 답변, 'tool_calls': [...]}."""
        chat = self.model.start_chat(
            history=history,
            enable_automatic_function_calling=True,
        )
        history_len_before = len(chat.history)

        parts = []
        if image_bytes:
            parts.append({"mime_type": image_mime, "data": image_bytes})
        if text:
            parts.append(text)
        if not parts:
            parts.append("(빈 메시지)")

        try:
            resp = chat.send_message(parts)
        except Exception as e:  # noqa: BLE001
            err = str(e)
            if "429" in err and "flash" not in self.model_name:
                log.warning(f"{self.model_name} 쿼터 초과 → flash 재시도")
                self.model_name = "gemini-2.5-flash"
                self.model = self.genai.GenerativeModel(
                    self.model_name, system_instruction=SYSTEM_PROMPT, tools=TOOLS
                )
                chat = self.model.start_chat(
                    history=history,
                    enable_automatic_function_calling=True,
                )
                history_len_before = len(chat.history)
                resp = chat.send_message(parts)
            else:
                raise

        # 호출된 도구 추출 (history_len_before 이후 model 턴에서)
        tool_calls = []
        for content in chat.history[history_len_before:]:
            if getattr(content, "role", None) == "model":
                for part in getattr(content, "parts", []):
                    fc = getattr(part, "function_call", None)
                    if fc and getattr(fc, "name", None):
                        try:
                            args = dict(fc.args) if fc.args else {}
                        except Exception:
                            args = {}
                        tool_calls.append({"name": fc.name, "args": args})

        return {
            "text": (resp.text or "").strip() or "(응답 없음)",
            "tool_calls": tool_calls,
        }
