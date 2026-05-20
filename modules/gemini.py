"""
Gemini Vision 자동 태깅
- 이미지를 보고 scene/mood/tags/story_slot_fit 자동 추출
- manifest.json에 들어갈 메타 생성
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any

log = logging.getLogger("gemini")


PROMPT_TEMPLATE = """너는 인플루언서 인스타 스토리/게시물을 분석해 공동구매 스케줄링용 메타데이터를 만드는 도우미야.

이 이미지를 보고 아래 JSON 스키마에 맞게 응답해줘. JSON만 출력 (다른 설명 X).

스키마:
{
  "scene": "이미지 장면을 1~2문장으로 (한국어)",
  "ocr_text": "이미지 안에 보이는 텍스트 (없으면 빈 문자열)",
  "tags": ["키워드1", "키워드2", ...최대 8개],
  "mood": ["분위기1", "분위기2", ...최대 4개. 예: 일상적, 임팩트, 솔직, 결과보여주기, 친근, 정보전달],
  "person_in_frame": true/false,
  "product_visible": true/false,
  "story_slot_fit": {
    "STORY1_일상노출": 0.0,
    "STORY2_고객반응": 0.0,
    "STORY3_비포애프터": 0.0,
    "STORY4_효능증명": 0.0,
    "STORY5_공유어필": 0.0
  }
}

story_slot_fit 가이드:
- STORY1_일상노출: 일상 자연 노출 (식단, 운동, 아침 루틴 등 — 제품 없이도 OK)
- STORY2_고객반응: 고객 후기, 반응, 경험 (DM/댓글 캡처 등)
- STORY3_비포애프터: 변화 비교, 전후 사진, 결과 인증
- STORY4_효능증명: 성분, 데이터, 인포그래픽, 카드뉴스
- STORY5_공유어필: 공구 알림, 마음 공유, 추천 멘트

각 슬롯에 0.0~1.0 점수. 낮으면 0.0, 매우 잘 맞으면 1.0.

추가 컨텍스트 (있으면 참고):
ALT_TEXT: {alt_text}
"""


class GeminiTagger:
    def __init__(self, config: dict[str, Any]):
        import google.generativeai as genai

        api_key = config.get("gemini", {}).get("api_key", "").strip()
        if not api_key or api_key.startswith("여기에"):
            raise ValueError("Gemini API key 미설정")
        model_name = config.get("gemini", {}).get("model", "gemini-2.0-flash-exp")
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel(model_name)

    def analyze_image(self, image_bytes: bytes, *, alt_text: str = "") -> dict[str, Any]:
        prompt = PROMPT_TEMPLATE.format(alt_text=(alt_text or "")[:500])
        try:
            resp = self.model.generate_content([
                prompt,
                {"mime_type": "image/jpeg", "data": image_bytes},
            ])
            text = (resp.text or "").strip()
            # JSON 추출 (```json...``` 같은 wrapping 제거)
            if text.startswith("```"):
                text = text.strip("`")
                if text.startswith("json"):
                    text = text[4:].strip()
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                # 마지막 } 까지만 잘라서 재시도
                end = text.rfind("}")
                if end >= 0:
                    data = json.loads(text[: end + 1])
                else:
                    raise
            return data
        except Exception as e:  # noqa: BLE001
            log.warning(f"Gemini 분석 실패: {e}")
            return {"_gemini_error": str(e)}
