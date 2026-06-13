"""
통합 DM 인박스.

전략:
  - 100+ 인스타 계정 각각에서 받은 DM을 한 곳(inbox_messages.json)에 모음
  - conversation 단위: (우리 계정 id, 셀러 instagram_id) 페어
  - 같은 셀러가 우리 다른 계정한테도 답장하면 → 다른 conversation
    (인플루언서 id 로 묶어서 표시는 가능 → UI 에서 그룹핑)

데이터 모델 (inbox_messages.json):
{
  "conversations": [
    {
      "id": "conv_{accountId}_{handle}",
      "our_account_id": "acc0003",
      "our_account_handle": "next_official",
      "their_handle": "thefashion_kr",
      "influencer_id": "inf00042",   # 매칭되면 채움
      "seller_name": "더패션",
      "messages": [
        {"ts": "2026-06-14T03:11:22", "from": "us"|"them", "text": "...", "read": true}
      ],
      "last_message_at": "...",
      "last_message_preview": "...",
      "unread_count": 0,
      "status": "active"
    }
  ],
  "schema_version": 1,
  "synced_at": ""
}
"""
from __future__ import annotations

from datetime import datetime


def _conv_id(account_id: str, their_handle: str) -> str:
    return f"conv_{account_id}_{their_handle.lower()}"


def _find_conv(conversations: list[dict], cid: str) -> dict | None:
    for c in conversations:
        if c.get("id") == cid:
            return c
    return None


def upsert_conversation(
    conversations: list[dict],
    our_account: dict,
    their_handle: str,
    influencer: dict | None = None,
) -> dict:
    """대화 record 가져오거나 생성."""
    cid = _conv_id(our_account["id"], their_handle)
    conv = _find_conv(conversations, cid)
    if conv:
        if influencer and not conv.get("influencer_id"):
            conv["influencer_id"] = influencer["id"]
            conv["seller_name"] = influencer.get("seller_name") or conv.get("seller_name")
        return conv

    conv = {
        "id": cid,
        "our_account_id": our_account["id"],
        "our_account_handle": our_account.get("instagram_id"),
        "their_handle": their_handle,
        "influencer_id": influencer["id"] if influencer else None,
        "seller_name": (influencer.get("seller_name") if influencer else "") or "",
        "messages": [],
        "last_message_at": None,
        "last_message_preview": "",
        "unread_count": 0,
        "status": "active",
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    conversations.append(conv)
    return conv


def append_message(conv: dict, sender: str, text: str, ts: str | None = None, read: bool = False) -> None:
    """conv에 메시지 추가. sender = 'us' | 'them'."""
    ts = ts or datetime.now().isoformat(timespec="seconds")
    msg = {"ts": ts, "from": sender, "text": text, "read": read}
    conv.setdefault("messages", []).append(msg)
    conv["last_message_at"] = ts
    conv["last_message_preview"] = text[:120]
    if sender == "them" and not read:
        conv["unread_count"] = (conv.get("unread_count") or 0) + 1
    if sender == "them":
        conv["status"] = "replied"


def mark_read(conv: dict) -> None:
    for m in conv.get("messages", []):
        m["read"] = True
    conv["unread_count"] = 0


def summarize(conversations: list[dict]) -> dict:
    by_status = {}
    unread_total = 0
    by_account = {}
    for c in conversations:
        s = c.get("status") or "active"
        by_status[s] = by_status.get(s, 0) + 1
        unread_total += c.get("unread_count") or 0
        h = c.get("our_account_handle") or "?"
        by_account[h] = by_account.get(h, 0) + 1
    return {
        "total": len(conversations),
        "by_status": by_status,
        "by_account": by_account,
        "unread_total": unread_total,
    }


def list_conversations(
    conversations: list[dict],
    *,
    q: str = "",
    only_unread: bool = False,
    account_id: str = "",
    page: int = 1,
    page_size: int = 50,
) -> dict:
    items = list(conversations)
    if account_id:
        items = [c for c in items if c.get("our_account_id") == account_id]
    if only_unread:
        items = [c for c in items if (c.get("unread_count") or 0) > 0]
    if q:
        ql = q.lower()
        items = [c for c in items
                 if ql in (c.get("their_handle") or "").lower()
                 or ql in (c.get("seller_name") or "").lower()
                 or ql in (c.get("last_message_preview") or "").lower()]
    items.sort(key=lambda c: c.get("last_message_at") or "", reverse=True)
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    page_items = items[start:end]
    # 메시지 본문은 리스트뷰에선 제외 (가벼움)
    light = [{k: v for k, v in c.items() if k != "messages"} for c in page_items]
    return {
        "conversations": light,
        "total": total,
        "page": page,
        "page_size": page_size,
    }
