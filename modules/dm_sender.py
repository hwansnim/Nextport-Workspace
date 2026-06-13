"""
넥스트포트 DM 자동 발송 모듈 (Playwright 기반).

기존 DM_Sender_GUI 의 분석 결과를 토대로 재구현:
- Playwright sync_api 사용
- 인스타 자동 로그인 + DM 발송
- 인간 행동 모방 (랜덤 sleep + 타이핑 딜레이)
- 봇 감지 대응 (다이얼로그 자동 처리)
- 계정 풀 로테이션
- 세션 유지 (storage_state 저장)

⚠ 로컬 PC에서만 작동 (클라우드는 Playwright 메모리 부족 + 인스타가 데이터센터 IP 차단).
"""
from __future__ import annotations

import json
import logging
import random
import time
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("dm_sender")


# 분석에서 뽑은 셀렉터
SELECTORS = {
    "login_username": [
        'input[name="email"]',
        'input[type="text"][autocomplete="username webauthn"]',
        'input[type="text"]',
    ],
    "login_password": ['input[type="password"]'],
    "login_submit": [
        'form[id="login_form"] button[type="submit"]:not([disabled])',
        'form[id="login_form"] button[type="submit"]',
        'button[type="submit"]',
    ],
    "dm_input": [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label*="Message"]',
        'div[contenteditable="true"][aria-label*="메시지"]',
        'textarea[aria-label*="Message"]',
    ],
    "dm_send_button": [
        'button:has-text("Send")',
        'div[role="button"]:has-text("Send")',
        'div[role="button"]:has-text("Send Message")',
        'div[role="button"]:has-text("보내기")',
        'button[aria-label*="Send"]',
    ],
    "message_button_on_profile": [
        'button:has-text("Message")',
        'div[role="button"]:has-text("Message")',
        'button:has-text("메시지 보내기")',
        'div[role="button"]:has-text("메시지 보내기")',
    ],
    "dismiss_dialog": [
        'div[role="dialog"] button:has-text("Not Now")',
        'div[role="dialog"] a:has-text("Not Now")',
        'div[role="dialog"] button:has-text("Skip")',
        'div[role="dialog"] button:has-text("나중에 하기")',
        'div[role="dialog"] button:has-text("닫기")',
    ],
}


# 인간 행동 패턴 - 랜덤 sleep 범위
SLEEP_RANGES = {
    "after_login": (3.0, 6.0),
    "after_nav": (2.0, 5.0),
    "before_type": (0.8, 2.0),
    "after_type": (1.0, 2.5),
    "before_send": (1.0, 2.0),
    "after_send": (4.0, 8.0),
    "between_dms": (30.0, 180.0),  # 30초~3분
    "typing_char": (0.05, 0.18),  # 글자당 50~180ms
}


def _human_sleep(key: str) -> float:
    lo, hi = SLEEP_RANGES.get(key, (1.0, 2.0))
    t = random.uniform(lo, hi)
    time.sleep(t)
    return t


def _human_type(locator, text: str, delay_range: tuple[float, float] = None) -> None:
    """글자당 랜덤 딜레이로 타이핑 (사람처럼)."""
    lo, hi = delay_range or SLEEP_RANGES["typing_char"]
    for ch in text:
        locator.type(ch, delay=random.uniform(lo, hi) * 1000)


def _try_selectors(page, selectors: list[str], timeout_ms: int = 3000):
    """여러 셀렉터 중 처음 매칭되는 거 반환."""
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            loc.wait_for(state="visible", timeout=timeout_ms)
            return loc
        except Exception:
            continue
    return None


class DMSender:
    """인스타 DM 자동 발송. 한 번에 한 계정으로 batch 처리."""

    def __init__(
        self,
        state: dict,
        log_callback: Optional[Callable[[str], None]] = None,
        session_dir: Optional[Path] = None,
    ):
        self.state = state
        self.log_cb = log_callback or (lambda m: None)
        self.session_dir = Path(session_dir or Path(__file__).resolve().parent.parent / "data" / "dm_sessions")
        self.session_dir.mkdir(parents=True, exist_ok=True)

    def _log(self, msg: str) -> None:
        log.info(msg)
        try:
            self.log_cb(msg)
        except Exception:
            pass

    def _should_stop(self) -> bool:
        return self.state.get("status") == "stopping"

    def _account_session_path(self, username: str) -> Path:
        return self.session_dir / f"{username}.json"

    def _dismiss_popups(self, page) -> None:
        """다이얼로그 / 알림 팝업 자동 닫기 (Not Now / Skip 등)."""
        for _ in range(3):
            btn = _try_selectors(page, SELECTORS["dismiss_dialog"], timeout_ms=1500)
            if not btn:
                break
            try:
                btn.click()
                _human_sleep("after_nav")
            except Exception:
                break

    def login(self, page, account: dict) -> bool:
        """인스타 로그인. 세션 있으면 그대로 사용."""
        self._log(f"🔐 로그인 시도: @{account['username']}")
        page.goto("https://www.instagram.com/", timeout=30000)
        _human_sleep("after_nav")

        # 이미 로그인 되어있는지 확인
        try:
            page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:
            pass

        current = page.url
        if "/accounts/login" not in current and "/login" not in current:
            # 이미 로그인 됨 (세션 살아있음)
            self._dismiss_popups(page)
            self._log(f"✓ 세션 사용 (재로그인 X)")
            return True

        # 로그인 폼
        user_field = _try_selectors(page, SELECTORS["login_username"], timeout_ms=8000)
        pw_field = _try_selectors(page, SELECTORS["login_password"], timeout_ms=3000)
        if not user_field or not pw_field:
            self._log(f"❌ 로그인 폼 못 찾음")
            return False

        _human_sleep("before_type")
        _human_type(user_field, account["username"])
        _human_sleep("after_type")
        _human_type(pw_field, account["password"])
        _human_sleep("before_send")

        submit = _try_selectors(page, SELECTORS["login_submit"], timeout_ms=3000)
        if submit:
            submit.click()
        else:
            pw_field.press("Enter")

        _human_sleep("after_login")
        # 다이얼로그 다 닫기
        self._dismiss_popups(page)

        # 로그인 확인
        if "/accounts/login" in page.url or "/login" in page.url:
            self._log(f"❌ 로그인 실패 — URL: {page.url}")
            return False

        self._log(f"✓ 로그인 성공")
        return True

    def send_dm(self, page, target: dict, message: str) -> tuple[bool, str]:
        """한 명에게 DM 발송. 반환: (성공, 메시지)."""
        username = target["username"]
        try:
            self.state["current"] = f"@{username}"

            # 프로필 페이지로 이동
            page.goto(f"https://www.instagram.com/{username}/", timeout=30000)
            _human_sleep("after_nav")
            self._dismiss_popups(page)

            # 'Message' 버튼 찾기
            msg_btn = _try_selectors(page, SELECTORS["message_button_on_profile"], timeout_ms=10000)
            if not msg_btn:
                # 프로필 비공개 or 없음
                if "Sorry, this page" in page.content() or "페이지를" in page.content():
                    return False, "프로필 없음"
                return False, "Message 버튼 못 찾음"

            msg_btn.click()
            _human_sleep("after_nav")

            # DM 입력창
            dm_input = _try_selectors(page, SELECTORS["dm_input"], timeout_ms=15000)
            if not dm_input:
                return False, "DM 입력창 못 찾음"

            _human_sleep("before_type")
            dm_input.click()
            _human_type(dm_input, message)
            _human_sleep("after_type")

            # 전송 버튼 (또는 Enter)
            send_btn = _try_selectors(page, SELECTORS["dm_send_button"], timeout_ms=3000)
            _human_sleep("before_send")
            if send_btn:
                send_btn.click()
            else:
                dm_input.press("Enter")

            _human_sleep("after_send")
            return True, "발송 완료"

        except Exception as e:
            return False, f"에러: {str(e)[:100]}"

    def _format_message(self, template_body: str, account: dict, target: dict) -> str:
        msg = template_body
        msg = msg.replace("[name]", account.get("sender_name") or "")
        msg = msg.replace("[targetname]", target.get("display_name") or target.get("username") or "")
        return msg

    def _update_account_stat(self, accounts_file: str, account_id: str) -> None:
        from datetime import datetime as _dt
        try:
            data = json.loads(Path(accounts_file).read_text(encoding="utf-8"))
            for a in data.get("accounts", []):
                if a["id"] == account_id:
                    today = _dt.now().date().isoformat()
                    if a.get("last_reset_date") != today:
                        a["daily_count"] = 0
                        a["last_reset_date"] = today
                    a["daily_count"] = a.get("daily_count", 0) + 1
                    a["total_sent"] = a.get("total_sent", 0) + 1
                    a["last_used_at"] = _dt.now().isoformat(timespec="seconds")
                    break
            Path(accounts_file).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _update_target_stat(self, targets_file: str, target_id: str, status: str,
                            account_username: str, error: str = "") -> None:
        from datetime import datetime as _dt
        try:
            data = json.loads(Path(targets_file).read_text(encoding="utf-8"))
            for t in data.get("targets", []):
                if t["id"] == target_id:
                    t["status"] = status
                    t["last_sent_at"] = _dt.now().isoformat(timespec="seconds")
                    t["last_sent_account"] = account_username
                    if error:
                        t["notes"] = (t.get("notes") or "") + f"\n[{_dt.now().strftime('%m/%d')}] {error}"
                    break
            Path(targets_file).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _pick_account(self, accounts_file: str) -> Optional[dict]:
        from datetime import datetime as _dt
        try:
            data = json.loads(Path(accounts_file).read_text(encoding="utf-8"))
            today = _dt.now().date().isoformat()
            candidates = []
            for a in data.get("accounts", []):
                if a.get("status") != "active":
                    continue
                if a.get("last_reset_date") != today:
                    a["daily_count"] = 0
                candidates.append(a)
            candidates = [a for a in candidates if a.get("daily_count", 0) < a.get("daily_limit", 50)]
            if not candidates:
                return None
            candidates.sort(key=lambda x: x.get("last_used_at") or "")
            return candidates[0]
        except Exception:
            return None

    def run_batch(self, targets: list[dict], template: dict,
                  accounts_file: str, targets_file: str) -> None:
        """타겟 명단을 batch 처리. 계정 로테이션 + 인간 행동."""
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self._log("❌ Playwright 안 깔림. 'pip install playwright && playwright install chromium' 필요.")
            return

        with sync_playwright() as p:
            current_account = None
            browser = None
            context = None
            page = None

            for idx, target in enumerate(targets):
                if self._should_stop():
                    self._log("⏹ 사용자 중지")
                    break

                # 발송할 계정 선택
                account = self._pick_account(accounts_file)
                if not account:
                    self._log("⚠ 발송 가능한 계정 없음 (전부 일일 한도 도달)")
                    break

                # 계정 바뀌면 브라우저 재시작 (세션 분리)
                if not current_account or current_account["id"] != account["id"]:
                    if context:
                        try: context.close()
                        except: pass
                    if browser:
                        try: browser.close()
                        except: pass
                    current_account = account
                    self._log(f"🌐 새 계정 브라우저 시작: @{account['username']}")
                    browser = p.chromium.launch(headless=False, args=["--no-sandbox"])
                    session_path = self._account_session_path(account["username"])
                    context_opts = {"viewport": {"width": 1280, "height": 800}}
                    if session_path.exists():
                        context_opts["storage_state"] = str(session_path)
                    context = browser.new_context(**context_opts)
                    page = context.new_page()
                    # 로그인
                    ok = self.login(page, account)
                    if not ok:
                        self._log(f"❌ @{account['username']} 로그인 실패 — 계정 비활성화")
                        # 계정 상태 변경
                        try:
                            data = json.loads(Path(accounts_file).read_text(encoding="utf-8"))
                            for a in data.get("accounts", []):
                                if a["id"] == account["id"]:
                                    a["status"] = "blocked"
                            Path(accounts_file).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                        except Exception:
                            pass
                        current_account = None
                        continue
                    # 세션 저장
                    try:
                        context.storage_state(path=str(session_path))
                    except Exception:
                        pass

                # 메시지 준비 + 발송
                message = self._format_message(template["body"], account, target)
                self._log(f"📤 ({idx+1}/{len(targets)}) @{target['username']} ← @{account['username']}")

                ok, msg = self.send_dm(page, target, message)

                if ok:
                    self.state["sent"] = self.state.get("sent", 0) + 1
                    self._update_account_stat(accounts_file, account["id"])
                    self._update_target_stat(targets_file, target["id"], "sent", account["username"])
                    self._log(f"  ✓ {msg}")
                else:
                    self.state["failed"] = self.state.get("failed", 0) + 1
                    self._update_target_stat(targets_file, target["id"], "failed", account["username"], msg)
                    self._log(f"  ✗ {msg}")

                # 다음 DM까지 인간 대기
                if idx < len(targets) - 1 and not self._should_stop():
                    wait_t = _human_sleep("between_dms")
                    self._log(f"  ⏱ {wait_t:.0f}초 대기 (인간 패턴)")

            # 종료
            try:
                if context:
                    context.storage_state(path=str(self._account_session_path(current_account["username"]))) if current_account else None
                    context.close()
            except Exception:
                pass
            try:
                if browser: browser.close()
            except Exception:
                pass

            self._log(f"🏁 종료: 성공 {self.state.get('sent', 0)} / 실패 {self.state.get('failed', 0)}")
