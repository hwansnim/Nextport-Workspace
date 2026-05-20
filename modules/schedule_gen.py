"""
스케줄링 시트 생성기
- manifest.json 에서 참고 셀럽 콘텐츠 매칭
- Gemini로 STORY 1~5 캡션 생성
- Google Sheets 또는 로컬 HTML/JSON으로 출력
"""
from __future__ import annotations

import json
import logging
import random
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("schedule_gen")

PROGRESS_CB = Callable[..., None]


# 모범 시트 기본 STORY 슬롯 분류
STORY_SLOTS = [
    ("STORY1_일상노출", "일상 자연 노출 (식단/운동/아침 루틴 등 — 제품 없이도 OK)"),
    ("STORY2_고객반응", "고객 후기/반응/경험 (DM·댓글 캡처 등)"),
    ("STORY3_비포애프터", "변화 비교, 전후 사진, 결과 인증"),
    ("STORY4_효능증명", "성분/데이터/인포그래픽/카드뉴스"),
    ("STORY5_공유어필", "공구 알림, 마음 공유, 추천 멘트"),
]


def _load_seller_manifests(reference_seller_ids: list[str], project_root: Path) -> list[dict[str, Any]]:
    """참고 셀럽들의 manifest 모두 로드."""
    sellers_data = json.loads((project_root / "data" / "sellers.json").read_text(encoding="utf-8"))
    out = []
    for sid in reference_seller_ids:
        s = next((x for x in sellers_data["sellers"] if x["id"] == sid), None)
        if not s:
            continue
        folder = f"{s['id']}.{s['name']}_@{s['instagram']}"
        manifest_path = project_root / "data" / "local_archive" / folder / "_manifest.json"
        if not manifest_path.exists():
            continue
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            data["_seller"] = s
            data["_folder"] = folder
            out.append(data)
        except Exception as e:  # noqa: BLE001
            log.warning(f"manifest read failed: {e}")
    return out


def _pick_image_for_slot(
    slot_name: str,
    sellers_manifests: list[dict[str, Any]],
    used_ids: set[str],
) -> dict[str, Any] | None:
    """슬롯에 가장 잘 어울리는 이미지 1개 선택."""
    candidates = []
    for m in sellers_manifests:
        for it in m.get("items", []):
            if it.get("id") in used_ids:
                continue
            if it.get("media") != "image":
                continue
            score = it.get("story_slot_fit", {}).get(slot_name, 0)
            # Gemini 태깅 안 된 경우 fallback: 그냥 랜덤 후보
            if not it.get("story_slot_fit"):
                score = 0.3 + random.random() * 0.2
            candidates.append((score, it, m))
    if not candidates:
        return None
    # 점수 + 약간의 랜덤성
    candidates.sort(key=lambda x: x[0] + random.random() * 0.1, reverse=True)
    return {
        "item": candidates[0][1],
        "manifest": candidates[0][2],
    }


def _gen_caption(
    slot_name: str,
    slot_desc: str,
    product: dict[str, Any],
    target_seller: dict[str, Any],
    day_index: int,
    config: dict[str, Any],
) -> str:
    """Gemini로 캡션 생성."""
    try:
        import google.generativeai as genai
        api_key = config.get("gemini", {}).get("api_key", "")
        if not api_key or api_key.startswith("여기에"):
            return f"[{slot_name}] (Gemini 키 없음 — 직접 작성 필요)"
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(config.get("gemini", {}).get("model", "gemini-2.0-flash-exp"))
        prompt = f"""너는 인스타 공동구매 인플루언서의 톤으로 짧고 자연스러운 스토리 캡션을 작성하는 카피라이터야.

[제품 정보]
- 제품명: {product.get('name', '')}
- USP: {product.get('usp', '')}
- 상세: {product.get('detail', '')}
- 가격/혜택: {product.get('price', '')}
- 금지 멘트: {product.get('avoid', '')}

[대상 셀러] {target_seller.get('name', '')} (@{target_seller.get('instagram', '')})

[슬롯] {slot_name}
[슬롯 설명] {slot_desc}
[D-day index] {day_index}일차

조건:
- 30~80자 한국어 짧은 인스타 스토리 캡션
- 광고 느낌 X, 친근하고 진솔한 톤
- 이모지 1~2개 자연스럽게
- 제품명 직접 언급은 슬롯에 따라 (1~2번 슬롯엔 자연 노출, 4~5번엔 명시 OK)
- 줄바꿈 1~2개

캡션만 출력해줘 (다른 설명 X).
"""
        resp = model.generate_content(prompt)
        return (resp.text or "").strip()
    except Exception as e:  # noqa: BLE001
        log.warning(f"caption gen failed: {e}")
        return f"[{slot_name} 캡션 생성 실패: {e}]"


def generate_schedule(
    payload: dict[str, Any],
    config: dict[str, Any],
    on_progress: PROGRESS_CB | None = None,
) -> dict[str, Any]:
    progress = on_progress or (lambda **kw: None)
    project_root = Path(__file__).resolve().parent.parent

    target = payload.get("target", {})
    product = payload.get("product", {})
    sched = payload.get("schedule", {})
    ref_ids = payload.get("reference_sellers", [])

    progress(message="참고 셀럽 manifest 로드…", progress=1, total=10)
    sellers = _load_seller_manifests(ref_ids, project_root)
    if not sellers:
        return {"error": "참고 셀럽 데이터가 없습니다. 셀러 아카이브 탭에서 먼저 업데이트하세요."}

    # 일정 계산
    try:
        start_date = datetime.fromisoformat(sched.get("start") or "").date()
        end_date = datetime.fromisoformat(sched.get("end") or "").date()
    except Exception:
        return {"error": "시작일/종료일을 정확히 입력해주세요."}
    if end_date < start_date:
        return {"error": "종료일이 시작일보다 빠를 수 없습니다."}
    days = []
    cur = start_date
    while cur <= end_date:
        days.append(cur)
        cur += timedelta(days=1)

    progress(message=f"일정 {len(days)}일 / 슬롯 {len(STORY_SLOTS)}개 — 캡션 생성 시작", progress=2, total=10)

    used_ids: set[str] = set()
    rows = []
    for d_idx, d in enumerate(days):
        d_minus = (start_date - d).days  # 음수면 D-N
        # 정확히는 시작일 = 1일차 / D-day index
        day_label = f"{d.month}월 {d.day}일 ({['월','화','수','목','금','토','일'][d.weekday()]}) [D{(d - start_date).days:+d}]"
        row = {"date_label": day_label, "iso_date": d.isoformat(), "stories": []}
        for slot_name, slot_desc in STORY_SLOTS:
            picked = _pick_image_for_slot(slot_name, sellers, used_ids)
            caption = _gen_caption(slot_name, slot_desc, product, target, d_idx, config)
            if picked:
                used_ids.add(picked["item"]["id"])
                row["stories"].append({
                    "slot": slot_name,
                    "caption": caption,
                    "image_path": picked["item"].get("file_path"),
                    "source_seller": picked["manifest"]["_seller"]["name"],
                    "source_handle": picked["manifest"]["_seller"]["instagram"],
                    "source_alt": picked["item"].get("alt_text", "")[:120],
                })
            else:
                row["stories"].append({
                    "slot": slot_name,
                    "caption": caption,
                    "image_path": None,
                    "source_seller": None,
                    "source_handle": None,
                })
        rows.append(row)
        progress(message=f"{day_label} 처리 완료", progress=3 + d_idx, total=3 + len(days) + 2)

    # HTML 미리보기 + JSON 결과 저장
    out_dir = project_root / "data" / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname_base = f"{target.get('name','셀러')}_{sched.get('round',1)}차_{timestamp}"
    safe_base = "".join(c for c in fname_base if c.isalnum() or c in "_-가-힣")[:80]

    json_path = out_dir / f"{safe_base}.json"
    json_path.write_text(json.dumps({
        "meta": {
            "target": target, "product": product, "schedule": sched,
            "reference_sellers": ref_ids, "generated_at": datetime.now().isoformat(timespec="seconds"),
        },
        "rows": rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    html_path = out_dir / f"{safe_base}.html"
    html_path.write_text(_render_html(target, product, sched, rows, project_root), encoding="utf-8")

    progress(message="시트 생성 완료", progress=10, total=10)

    return {
        "json_path": str(json_path),
        "html_path": str(html_path),
        "rows_count": len(rows),
        "slots_per_row": len(STORY_SLOTS),
        "result_url": f"/generated/{html_path.name}",
    }


def _render_html(target, product, sched, rows, project_root) -> str:
    """모범 시트 양식과 비슷한 HTML 미리보기 생성."""
    title = f"{target.get('name','셀러')}(@{target.get('instagram','')}) × 하루픽스 {product.get('name','')} {sched.get('round',1)}차 공동구매 스케줄링"
    html = ["<!doctype html><html lang='ko'><head><meta charset='utf-8'><title>", title, "</title>"]
    html.append("""<style>
    body { font-family: -apple-system, "Apple SD Gothic Neo", sans-serif; background: #fafaf7; color: #222; margin: 0; padding: 24px; }
    h1 { font-size: 18px; background: #fdf6ee; border: 2px solid #d97f3f; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
    .guide { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .guide-box { background: #fff; border: 1px solid #ddd; padding: 12px; border-radius: 6px; font-size: 12px; line-height: 1.6; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; font-size: 12px; }
    th { background: #f0ead8; font-weight: 600; }
    .date-cell { background: #e6f0ff; font-weight: 600; min-width: 80px; }
    .story-cell { width: 16%; }
    .caption { font-size: 12px; line-height: 1.5; white-space: pre-wrap; margin-bottom: 6px; }
    .img-wrap { position: relative; }
    .img-wrap img { max-width: 100%; height: auto; border-radius: 4px; display: block; }
    .src-tag { font-size: 10px; color: #888; margin-top: 4px; }
    </style></head><body>""")
    html.append(f"<h1>{title}</h1>")
    html.append(f"""<div class='guide'>
      <div class='guide-box'><b>가이드라인</b><br>
      • 공구 일정: {sched.get('start','')} ~ {sched.get('end','')} ({sched.get('round',1)}차 진행)<br>
      • 제품: {product.get('name','')}<br>
      • USP: {product.get('usp','')}<br>
      • 가격: {product.get('price','')}<br>
      • 금지: {product.get('avoid','')}
      </div>
      <div class='guide-box'><b>제품 상세</b><br>{product.get('detail','')}</div>
    </div>""")
    html.append("<table><thead><tr><th>날짜</th>")
    for slot, _ in STORY_SLOTS:
        html.append(f"<th>{slot.split('_',1)[1] if '_' in slot else slot}</th>")
    html.append("</tr></thead><tbody>")

    for row in rows:
        html.append(f"<tr><td class='date-cell'>{row['date_label']}</td>")
        for st in row["stories"]:
            html.append("<td class='story-cell'>")
            html.append(f"<div class='caption'>{(st['caption'] or '').replace('<','&lt;').replace('>','&gt;')}</div>")
            if st.get("image_path"):
                # 이미지 경로는 로컬 파일 — html은 file:// 또는 상대경로
                seller_folder = next((m["_folder"] for m in [] if False), None)
                # JSON에 이미 저장되었으니 image_path가 'highlights/.../file.jpg' 형태
                # 미리보기 위해선 셀러 folder까지 합쳐야 — 여기선 간단히 file_path 표시
                src_seller = st.get("source_seller", "")
                src_handle = st.get("source_handle", "")
                src_folder = ""
                # source_handle 있으면 폴더 경로 추론
                if src_handle:
                    sellers_data = json.loads((project_root / "data" / "sellers.json").read_text(encoding="utf-8"))
                    s = next((x for x in sellers_data["sellers"] if x["instagram"] == src_handle), None)
                    if s:
                        src_folder = f"{s['id']}.{s['name']}_@{s['instagram']}"
                if src_folder:
                    abs_path = project_root / "data" / "local_archive" / src_folder / st["image_path"]
                    rel = abs_path.as_posix()
                    html.append(f"<div class='img-wrap'><img src='file:///{rel}' alt='' /></div>")
                html.append(f"<div class='src-tag'>← @{src_handle} / {src_seller}</div>")
            html.append("</td>")
        html.append("</tr>")

    html.append("</tbody></table></body></html>")
    return "".join(html)
