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
        'form[id="login_form"] input[type="submit"]',
        'button[type="submit"]',
        'input[type="submit"]',
        'div[role="button"]:has-text("로그인")',
        'div[role="button"]:has-text("Log in")',
    ],
    "follow_button": [
        'header button:has-text("팔로우")',
        'header button:has-text("Follow")',
        'div[role="button"]:has-text("팔로우")',
        'button:has-text("Follow")',
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


# 봇탐지/계정차단/인증 화면 감지 — 여기 걸리면 그 계정은 건너뛰고 로그에 표시
CHECKPOINT_URL_HINTS = [
    "challenge", "two_factor", "auth_platform/codeentry", "accounts/suspended",
    "accounts/disabled", "/accounts/onetap", "checkpoint",
]
CHECKPOINT_TEXT_HINTS = [
    "인증", "두 단계", "사람인지", "본인 확인", "확인 코드", "보안 코드",
    "잠시 후 다시", "나중에 다시", "Try Again Later", "suspicious",
    "unusual activity", "계정이 일시", "계정을 보호", "도움이 필요",
    "Help us confirm", "Enter the code", "We Detected",
]


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

    def _api_session_path(self, username: str) -> Path:
        # instagrapi 전용 세션(브라우저 storage_state와 포맷 다름)
        safe = "".join(c for c in username if c.isalnum() or c in "._@-")
        return self.session_dir / f"{safe}.api.json"

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

    def _is_checkpoint(self, page) -> bool:
        """봇탐지/인증/차단 화면인지 — 걸리면 그 계정 사용 중단."""
        try:
            url = (page.url or "").lower()
            if any(h in url for h in CHECKPOINT_URL_HINTS):
                return True
            body = page.content() or ""
            return any(t in body for t in CHECKPOINT_TEXT_HINTS)
        except Exception:
            return False

    def _try_follow(self, page) -> None:
        """프로필에서 팔로우 (DM 요청이 '알 수도 있는 사람'에 뜨도록)."""
        try:
            btn = _try_selectors(page, SELECTORS["follow_button"], timeout_ms=2500)
            if btn:
                btn.click()
                _human_sleep("after_nav")
                self._log("    👤 자동 팔로우")
        except Exception:
            pass

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

    def send_dm(self, page, target: dict, message: str, auto_follow: bool = False) -> tuple[bool, str]:
        """한 명에게 DM 발송. 반환: (성공, 메시지)."""
        username = target["username"]
        try:
            self.state["current"] = f"@{username}"

            # 프로필 페이지로 이동
            page.goto(f"https://www.instagram.com/{username}/", timeout=30000)
            _human_sleep("after_nav")
            self._dismiss_popups(page)

            # (옵션) 팔로우 먼저
            if auto_follow:
                self._try_follow(page)

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

    # ─── 엑셀 행기반 발송 (회사 DM_Sender_GUI v2.2.2 양식) ───
    # ─── 영구 일일 발송 카운트 (계정 보호) ───
    def _counts_path(self) -> Path:
        return self.session_dir.parent / "dm_send_counts.json"

    def _load_counts(self) -> dict:
        p = self._counts_path()
        if not p.exists():
            return {}
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _today_count(self, sender_id: str) -> int:
        from datetime import datetime as _dt
        today = _dt.now().date().isoformat()
        return int((self._load_counts().get(sender_id) or {}).get(today, 0))

    def _bump_count(self, sender_id: str) -> None:
        from datetime import datetime as _dt
        today = _dt.now().date().isoformat()
        data = self._load_counts()
        rec = data.setdefault(sender_id, {})
        rec[today] = int(rec.get(today, 0)) + 1
        try:  # 최근 14일만 유지
            for k in sorted(rec.keys())[:-14]:
                rec.pop(k, None)
        except Exception:
            pass
        try:
            self._counts_path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _run_instagrapi(self, rows: list[dict], o: dict, auto_follow: bool) -> list[dict]:
        """instagrapi 직접 API 발송 — 브라우저 안 띄움. 친구 앱과 동일 방식."""
        from instagrapi import Client
        from instagrapi.exceptions import (
            ChallengeRequired, PleaseWaitFewMinutes, UserNotFound, FeedbackRequired)
        from collections import OrderedDict

        groups: "OrderedDict[str, list]" = OrderedDict()
        for r in rows:
            groups.setdefault((r.get("sender_id") or "").strip(), []).append(r)
        self.state["total"] = len(rows)
        for k in ("sent", "failed", "held"):
            self.state.setdefault(k, 0)
        self._log(f"🛡 안전 모드 (instagrapi · 창 없음) — 계정당 하루 {o['daily_limit']}건·한번 {o['batch_limit']}건, "
                  f"간격 {o['gap_min']}~{o['gap_max']}초, {o['break_every']}건마다 휴식")

        for acc_idx, (sender_id, acc_rows) in enumerate(groups.items()):
            if self._should_stop():
                self._log("⏹ 사용자 중지")
                break
            today_cnt = self._today_count(sender_id)
            remaining = max(0, o["daily_limit"] - today_cnt)
            allow = min(len(acc_rows), o["batch_limit"], remaining)
            self._log(f"🌐 계정 {acc_idx+1}/{len(groups)}: @{sender_id} — 오늘 {today_cnt}/{o['daily_limit']}건 발송됨, 이번 {allow}건")
            if allow <= 0:
                for r in acc_rows:
                    r["status"], r["reason"] = "보류", f"일일 한도 도달({today_cnt}/{o['daily_limit']}) — 내일 다시"
                    self.state["held"] += 1
                self._log(f"  ⏸ @{sender_id} 일일 한도 도달 — 계정 보호 위해 건너뜀")
                continue
            for r in acc_rows[allow:]:
                r["status"], r["reason"] = "보류", f"이번 회차 한도(배치 {o['batch_limit']}·일일 {o['daily_limit']}) — 다음에"
                self.state["held"] += 1
            work = acc_rows[:allow]
            sender_pw = (work[0].get("sender_pw") or "").strip()
            sender_name = work[0].get("sender_name") or ""

            cl = Client()
            cl.delay_range = [2, 5]  # 요청 사이 내장 랜덤 딜레이
            sp = self._api_session_path(sender_id)
            if sp.exists():
                try:
                    cl.load_settings(sp)  # 세션 재사용 = 재로그인 안 함
                except Exception:
                    pass
            login_ok = False
            try:
                self._log(f"  🔐 로그인 @{sender_id}")
                cl.login(sender_id, sender_pw)
                login_ok = True
                try:
                    cl.dump_settings(sp)
                except Exception:
                    pass
            except ChallengeRequired:
                self._log(f"  🚫 @{sender_id} 문자/사람인증 필요 — 이 계정 건너뜀 (수동 인증 후 재시도)")
            except Exception as e:
                self._log(f"  ❌ @{sender_id} 로그인 실패: {str(e)[:90]}")

            sent_since_break = 0
            for ri, r in enumerate(work):
                if self._should_stop():
                    break
                tgt = (r.get("target_id") or "").strip().lstrip("@")
                self.state["current"] = f"@{tgt}"
                if not login_ok:
                    r["status"], r["reason"] = "실패", "계정 로그인 실패/인증필요 (수동 로그인 확인)"
                    self.state["failed"] += 1
                    self._log(f"  ✗ @{tgt} — 로그인 실패")
                    continue
                msg = (r.get("message") or "")
                msg = msg.replace("[name]", sender_name).replace("[targetname]", r.get("target_name") or "")
                try:
                    uid = int(cl.user_id_from_username(tgt))
                    if auto_follow:
                        try:
                            cl.user_follow(uid)
                        except Exception:
                            pass
                    cl.direct_send(msg, user_ids=[uid])
                    r["status"], r["reason"] = "성공", ""
                    self.state["sent"] += 1
                    self._bump_count(sender_id)
                    sent_since_break += 1
                    self._log(f"  ✓ ({self.state['sent']}) @{tgt}")
                except UserNotFound:
                    r["status"], r["reason"] = "실패", "프로필 없음/비공개"
                    self.state["failed"] += 1
                    self._log(f"  ✗ @{tgt} — 프로필 없음")
                except (PleaseWaitFewMinutes, FeedbackRequired):
                    r["status"], r["reason"] = "실패", "속도제한/차단 감지 — 이 계정 중단(보호)"
                    self.state["failed"] += 1
                    self._log(f"  🚫 @{tgt} — 차단/제한 감지, 계정 중단")
                    break
                except ChallengeRequired:
                    r["status"], r["reason"] = "실패", "인증 화면 — 계정 중단"
                    self.state["failed"] += 1
                    self._log(f"  🚫 @{tgt} — 인증 요구, 계정 중단")
                    break
                except Exception as e:
                    r["status"], r["reason"] = "실패", str(e)[:90]
                    self.state["failed"] += 1
                    self._log(f"  ✗ @{tgt} — {str(e)[:60]}")
                if ri < len(work) - 1 and not self._should_stop():
                    if sent_since_break >= o["break_every"]:
                        bt = random.uniform(o["break_min"], o["break_max"])
                        self._log(f"    ☕ 휴식 {bt/60:.1f}분 (봇탐지 회피)")
                        time.sleep(bt)
                        sent_since_break = 0
                    else:
                        gt = random.uniform(o["gap_min"], o["gap_max"])
                        self._log(f"    ⏱ {gt:.0f}초 대기")
                        time.sleep(gt)

        for r in rows:
            r.setdefault("status", "미발송")
            r.setdefault("reason", "")
        self._log(f"🏁 종료: 성공 {self.state.get('sent',0)} / 실패 {self.state.get('failed',0)} / 보류 {self.state.get('held',0)} / 전체 {len(rows)}")
        return rows

    def run_excel_rows(self, rows: list[dict], auto_follow: bool = False, opts: dict = None) -> list[dict]:
        """엑셀 행 그대로 발송. 각 row 키:
        sender_id, sender_pw, sender_name, target_id, target_name, message
        → 같은 발신계정끼리 묶어 세션 재사용 로그인 후 발송.
        opts(안전 모드): daily_limit / batch_limit / gap_min / gap_max / break_every / break_min / break_max
        결과로 각 row에 status('성공'/'실패'/'보류') + reason 채워서 반환."""
        # 안전 기본값 — 정지(밴) 최대한 회피
        o = {"daily_limit": 30, "batch_limit": 10, "gap_min": 60, "gap_max": 300,
             "break_every": 6, "break_min": 180, "break_max": 600}
        for k, v in (opts or {}).items():
            if v is not None:
                try:
                    o[k] = int(v)
                except Exception:
                    pass

        # 백엔드: instagrapi(브라우저 없이 인스타 API 직접 호출) 우선 — 창 안 뜸·가볍고 덜 막힘.
        # 없거나 실패하면 Playwright(브라우저) 폴백.
        try:
            import instagrapi  # noqa: F401
            return self._run_instagrapi(rows, o, auto_follow)
        except ImportError:
            self._log("instagrapi 미설치 → 브라우저(Playwright) 방식으로 폴백")

        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self._log("❌ Playwright 도 안 깔림. 'pip install instagrapi' 또는 'playwright install chromium' 필요.")
            for r in rows:
                r["status"], r["reason"] = "실패", "발송 엔진 미설치"
            return rows

        from collections import OrderedDict
        groups: "OrderedDict[str, list]" = OrderedDict()
        for r in rows:
            groups.setdefault((r.get("sender_id") or "").strip(), []).append(r)

        self.state["total"] = len(rows)
        self.state.setdefault("sent", 0)
        self.state.setdefault("failed", 0)
        self.state.setdefault("held", 0)
        self._log(f"🛡 안전 모드 — 계정당 하루 {o['daily_limit']}건·한번 {o['batch_limit']}건, "
                  f"간격 {o['gap_min']}~{o['gap_max']}초, {o['break_every']}건마다 휴식")
        done = 0
        UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

        with sync_playwright() as p:
            for acc_idx, (sender_id, acc_rows) in enumerate(groups.items()):
                if self._should_stop():
                    self._log("⏹ 사용자 중지")
                    break
                # 🔒 양 제한 — 오늘 누적 + 이번 배치 한도
                today_cnt = self._today_count(sender_id)
                remaining = max(0, o["daily_limit"] - today_cnt)
                allow = min(len(acc_rows), o["batch_limit"], remaining)
                self._log(f"🌐 계정 {acc_idx+1}/{len(groups)}: @{sender_id} — 오늘 {today_cnt}/{o['daily_limit']}건 발송됨, 이번 {allow}건")
                if allow <= 0:
                    for r in acc_rows:
                        r["status"], r["reason"] = "보류", f"일일 한도 도달({today_cnt}/{o['daily_limit']}) — 내일 다시"
                        self.state["held"] += 1
                    self._log(f"  ⏸ @{sender_id} 일일 한도 도달 — 계정 보호 위해 건너뜀")
                    continue
                for r in acc_rows[allow:]:  # 한도 초과분 보류
                    r["status"], r["reason"] = "보류", f"이번 회차 한도(배치 {o['batch_limit']}·일일 {o['daily_limit']}) — 다음에"
                    self.state["held"] += 1
                work = acc_rows[:allow]
                sender_pw = (work[0].get("sender_pw") or "").strip()
                sender_name = work[0].get("sender_name") or ""

                browser = context = page = None
                login_ok = False
                try:
                    browser = p.chromium.launch(
                        headless=False,
                        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
                    )
                    session_path = self._account_session_path(sender_id)
                    ctx_opts = {"viewport": {"width": 1280, "height": 800},
                                "user_agent": UA, "locale": "ko-KR"}
                    if session_path.exists():  # 세션 재사용 = 재로그인 안 함(의심 회피)
                        ctx_opts["storage_state"] = str(session_path)
                    context = browser.new_context(**ctx_opts)
                    page = context.new_page()
                    login_ok = self.login(page, {"username": sender_id, "password": sender_pw})
                    if login_ok and self._is_checkpoint(page):
                        login_ok = False
                        self._log(f"  🚫 @{sender_id} 인증/차단 화면 (문자·사람인증) — 계정 건너뜀. 수동 로그인 필요!")
                    if login_ok:
                        try:
                            context.storage_state(path=str(session_path))
                        except Exception:
                            pass
                except Exception as e:
                    login_ok = False
                    self._log(f"  ❌ 브라우저/로그인 오류: {str(e)[:90]}")

                sent_since_break = 0
                for ri, r in enumerate(work):
                    if self._should_stop():
                        break
                    done += 1
                    tgt = (r.get("target_id") or "").strip()
                    self.state["current"] = f"@{tgt}"
                    if not login_ok:
                        r["status"], r["reason"] = "실패", "계정 로그인 실패/차단 (수동 로그인 확인)"
                        self.state["failed"] += 1
                        self._log(f"  ✗ @{tgt} — {r['reason']}")
                        continue
                    msg = (r.get("message") or "")
                    msg = msg.replace("[name]", sender_name).replace("[targetname]", r.get("target_name") or "")
                    ok, reason = self.send_dm(page, {"username": tgt}, msg, auto_follow=auto_follow)
                    # 발송 직후 차단/인증 화면 → 이 계정 즉시 중단(밀어붙이지 않음)
                    if not ok and self._is_checkpoint(page):
                        r["status"], r["reason"] = "실패", "계정 차단/인증 화면 — 이후 발송 중단"
                        self.state["failed"] += 1
                        self._log(f"  🚫 @{tgt} — 차단 감지, 이 계정 중단(보호)")
                        break
                    r["status"], r["reason"] = ("성공", "") if ok else ("실패", reason)
                    if ok:
                        self.state["sent"] += 1
                        self._bump_count(sender_id)
                        sent_since_break += 1
                        self._log(f"  ✓ ({self.state['sent']}) @{tgt}")
                    else:
                        self.state["failed"] += 1
                        self._log(f"  ✗ @{tgt} — {reason}")
                    # 리듬 — 간격 + 주기적 긴 휴식
                    if ri < len(work) - 1 and not self._should_stop():
                        if sent_since_break >= o["break_every"]:
                            bt = random.uniform(o["break_min"], o["break_max"])
                            self._log(f"    ☕ 휴식 {bt/60:.1f}분 (봇탐지 회피)")
                            time.sleep(bt)
                            sent_since_break = 0
                        else:
                            gt = random.uniform(o["gap_min"], o["gap_max"])
                            self._log(f"    ⏱ {gt:.0f}초 대기")
                            time.sleep(gt)

                try:
                    if context:
                        context.close()
                    if browser:
                        browser.close()
                except Exception:
                    pass

        for r in rows:
            r.setdefault("status", "미발송")
            r.setdefault("reason", "")
        self._log(f"🏁 종료: 성공 {self.state.get('sent',0)} / 실패 {self.state.get('failed',0)} / 보류 {self.state.get('held',0)} / 전체 {len(rows)}")
        return rows
