"""
콘텐츠 스케줄 생성 (셀러 톤 학습 + 입력 기반).

핵심:
  - 자동 생성 X → 제품 정보 + 소구점(셀링포인트) + 길이 설정을 받아야 생성
  - 셀러 본인 인스타 톤 학습:
      1순위) 셀러 아카이브 manifest 의 ocr_text/alt_text/캡션 샘플
      2순위) 샘플 없으면 generic 친근 톤
  - Gemini 1콜로 전체 스케줄 생성 (날짜별 STORY 1~5 + 피드) → 톤 일관 + 빠름
  - 이미지는 아카이브 manifest 에서 story_slot_fit 매칭 (Gemini 재호출 X)

복붙 퀄리티가 목표 — 셀러가 그대로 올리면 되는 수준.
"""
from __future__ import annotations

import json
import logging
import random
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

log = logging.getLogger("content_gen")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

LENGTH_GUIDE = {
    "short": "20~45자 매우 짧게. 한 호흡에 읽히게.",
    "medium": "50~90자. 2~3문장.",
    "long": "100~160자. 스토리텔링 있게 길게.",
}

PHASE_GOAL = {
    "도입": "아직 제품 언급 X. 일상/변화 암시로 호기심 유발. '뭔가 달라졌네?' 느낌.",
    "교감": "팔로워와 소통. DM/댓글 반응 언급. 곧 공유할 거라는 기대감.",
    "정보": "제품 정보 본격 공개. 성분/효능/비교/FAQ. 신뢰 구축.",
    "임박": "공구 오픈! 강한 CTA. 링크/마감 임박 강조.",
    "마감": "후기 인증 + 재구매 + 마감 카운트다운.",
}


def _load_seller_tone_samples(handle: str, sellers_path: Path, archive_root: Path, limit: int = 25) -> list[str]:
    """셀러 본인 아카이브 manifest 에서 톤 샘플(실제 올렸던 텍스트) 추출."""
    samples: list[str] = []
    if not handle:
        return samples
    try:
        sellers = json.loads(sellers_path.read_text(encoding="utf-8")).get("sellers", [])
    except Exception:
        sellers = []
    seller = next((s for s in sellers if (s.get("instagram") or "").lower() == handle.lower()), None)
    if not seller:
        return samples
    folder = f"{seller['id']}.{seller['name']}_@{seller['instagram']}"
    manifest_path = archive_root / folder / "_manifest.json"
    if not manifest_path.exists():
        return samples
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return samples
    for it in data.get("items", []):
        txt = (it.get("ocr_text") or "").strip()
        if txt and len(txt) > 8:
            samples.append(txt[:200])
        if len(samples) >= limit:
            break
    return samples


def _pick_image(slot_concept_key: str, manifests_items: list[dict], used: set, fallback_pool: list[dict]) -> dict | None:
    """슬롯에 어울리는 이미지 1개 (story_slot_fit 점수 기반)."""
    pool = manifests_items or fallback_pool
    candidates = []
    for it in pool:
        if it.get("_uid") in used:
            continue
        if it.get("media") != "image":
            continue
        fit = it.get("story_slot_fit", {}) or {}
        score = max(fit.values()) if fit else (0.3 + random.random() * 0.2)
        candidates.append((score, it))
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0] + random.random() * 0.15, reverse=True)
    return candidates[0][1]


def _gather_archive_images(reference_handles: list[str], sellers_path: Path, archive_root: Path) -> list[dict]:
    """참고/본인 셀러들의 아카이브 이미지 풀 (image-serving URL 포함)."""
    out = []
    try:
        sellers = json.loads(sellers_path.read_text(encoding="utf-8")).get("sellers", [])
    except Exception:
        return out
    for s in sellers:
        h = (s.get("instagram") or "").lower()
        if reference_handles and h not in [x.lower() for x in reference_handles]:
            continue
        folder = f"{s['id']}.{s['name']}_@{s['instagram']}"
        manifest_path = archive_root / folder / "_manifest.json"
        if not manifest_path.exists():
            continue
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for it in data.get("items", []):
            if it.get("media") != "image" or not it.get("file_path"):
                continue
            it = dict(it)
            it["_uid"] = f"{folder}::{it.get('id')}"
            it["_folder"] = folder
            it["_img_url"] = f"/archive-img/{folder}/{it['file_path']}"
            it["_source"] = f"@{s['instagram']}"
            out.append(it)
    return out


def _build_prompt(product: dict, selling_points: list[str], tone_samples: list[str],
                  length: str, days_skeleton: list[dict]) -> str:
    sp = "\n".join(f"  {i+1}. {p}" for i, p in enumerate(selling_points)) or "  (지정 없음 — 제품 USP 기반 자유)"
    tone_block = ""
    if tone_samples:
        joined = "\n".join(f"  · {t}" for t in tone_samples[:20])
        tone_block = f"""[셀러가 실제 올렸던 글 — 이 말투/어조/이모지 습관을 그대로 흉내내]
{joined}

위 샘플의 문체(반말/존댓말, 이모지 빈도, 줄임말, 감탄사 습관)를 최대한 똑같이 따라해."""
    else:
        tone_block = "[셀러 톤 샘플 없음] → 30대 여성 인플루언서의 친근하고 진솔한 톤으로. 광고티 X."

    skeleton_lines = []
    for d in days_skeleton:
        skeleton_lines.append(f'  {{"date":"{d["date"]}","weekday":"{d["weekday"]}","d_label":"{d["d_label"]}","phase":"{d["phase"]}"}}')
    skeleton = "[\n" + ",\n".join(skeleton_lines) + "\n]"

    return f"""너는 인스타 공동구매 인플루언서의 콘텐츠를 대신 써주는 최고의 카피라이터야.
셀러(인플루언서)가 네가 쓴 글을 **그대로 복사 붙여넣기** 해서 스토리에 올릴 거야. 바로 쓸 수 있는 완성된 퀄리티여야 해.

[제품 정보]
- 제품명: {product.get('name','')}
- USP/핵심: {product.get('usp','')}
- 상세 설명: {product.get('detail','')}
- 가격/혜택: {product.get('price','')}
- 절대 쓰면 안 되는 표현(과장/의학적 단정 등): {product.get('avoid','없음')}

[이번 공구에서 밀 소구점 (순서대로 강조)]
{sp}

{tone_block}

[글 길이] {LENGTH_GUIDE.get(length, LENGTH_GUIDE['medium'])}

[날짜별 단계]
- 도입: {PHASE_GOAL['도입']}
- 교감: {PHASE_GOAL['교감']}
- 정보: {PHASE_GOAL['정보']}
- 임박: {PHASE_GOAL['임박']}
- 마감: {PHASE_GOAL['마감']}

[생성할 날짜 스켈레톤]
{skeleton}

[작업]
각 날짜마다 STORY 1~5 (5개) + 피드 1개 = 6개 슬롯의 콘텐츠를 만들어.
- 각 슬롯: concept(소구점/제목 한 줄) + caption(셀러가 그대로 올릴 완성된 스토리 문구)
- 날짜의 phase 단계 목적에 맞게.
- 하루 안에서 STORY 1~5는 서로 다른 앵글 (일상→반응→비교→정보→공유 흐름).
- 피드는 그날의 메인 게시물 (좀 더 정제된 톤).
- 소구점을 날짜 전반에 자연스럽게 분배해서 반복 노출.

반드시 아래 JSON 스키마로만 출력 (다른 설명/마크다운 X):
{{
  "days": [
    {{
      "date": "YYYY-MM-DD",
      "slots": [
        {{"title":"STORY 1","concept":"...","caption":"..."}},
        {{"title":"STORY 2","concept":"...","caption":"..."}},
        {{"title":"STORY 3","concept":"...","caption":"..."}},
        {{"title":"STORY 4","concept":"...","caption":"..."}},
        {{"title":"STORY 5","concept":"...","caption":"..."}},
        {{"title":"게시물 (피드)","concept":"...","caption":"..."}}
      ]
    }}
  ]
}}
"""


def _make_days_skeleton(start_date: str, end_date: str = "") -> list[dict]:
    sd = datetime.strptime(start_date[:10], "%Y-%m-%d")
    ed = datetime.strptime(end_date[:10], "%Y-%m-%d") if end_date else sd + timedelta(days=4)
    weekday_kr = ["월", "화", "수", "목", "금", "토", "일"]
    days = []
    post_days = max(0, (ed - sd).days)
    for offset in range(-10, post_days + 2):
        d = sd + timedelta(days=offset)
        if offset < 0:
            d_label = f"D-{-offset}"
            phase = "정보" if offset >= -3 else ("교감" if offset >= -6 else "도입")
        elif offset == 0:
            d_label, phase = "D-day", "임박"
        else:
            d_label, phase = f"D+{offset}", "마감"
        days.append({
            "date": d.strftime("%Y-%m-%d"),
            "weekday": weekday_kr[d.weekday()],
            "d_label": d_label,
            "phase": phase,
        })
    return days


def _parse_gemini_json(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*", "", text).strip().rstrip("`").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        end = text.rfind("}")
        if end >= 0:
            return json.loads(text[:end + 1])
        raise


def generate_content_schedule(
    *,
    seller_handle: str,
    product: dict,
    selling_points: list[str],
    length: str,
    start_date: str,
    end_date: str,
    config: dict,
    reference_handles: list[str] | None = None,
    attach_images: bool = True,
) -> dict:
    """입력 기반 콘텐츠 스케줄 생성. content_days 리스트 반환."""
    sellers_path = PROJECT_ROOT / "data" / "sellers.json"
    archive_root = PROJECT_ROOT / "data" / "local_archive"

    skeleton = _make_days_skeleton(start_date, end_date)
    tone_samples = _load_seller_tone_samples(seller_handle, sellers_path, archive_root)

    # ─── Gemini 1콜 생성 ───
    gemini_ok = False
    gen_days = {}
    try:
        import google.generativeai as genai
        api_key = (config.get("gemini", {}) or {}).get("api_key", "")
        if api_key and not api_key.startswith("여기에"):
            genai.configure(api_key=api_key)
            cfg_model = (config.get("gemini", {}) or {}).get("caption_model") \
                or (config.get("gemini", {}) or {}).get("model") or ""
            # 죽은 모델(gemini-2.0-flash-exp 등)이면 최신으로 교체. 후보 순서대로 시도.
            DEAD = ("gemini-2.0-flash-exp", "gemini-pro", "gemini-1.0-pro", "gemini-1.5-flash")
            candidates = []
            if cfg_model and cfg_model not in DEAD:
                candidates.append(cfg_model)
            candidates += ["gemini-2.5-flash", "gemini-2.0-flash"]
            prompt = _build_prompt(product, selling_points, tone_samples, length, skeleton)
            last_err = None
            for mn in candidates:
                try:
                    model = genai.GenerativeModel(mn)
                    resp = model.generate_content(
                        prompt,
                        generation_config={"response_mime_type": "application/json", "max_output_tokens": 32768},
                    )
                    parsed = _parse_gemini_json(resp.text or "")
                    for d in parsed.get("days", []):
                        gen_days[d.get("date")] = d.get("slots", [])
                    if gen_days:
                        log.info(f"content_gen: model={mn} 성공")
                        break
                except Exception as me:  # noqa: BLE001
                    last_err = me
                    log.warning(f"content_gen: model={mn} 실패 → 다음 후보. ({me})")
                    continue
            gemini_ok = bool(gen_days)
            if not gemini_ok and last_err:
                log.warning(f"content_gen: 모든 모델 실패: {last_err}")
    except Exception as e:  # noqa: BLE001
        log.warning(f"Gemini 생성 실패 — 빈 슬롯으로 fallback: {e}")

    # ─── 이미지 풀 ───
    img_pool = []
    if attach_images:
        refs = reference_handles or ([seller_handle] if seller_handle else [])
        # 본인 + 참고 셀러 둘 다 풀에 넣되, 본인 우선
        own = _gather_archive_images([seller_handle] if seller_handle else [], sellers_path, archive_root)
        ref = _gather_archive_images(reference_handles or [], sellers_path, archive_root)
        img_pool = own + ref

    used_imgs = set()
    default_titles = ["STORY 1", "STORY 2", "STORY 3", "STORY 4", "STORY 5", "게시물 (피드)"]

    content_days = []
    for sk in skeleton:
        gen_slots = gen_days.get(sk["date"], [])
        slots = []
        for i in range(6):
            g = gen_slots[i] if i < len(gen_slots) else {}
            img = _pick_image(default_titles[i], img_pool, used_imgs, img_pool) if attach_images else None
            if img:
                used_imgs.add(img["_uid"])
            slots.append({
                "type": "feed" if i == 5 else "story",
                "title": default_titles[i],
                "concept": g.get("concept", ""),
                "caption": g.get("caption", ""),
                "image_url": img["_img_url"] if img else "",
                "image_source": img.get("_source", "") if img else "",
                "image_alt": (img.get("alt_text", "") if img else "")[:120],
                "posted": False,
                "posted_at": "",
                "live_url": "",
            })
        content_days.append({
            "date": sk["date"],
            "weekday": sk["weekday"],
            "d_label": sk["d_label"],
            "phase": sk["phase"],
            "slots": slots,
        })

    return {
        "content_days": content_days,
        "gemini_used": gemini_ok,
        "tone_samples_count": len(tone_samples),
        "images_attached": len(used_imgs),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
