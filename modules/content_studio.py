"""
콘텐츠 스튜디오 — 소재 기획안 AI 자동생성 (AI Studio 앱 이식).
1) analyze_video : 광고영상 → [No·타임스탬프·나레이션·자막·연출] 표 추출
2) generate_plan : 레퍼런스 분석 + 우리 제품(USP) → 새 기획안 [No·나레이션·자막·연출방향]
3) extract_usp   : 상세페이지 URL / 파일(PDF·이미지) → 제품명·핵심특징(USP)

프롬프트는 사용자의 AI Studio 원본을 그대로 유지(품질 핵심). 모델만 google-generativeai 로 이식.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from typing import Any

log = logging.getLogger("content_studio")

# 원본(AI Studio) 모델 우선, 키가 지원 안 하면 다음 후보로 자동 폴백
ANALYZE_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.0-flash-exp"]
PLAN_MODELS = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"]
USP_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.0-flash-exp"]
FLASH_MODEL = ANALYZE_MODELS[0]
PRO_MODEL = PLAN_MODELS[0]

# 모델 미지원/권한 오류 → 다음 후보로 폴백
_MODEL_HINTS = ("not found", "404", "not supported", "permission", "unavailable",
                "does not exist", "invalid model", "is not found", "user location")
# 할당량/레이트리밋(429) → 다음 후보로 폴백 (무료 티어에서 gemini-3-pro 등 limit:0 대응)
_QUOTA_HINTS = ("429", "quota", "exceeded", "resource_exhausted", "resource exhausted",
                "exhausted", "rate limit", "rate_limit", "too many requests")
_FALLBACK_HINTS = _MODEL_HINTS + _QUOTA_HINTS


def _configure(config: dict[str, Any]):
    import google.generativeai as genai
    api_key = (config.get("gemini", {}) or {}).get("api_key", "").strip()
    if not api_key or api_key.startswith("여기에"):
        raise ValueError("Gemini API key 미설정 (설정 > Gemini)")
    genai.configure(api_key=api_key)
    return genai


# 마지막으로 성공한 모델 기억 (무료 티어에서 죽은 후보 반복 호출 방지 → 속도↑·레이트리밋↓)
_GOOD_MODEL: dict[str, str] = {}


def _try_models(genai, models: list[str], call):
    """후보 모델을 순서대로 시도. 모델 미지원/권한/할당량(429) 오류면 다음 후보로 폴백.
    한 번 성공한 모델은 다음 호출 때 맨 앞에서 먼저 시도한다."""
    key = ",".join(models)
    ordered = models
    pref = _GOOD_MODEL.get(key)
    if pref and pref in models:
        ordered = [pref] + [m for m in models if m != pref]
    last = None
    for m in ordered:
        try:
            log.info(f"Gemini 모델 시도 → {m}")
            resp = call(genai.GenerativeModel(m))
            _GOOD_MODEL[key] = m
            return resp
        except Exception as e:  # noqa: BLE001
            last = e
            if any(h in str(e).lower() for h in _FALLBACK_HINTS):
                log.info(f"모델 {m} 폴백 → 다음 후보 ({str(e)[:80]})")
                continue
            raise
    # 모든 후보 실패 → 마지막 오류가 할당량 문제면 친절한 메시지로 변환
    msg = str(last) if last else ""
    if any(h in msg.lower() for h in _QUOTA_HINTS):
        raise RuntimeError(
            "Gemini 무료 할당량을 모두 초과했습니다(분당 한도 또는 무료 미지원 모델). "
            "1~2분 뒤 다시 시도하거나, 설정에서 유료 결제된 API 키로 바꾸면 "
            "gemini-3 / 2.5-pro 고품질 모델로 동작합니다."
        )
    raise last if last else RuntimeError("사용 가능한 Gemini 모델 없음")


def _parse_json(text: str):
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text[:4].lower() == "json":
            text = text[4:].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # 마지막 ] 또는 } 까지 잘라서 재시도
        for end_ch in ("]", "}"):
            end = text.rfind(end_ch)
            if end >= 0:
                try:
                    return json.loads(text[: end + 1])
                except Exception:
                    continue
        raise


ANALYZE_PROMPT = """당신은 광고 영상 데이터 추출의 절대적인 전문가입니다.
아래의 **[최우선 필수 규칙]**을 단 1mm의 오차도 없이 수행하십시오.

[필수 규칙 1: 자막 구분자 '<>' 사용 및 줄바꿈]
- **중요: 데이터의 맨 시작(첫 줄)에는 절대 '<>'를 넣지 마십시오.**
- 동일한 영상 장면 내에서 자막 내용이 순차적으로 바뀔 때(예: '라이크밀' 나왔다가 사라지고 '신상떴네요' 나올 때)만 '<>'를 사용하십시오.
- **자막 구분 시 형식: [이전 자막] (엔터 1번) <> (엔터 1번) [다음 자막]**
- 불필요하게 엔터를 두 번(빈 줄 생성) 누르지 마십시오. 딱 한 번의 줄바꿈만 허용합니다.
- 반드시 '<'와 '>'가 합쳐진 '<>' 형태를 유지하십시오. '<' 만 작성하는 실수를 절대 하지 마십시오.
- 영상 내 자막이 두 줄 이상으로 동시에 표시된다면, 출력 시에도 동일하게 줄바꿈을 유지하여 작성하십시오.

[필수 규칙 2: 음성과 자막의 '완벽한 상호 차단']
- 나레이션(Narration): 영상에서 '들리는 소리'만 적으십시오. 자막을 보고 채워넣는 것을 금지합니다.
- 자막(Caption): 영상 화면에 '글자로 적혀있는 것'만 적으십시오. 소리를 듣고 채워넣는 것을 금지합니다.
- 소리와 글자가 조금이라도 다르면 절대 하나로 합치지 말고 각각 보이는/들리는 그대로 적으십시오.

[필수 규칙 3: 고정 배너 (Sticky Banner) 격리]
- 영상 전체 시간의 80% 이상 노출되는 텍스트는 오직 **No.1 행의 자막 칸 최상단**에만 '[고정배너] 내용' 형식으로 적으십시오.
- 고정 배너 내용 안에는 절대 '<>'를 넣지 마십시오.

[필수 규칙 4: 연출 표현의 개조식 요약]
- 연출 칸은 반드시 개조식(~함, ~임, ~보여줌)으로 10자 내외로 작성하십시오. 문장형은 금지합니다.

[필수 규칙 5: 유행어 및 비표준어 100% 보존]
- '낋여왔어요', '입터짐', '갓생' 등 오타나 유행어를 절대 표준어로 고치지 마십시오.
{feedback}
반드시 아래 형식의 유효한 JSON 배열로만 응답하십시오 (다른 설명 X):
[{{"no":"1","timestamp":"00:00","narration":"...","caption":"...","visual":"..."}}, ...]
"""

# 광고/콘텐츠 기획 헌법 — "왜 볼까? 왜 살까?" (사용자 지침 영구 내장, 모든 기획에 반영)
DOCTRINE = """[왜 볼까? — 시청 유도 / 최소 1개 이상 충족]
a) 뻔하지 않은 내용: 이미 소비된 메시지 금지. 호기심·재정의 키워드로 (예: "성인 여드름은 지속형·후발형 두 부류").
b) 시청의 실익: 보면 얻는 즉각/미래 이득, '모르면 손해' 구조.
c) 시각적 차별화: Before&After·OSV(ASMR)·맛있어 보임 — 단 아직 신선할 것.
d) 형식 몰입: 빠른 템포·GIF·언박싱·중독성 — 진부하지 않게.

[왜 살까? — 구매 전환]
a) '사도 된다' 신뢰도: 실사용 후기·전문가/권위·논문/인증(식약처·FDA)·대세감·논리적 모순 없음·광고 같지 않음·디테일. (흐름 해치지 않는 선에서 다다익선)
b) 배타적 차별성: '우리 제품만 당신 문제를 해결' → 비교 차단(성분비·고함량 등, 안 되면 '느낌'이라도).
c) 효용 구체화: 제품이 아니라 '변화된 나'를 그려줌 (살 빠진 나, 건강한 아이).
d) 손실회피: "지금 안 사면 손해"(시간/장소/희소) — 마지막에 반드시 1개 장치.
※ 설명형이면 인과·흐름 논리에 모순이 없어야 하고, 항상 소비자 관점으로 점검."""

PLAN_PROMPT = """당신은 성과가 검증된 숏폼 광고를 '리스킨'하는 전문 카피라이터입니다.
[레퍼런스 광고]의 **설득 흐름(플로우)과 말투·문장 구조를 그대로 유지**한 채, 제품만 우리 제품으로 바꿔치기하십시오.
완전히 새로운 광고를 창작하지 마십시오. 레퍼런스를 '리스킨'하는 것이 목표입니다.

[규칙 1 — 광고 플로우 1:1 보존 (가장 중요)]
- 레퍼런스의 줄 수와 순서를 그대로 따르고, 각 줄을 1:1로 대응 변환하십시오. 줄을 합치거나 빼거나 새로 추가하지 마십시오.
- 각 줄에서 다음 3가지는 '절대 유지': ①설득 기능(후킹/문제제기/성분·효능/사회적 증거/가격·긴급성/환불보장/CTA 등 그 줄의 역할) ②말투·문장 패턴·리듬·길이감 ③구조적 장치(후킹 공식·비유·긴급성 표현).
- 각 줄에서 '제품 고유 정보'(제품명·성분·소구점·타겟)만 우리 것으로 치환하십시오.

[규칙 2 — 후킹 공식 사수 (가장 자주 망가지는 부분)]
- 레퍼런스가 "[특정 집단]들 사이에서 난리 난 [제품]" 형태면, 반드시 같은 공식을 유지하고 [집단]만 우리 타겟/소구로 교체하십시오.
- 절대 "매일 거울 보며 한숨 쉬던 당신을 위해" 같은 '개인 고민형 일반 문장'으로 바꾸지 마십시오 (이러면 광고가 완전히 망가집니다).
- 후킹 집단 앵글: {hook_angle}
- 예) 소구=염증 → "만성 염증러들 사이에서 난리 난 {name}"

[규칙 3 — 이번 기획의 소구점(중심 메시지)]
{appeals}

[규칙 4 — 우리 제품 / USP]
제품명: {name}
USP·특징: {features}
USP는 레퍼런스에서 '성분·효능'을 말하는 줄에만 자연스럽게 녹이고, 다른 줄의 플로우를 USP 때문에 깨뜨리지 마십시오.

[규칙 5 — '왜 볼까? 왜 살까?' 기획 헌법 (반드시 반영하고, 끝에 충족 요소를 명시)]
{doctrine}

[변환 예시 — 이 패턴을 그대로 따르십시오]
레퍼런스: "뉴욕 워킹맘들 사이에서 난리 난 노른자 크림"
→ (소구=염증) "만성 염증러들 사이에서 난리 난 {name}"   (후킹 공식 유지, 집단만 교체)
레퍼런스: "10년 더 늙어 보이는 불독살도 쫙 끌어올려 주고 벨트로 묶은 것처럼 리프팅 고정해 주는 노른자 크림"
→ 같은 '과장된 문제 묘사 + 강한 비유 + 해결' 구조로, 우리 소구점·효능에 맞춰 치환

[자막·연출 규칙]
1. 자막 구분자 '<>': 한 장면 안에서 자막이 순차적으로 바뀔 때만 단독 행(앞뒤 줄바꿈 1회)으로. 첫 행엔 금지.
2. 연출(direction): '~함','~임' 식 개조식.
3. 나레이션(음성)과 자막(텍스트)을 철저히 분리.
{history}
[레퍼런스 광고 — 이 흐름을 그대로 리스킨할 대상]
{context}
{feedback}
반드시 아래 형식의 '유효한 JSON 객체'로만 응답하십시오 (다른 설명 X). plan은 레퍼런스와 같은 줄 수로:
{{"plan":[{{"no":"1","narration":"...","caption":"...","direction":"..."}}, ...],
"why_watch":"이 기획이 '왜 볼까'의 어떤 요소를 어떻게 충족하는지 1~2문장",
"why_buy":"이 기획이 '왜 살까'의 어떤 요소(신뢰/차별성/효용/손실회피)를 어떻게 충족하는지 1~2문장"}}
"""

USP_PROMPT_TEXT = """다음은 제품 상세페이지/소개 내용입니다. 제품명과 핵심 특징(USP)을 추출하십시오.
특징(features)은 개조식으로 작성하십시오.

[내용]
{body}

반드시 아래 형식의 유효한 JSON 객체로만 응답하십시오:
{{"name":"제품명","features":"핵심 특징 USP (개조식)"}}
"""

USP_PROMPT_FILE = """이 파일(상세페이지 또는 제품 소개서)을 분석하여 제품명과 핵심 특징(USP)을 추출해주세요.
특징(features)은 개조식으로 작성하십시오.
반드시 아래 형식의 유효한 JSON 객체로만 응답하십시오:
{"name":"제품명","features":"핵심 특징 USP (개조식)"}
"""


def analyze_video(config: dict, video_bytes: bytes, mime_type: str, feedback: str = "") -> list[dict]:
    genai = _configure(config)
    fb = f"\n[최우선 반영 피드백]\n{feedback}\n" if feedback else ""
    prompt = ANALYZE_PROMPT.format(feedback=fb)

    suffix = ".mp4"
    if "quicktime" in (mime_type or "") or "mov" in (mime_type or ""):
        suffix = ".mov"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(video_bytes)
        tmp.close()
        f = genai.upload_file(path=tmp.name, mime_type=mime_type or "video/mp4")
        # 처리(ACTIVE) 대기
        for _ in range(60):
            if getattr(f.state, "name", str(f.state)) == "ACTIVE":
                break
            time.sleep(2)
            f = genai.get_file(f.name)
        resp = _try_models(genai, ANALYZE_MODELS, lambda mdl: mdl.generate_content(
            [f, prompt], generation_config={"response_mime_type": "application/json"}))
        data = _parse_json(resp.text)
        try:
            genai.delete_file(f.name)
        except Exception:
            pass
        return data if isinstance(data, list) else []
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _history_block(history: list[dict] | None, limit: int = 5) -> str:
    """이 제품의 누적 확정 기획안 → 검증된 톤·구조를 학습 참고로 프롬프트에 주입.
    토큰 관리를 위해 최근 limit개의 '최종 확정본'만 요약해서 넣는다."""
    history = [h for h in (history or []) if h.get("final")]
    if not history:
        return ""
    out = ["\n[이 제품의 누적 확정 기획안 — 사용자가 직접 검수·확정한 검증된 광고임. "
           "아래의 톤·후킹·문장 호흡·금지어 회피 패턴을 최대한 계승하되, 문장을 그대로 복붙하지는 마십시오.]"]
    for i, h in enumerate(history[-limit:], 1):
        final = h.get("final") or []
        narr = " / ".join((r.get("narration") or "").strip() for r in final if (r.get("narration") or "").strip())
        cap = " / ".join((r.get("caption") or "").strip() for r in final if (r.get("caption") or "").strip())
        out.append(f"· 확정본{i} 나레이션: {narr[:450]}")
        if cap:
            out.append(f"  자막: {cap[:300]}")
        note = (h.get("note") or "").strip()
        if note:
            out.append(f"  └ 확정 메모(왜 이렇게 갔는지): {note[:200]}")
    return "\n".join(out) + "\n"


def _appeals_text(product: dict) -> str:
    ap = product.get("appeals") or []
    if isinstance(ap, str):
        ap = [x for x in ap.replace(",", "\n").split("\n")]
    ap = [a.strip() for a in ap if a and a.strip()]
    if ap:
        return ("이번 광고의 핵심 소구점은 다음과 같습니다. 이 소구를 중심으로 레퍼런스의 각 줄을 우리 것으로 치환하십시오:\n· "
                + "\n· ".join(ap))
    return "지정된 소구점이 없으면 제품 USP/핵심 효능을 중심 소구로 삼으십시오."


def _hook_text(product: dict) -> str:
    h = (product.get("hook_angle") or "").strip()
    if h:
        return f"'{h}'를 후킹 집단으로 사용하십시오 (예: \"{h} 사이에서 난리 난 [제품]\" 형태)."
    return "소구점/타겟에서 자연스럽게 도출 (예: '만성 OO러들 사이에서', '맘카페에서', '해외 유명 틱톡에서' 난리 난 ~)."


def generate_plan(config: dict, analysis: list[dict], product: dict,
                  feedback: str = "", history: list[dict] | None = None) -> dict:
    genai = _configure(config)
    context = "\n".join(
        f"[{a.get('no','')}] 나레이션: {a.get('narration','')}, 자막: {a.get('caption','')}, 연출: {a.get('visual','')}"
        for a in (analysis or [])
    )
    fb = f"\n[피드백 반영]: {feedback}\n" if feedback else ""
    prompt = PLAN_PROMPT.format(
        name=product.get("name", ""), features=product.get("features", ""),
        appeals=_appeals_text(product), hook_angle=_hook_text(product), doctrine=DOCTRINE,
        context=context, feedback=fb, history=_history_block(history))
    resp = _try_models(genai, PLAN_MODELS, lambda mdl: mdl.generate_content(
        prompt, generation_config={"response_mime_type": "application/json"}))
    data = _parse_json(resp.text)
    if isinstance(data, list):
        return {"plan": data, "why_watch": "", "why_buy": ""}
    if isinstance(data, dict):
        return {"plan": data.get("plan") or [], "why_watch": data.get("why_watch", ""), "why_buy": data.get("why_buy", "")}
    return {"plan": [], "why_watch": "", "why_buy": ""}


def extract_usp_url(config: dict, url: str) -> dict:
    """URL 상세페이지 → 제품명·USP. 서버에서 본문 받아 Gemini 분석."""
    genai = _configure(config)
    body = ""
    try:
        import re
        import requests
        r = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
        html = r.text or ""
        # 태그 제거 → 텍스트만
        html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text)
        body = text[:8000]
    except Exception as e:
        raise ValueError(f"URL 내용을 가져오지 못했습니다: {e}")
    resp = _try_models(genai, USP_MODELS, lambda mdl: mdl.generate_content(
        USP_PROMPT_TEXT.format(body=body), generation_config={"response_mime_type": "application/json"}))
    return _parse_json(resp.text)


def extract_usp_file(config: dict, file_bytes: bytes, mime_type: str) -> dict:
    genai = _configure(config)
    resp = _try_models(genai, USP_MODELS, lambda mdl: mdl.generate_content(
        [{"mime_type": mime_type or "application/pdf", "data": file_bytes}, USP_PROMPT_FILE],
        generation_config={"response_mime_type": "application/json"}))
    return _parse_json(resp.text)
