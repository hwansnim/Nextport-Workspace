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

FLASH_MODEL = "gemini-2.5-flash"   # 분석·USP
PRO_MODEL = "gemini-2.5-pro"       # 기획안 생성


def _configure(config: dict[str, Any]):
    import google.generativeai as genai
    api_key = (config.get("gemini", {}) or {}).get("api_key", "").strip()
    if not api_key or api_key.startswith("여기에"):
        raise ValueError("Gemini API key 미설정 (설정 > Gemini)")
    genai.configure(api_key=api_key)
    return genai


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

PLAN_PROMPT = """카피라이터로서 레퍼런스의 구조를 유지하며 우리 제품의 기획안을 작성하십시오.

[필수 작성 규칙]
1. 자막 구분자: 순차적으로 자막이 바뀔 때만 '<>'를 단독 행(앞뒤 줄바꿈 1회)으로 사용하십시오. 첫 행에는 넣지 마십시오.
2. 연출 방향: 반드시 '~함', '~임' 식의 개조식으로 간결하게 작성하십시오.
3. 음성/자막 분리: 나레이션(음성)과 자막(텍스트)을 철저히 분리하십시오.

[제품 정보] 명: {name}, 특징: {features}
[레퍼런스 데이터]
{context}
{feedback}
반드시 아래 형식의 유효한 JSON 배열로만 응답하십시오 (다른 설명 X):
[{{"no":"1","narration":"...","caption":"...","direction":"..."}}, ...]
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
        model = genai.GenerativeModel(FLASH_MODEL)
        resp = model.generate_content(
            [f, prompt],
            generation_config={"response_mime_type": "application/json"},
        )
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


def generate_plan(config: dict, analysis: list[dict], product: dict,
                  feedback: str = "") -> list[dict]:
    genai = _configure(config)
    context = "\n".join(
        f"[{a.get('no','')}] 나레이션: {a.get('narration','')}, 자막: {a.get('caption','')}, 연출: {a.get('visual','')}"
        for a in (analysis or [])
    )
    fb = f"\n[피드백 반영]: {feedback}\n" if feedback else ""
    prompt = PLAN_PROMPT.format(name=product.get("name", ""), features=product.get("features", ""),
                                context=context, feedback=fb)
    model = genai.GenerativeModel(PRO_MODEL)
    resp = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
    data = _parse_json(resp.text)
    return data if isinstance(data, list) else []


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
    model = genai.GenerativeModel(FLASH_MODEL)
    resp = model.generate_content(USP_PROMPT_TEXT.format(body=body),
                                  generation_config={"response_mime_type": "application/json"})
    return _parse_json(resp.text)


def extract_usp_file(config: dict, file_bytes: bytes, mime_type: str) -> dict:
    genai = _configure(config)
    model = genai.GenerativeModel(FLASH_MODEL)
    resp = model.generate_content(
        [{"mime_type": mime_type or "application/pdf", "data": file_bytes}, USP_PROMPT_FILE],
        generation_config={"response_mime_type": "application/json"},
    )
    return _parse_json(resp.text)
