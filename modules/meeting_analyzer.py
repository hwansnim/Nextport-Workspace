"""
미팅 녹취 자동 분석 (Gemini 오디오 입력)
- 오디오 파일 → 트랜스크립트 + 요약 + 액션 아이템
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("meeting_analyzer")


PROMPT = """너는 비즈니스 미팅 녹음 파일을 분석하는 도우미야. 한국어 미팅이다.

이 음성 파일을 듣고 아래 JSON 스키마에 정확히 맞춰서 출력해. JSON만 출력 (앞뒤 설명/마크다운 X).

스키마:
{
  "transcript": "전체 받아쓰기. 화자가 여러명이면 '화자1: ...', '화자2: ...' 식으로. 끊지 말고 전부.",
  "summary": "미팅 전체 핵심을 5~10문장으로 요약 (한국어).",
  "decisions": ["결정 사항 1", "결정 사항 2", ...],
  "action_items": [
    {"who": "담당자 (모르면 '미정')", "what": "해야 할 일", "when": "마감 (모르면 '미정')"}
  ],
  "key_points": ["주요 발언/이슈 1", "주요 발언/이슈 2", ...],
  "follow_up_topics": ["다음에 이어 논의할 주제 1", ...]
}

규칙:
- 받아쓰기는 최대한 정확하게. 들리지 않는 부분은 [...]로 표시.
- 요약은 매끄러운 비즈니스 한국어.
- 액션 아이템은 동작 동사로 시작 ("연락하다", "전송하다" 등).
- 결정 사항은 명사형 문장.
"""


class MeetingAnalyzer:
    def __init__(self, config: dict[str, Any]):
        import google.generativeai as genai

        api_key = config.get("gemini", {}).get("api_key", "").strip()
        if not api_key or api_key.startswith("여기에"):
            raise ValueError("Gemini API key 미설정")

        # 모델 선택:
        # - gemini-2.5-flash: 무료 티어에서도 충분히 사용 가능 (분당 15회, 일 1500회 수준)
        # - gemini-2.5-pro: 정확도는 더 좋지만 무료 티어 한도 0 → 유료 결제 필요
        # 사용자가 config 에서 명시하면 그게 우선.
        model_name = (
            config.get("gemini", {}).get("audio_model")
            or "gemini-2.5-flash"
        )
        self.model_name = model_name
        self.genai = genai
        genai.configure(api_key=api_key)
        # JSON 강제 모드 + 큰 출력 한도
        self._gen_config = {
            "response_mime_type": "application/json",
            "max_output_tokens": 32768,
            "temperature": 0.2,
        }
        self.model = genai.GenerativeModel(model_name, generation_config=self._gen_config)

    def _fallback_to_flash(self):
        """429 (quota) 났을 때 flash 모델로 강제 전환."""
        if "flash" in self.model_name:
            return False
        log.warning(f"{self.model_name} 쿼터 초과 → gemini-2.5-flash 로 자동 전환")
        self.model_name = "gemini-2.5-flash"
        self.model = self.genai.GenerativeModel(self.model_name, generation_config=self._gen_config)
        return True

    def _parse_json(self, text: str) -> dict[str, Any] | None:
        """Gemini 응답에서 JSON 추출. 마크다운 wrap / 잘림 / 앞뒤 노이즈 다 처리."""
        if not text:
            return None
        s = text.strip()
        # 마크다운 ```json ... ``` 제거
        if s.startswith("```"):
            s = s.strip("`")
            if s.lstrip().lower().startswith("json"):
                s = s.split("\n", 1)[1] if "\n" in s else s[4:]
            s = s.strip()
            # 끝의 ``` 제거
            if s.endswith("```"):
                s = s[:-3].strip()
        # 첫 { 부터 마지막 } 까지만 사용
        start = s.find("{")
        end = s.rfind("}")
        if start >= 0 and end >= start:
            s = s[start:end + 1]
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            # 잘린 JSON 복구 시도: 가장 깊은 닫는 } 까지만
            for cut in range(end, -1, -1):
                if s[cut:cut+1] == "}":
                    try:
                        return json.loads(s[:cut + 1])
                    except Exception:
                        continue
        return None

    def analyze_audio(self, audio_path: Path, *, on_progress=None) -> dict[str, Any]:
        """오디오 파일 업로드 → Gemini 분석 → JSON 결과."""
        if on_progress:
            on_progress(message="파일 업로드 중...", progress=1, total=10)

        # Files API 로 업로드 (큰 오디오 처리)
        try:
            uploaded = self.genai.upload_file(path=str(audio_path))
        except Exception as e:  # noqa: BLE001
            log.exception("upload_file 실패")
            return {"_error": f"업로드 실패: {e}"}

        # 처리 완료 대기 (오디오는 'ACTIVE' 될 때까지 시간 걸림)
        if on_progress:
            on_progress(message="파일 인덱싱 대기...", progress=3, total=10)
        for _ in range(60):  # 최대 5분
            f = self.genai.get_file(uploaded.name)
            state = getattr(f, "state", None)
            state_name = getattr(state, "name", str(state)) if state else ""
            if state_name == "ACTIVE":
                break
            if state_name == "FAILED":
                return {"_error": "파일 처리 실패 (Gemini state=FAILED)"}
            time.sleep(5)
        else:
            return {"_error": "파일 인덱싱 타임아웃"}

        if on_progress:
            on_progress(message=f"Gemini 분석 중 [{self.model_name}] (1~3분 소요)...", progress=5, total=10)

        def _try_generate():
            return self.model.generate_content([PROMPT, uploaded])

        try:
            resp = _try_generate()
            text = (resp.text or "").strip()
        except Exception as e:  # noqa: BLE001
            # 429 (quota) 이고 pro 였으면 flash 로 자동 재시도
            if "429" in str(e) and self._fallback_to_flash():
                if on_progress:
                    on_progress(message="쿼터 초과 → flash 모델로 재시도...", progress=5, total=10)
                try:
                    resp = _try_generate()
                    text = (resp.text or "").strip()
                except Exception as e2:  # noqa: BLE001
                    log.exception("flash fallback 도 실패")
                    return {"_error": f"분석 실패 (flash 재시도 후): {e2}"}
            else:
                log.exception("generate_content 실패")
                return {"_error": f"분석 실패: {e}"}

        if on_progress:
            on_progress(message="결과 파싱...", progress=9, total=10)

        # 디버깅용 — 응답 raw 를 로그에 남김
        log.info(f"Gemini 응답 길이: {len(text)} 자")
        log.debug(f"Gemini 응답 첫 500자: {text[:500]}")
        # 파일로도 저장 (재현/리커버용)
        try:
            from pathlib import Path
            debug_dir = Path(__file__).resolve().parent.parent / "logs"
            debug_dir.mkdir(exist_ok=True)
            (debug_dir / "last_gemini_response.txt").write_text(text, encoding="utf-8")
        except Exception:
            pass

        data = self._parse_json(text)
        if data is None:
            log.warning(f"JSON 파싱 실패. 응답은 logs/last_gemini_response.txt 에 저장됨.")
            return {"_error": "결과 JSON 파싱 실패 — logs/last_gemini_response.txt 확인", "_raw": text[:3000]}

        return {
            "transcript": data.get("transcript", ""),
            "summary": data.get("summary", ""),
            "decisions": data.get("decisions", []) or [],
            "action_items": data.get("action_items", []) or [],
            "key_points": data.get("key_points", []) or [],
            "follow_up_topics": data.get("follow_up_topics", []) or [],
        }

    def analyze_text(self, transcript: str, *, on_progress=None) -> dict[str, Any]:
        """이미 받아쓰기 된 텍스트 (예: 클로바노트 결과) → 요약/액션 추출.
        오디오보다 훨씬 빠르고 토큰만 들음. 화자 분리는 입력 텍스트의 형식 그대로 유지.
        """
        if on_progress:
            on_progress(message="텍스트 분석 시작...", progress=2, total=10)

        text_prompt = """너는 비즈니스 미팅 받아쓰기 텍스트를 분석하는 도우미야. 한국어 미팅이다.

아래 [TRANSCRIPT] 의 내용을 읽고 JSON 스키마에 정확히 맞춰서 출력해. JSON만 출력 (앞뒤 설명/마크다운 X).

스키마:
{
  "summary": "미팅 전체 핵심을 5~10문장으로 요약 (한국어).",
  "decisions": ["결정 사항 1", ...],
  "action_items": [
    {"who": "담당자 (모르면 '미정')", "what": "해야 할 일", "when": "마감 (모르면 '미정')"}
  ],
  "key_points": ["주요 발언/이슈 1", ...],
  "follow_up_topics": ["다음에 이어 논의할 주제 1", ...]
}

[TRANSCRIPT]
""" + (transcript or "")[:200000]

        def _try_text():
            return self.model.generate_content(text_prompt)

        try:
            resp = _try_text()
            text = (resp.text or "").strip()
        except Exception as e:  # noqa: BLE001
            if "429" in str(e) and self._fallback_to_flash():
                if on_progress:
                    on_progress(message="쿼터 초과 → flash 모델로 재시도...", progress=5, total=10)
                try:
                    resp = _try_text()
                    text = (resp.text or "").strip()
                except Exception as e2:  # noqa: BLE001
                    log.exception("flash fallback 도 실패")
                    return {"_error": f"분석 실패 (flash 재시도 후): {e2}"}
            else:
                log.exception("text generate failed")
                return {"_error": f"분석 실패: {e}"}

        # 디버깅용 — 응답 저장
        try:
            from pathlib import Path
            debug_dir = Path(__file__).resolve().parent.parent / "logs"
            debug_dir.mkdir(exist_ok=True)
            (debug_dir / "last_gemini_response_text.txt").write_text(text, encoding="utf-8")
        except Exception:
            pass

        data = self._parse_json(text)
        if data is None:
            return {"_error": "결과 JSON 파싱 실패 — logs/last_gemini_response_text.txt 확인", "_raw": text[:3000]}

        return {
            "transcript": transcript,  # 입력 텍스트 그대로 유지
            "summary": data.get("summary", ""),
            "decisions": data.get("decisions", []) or [],
            "action_items": data.get("action_items", []) or [],
            "key_points": data.get("key_points", []) or [],
            "follow_up_topics": data.get("follow_up_topics", []) or [],
        }
