"""
인스타그램 셀러 콘텐츠 스크래퍼
- Playwright로 사용자가 로그인된 상태의 IG 접근
- 프로필 메타, 하이라이트(스토리), 피드 게시물, 릴스 수집
- 풀해상도 미디어 다운로드 (page-context fetch + base64 회수)
- Gemini Vision으로 자동 태깅
- Google Drive에 업로드
- manifest.json 갱신
"""
from __future__ import annotations

import base64
import json
import logging
import random
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright

log = logging.getLogger("scraper")

PROGRESS_CB = Callable[..., None]


def _sleep(cfg: dict[str, Any], multiplier: float = 1.0) -> None:
    lo = cfg.get("scraper", {}).get("delay_min_seconds", 2)
    hi = cfg.get("scraper", {}).get("delay_max_seconds", 4)
    time.sleep(random.uniform(lo, hi) * multiplier)


def _safe_filename(s: str, maxlen: int = 60) -> str:
    s = re.sub(r"[\\/:*?\"<>|\r\n\t]", "", s)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:maxlen] or "untitled"


# ─────────────────────────────────────────────────────────
# JS 페이로드들
# ─────────────────────────────────────────────────────────

JS_GET_PROFILE = r"""
(() => {
  const out = {};
  const h2 = document.querySelector('h2');
  out.username = h2 ? h2.innerText : null;

  // Stats: 게시물 / 팔로워 / 팔로우
  const statLinks = Array.from(document.querySelectorAll('a[href*="followers"], a[href*="following"]'));
  out.statsRaw = statLinks.map(a => a.innerText.trim()).slice(0, 6);

  // 카운트 숫자 추출 (li > span > span 구조)
  const statsItems = Array.from(document.querySelectorAll('header section ul li, header section > div ul li'));
  out.statsItems = statsItems.map(li => li.innerText.trim()).slice(0, 6);

  // 메타 태그에서 숫자 추출 (description meta 에 종종 들어있음)
  const metaDesc = document.querySelector('meta[property="og:description"], meta[name="description"]');
  out.metaDescription = metaDesc ? metaDesc.getAttribute('content') : '';

  // 프로필 사진 URL
  const profilePic = document.querySelector('header img[alt*="프로필"], header img[alt*="profile picture"], header img');
  out.profilePicUrl = profilePic ? profilePic.src : '';

  // Bio
  const header = document.querySelector('header');
  out.headerText = header ? header.innerText : '';

  // Display name (h2 또는 첫 큰 텍스트)
  const possibleName = document.querySelector('header section h1, header section h2, header section span');
  out.displayName = possibleName ? possibleName.innerText.trim() : '';

  // Highlight count
  const items = Array.from(document.querySelectorAll('a[aria-label*="하이라이트"], a[aria-label*="Highlight"], a[href*="/stories/highlights/"]'));
  out.highlightCount = items.length;
  out.highlightLabels = items.map(b => {
    const al = b.getAttribute('aria-label') || '';
    return al.replace('하이라이트 보기', '').replace('하이라이트', '').replace('Highlight:', '').replace('Highlight', '').trim();
  }).filter(Boolean).slice(0, 30);

  return out;
})()
"""


def _parse_count(text: str) -> int | None:
    """'5.1만', '12.3K', '1,234' 등을 숫자로 변환."""
    if not text:
        return None
    t = text.strip().replace(",", "").replace(" ", "")
    try:
        if t.endswith("만") or t.endswith("万"):
            return int(float(t[:-1]) * 10_000)
        if t.endswith("억"):
            return int(float(t[:-1]) * 100_000_000)
        if t.endswith("천"):
            return int(float(t[:-1]) * 1_000)
        if t.lower().endswith("k"):
            return int(float(t[:-1]) * 1_000)
        if t.lower().endswith("m"):
            return int(float(t[:-1]) * 1_000_000)
        if t.lower().endswith("b"):
            return int(float(t[:-1]) * 1_000_000_000)
        return int(float(t))
    except (ValueError, TypeError):
        return None


def _extract_profile_stats(meta: dict[str, Any]) -> dict[str, Any]:
    """수집된 프로필 메타에서 팔로워/팔로우/게시물 수 추출."""
    stats = {"posts": None, "followers": None, "following": None}

    # 한국어 패턴 우선
    header = meta.get("headerText", "") or ""
    # "게시물 548" / "팔로워 5.1만" / "팔로우 79"
    m_posts = re.search(r"게시물\s*([\d,.万千mMkKbB만천억]+)", header)
    m_followers = re.search(r"팔로워\s*([\d,.万千mMkKbB만천억]+)", header)
    m_following = re.search(r"팔로우\s*([\d,.万千mMkKbB만천억]+)", header)
    if m_posts:
        stats["posts"] = _parse_count(m_posts.group(1))
    if m_followers:
        stats["followers"] = _parse_count(m_followers.group(1))
    if m_following:
        stats["following"] = _parse_count(m_following.group(1))

    # 영어 fallback
    if not all(stats.values()):
        m_p = re.search(r"([\d,.kKmM]+)\s*posts?", header, re.IGNORECASE)
        m_fr = re.search(r"([\d,.kKmM]+)\s*followers?", header, re.IGNORECASE)
        m_fg = re.search(r"([\d,.kKmM]+)\s*following", header, re.IGNORECASE)
        if m_p and stats["posts"] is None:
            stats["posts"] = _parse_count(m_p.group(1))
        if m_fr and stats["followers"] is None:
            stats["followers"] = _parse_count(m_fr.group(1))
        if m_fg and stats["following"] is None:
            stats["following"] = _parse_count(m_fg.group(1))

    return stats

# Story viewer 안에서 현재 활성 스토리의 이미지 데이터를 base64로 가져옴
JS_FETCH_ACTIVE_STORY = r"""
async () => {
  // Strategy: pick the largest visible img with alt starting "Photo by"
  const allImgs = Array.from(document.querySelectorAll('img'));
  const visible = allImgs
    .map(img => ({ el: img, r: img.getBoundingClientRect(), alt: img.alt || '' }))
    .filter(x => x.r.width > 350 && x.r.height > 500 && (x.el.naturalWidth >= 400));

  const photoBy = visible.filter(x => x.alt.startsWith('Photo by'));
  const candidates = photoBy.length ? photoBy : visible;
  candidates.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
  const target = candidates[0];

  // Also check for video element overlapping the same area
  const videos = Array.from(document.querySelectorAll('video')).filter(v => {
    const r = v.getBoundingClientRect();
    return r.width > 300 && r.height > 400;
  });
  const activeVideo = videos[0];

  if (activeVideo) {
    const url = activeVideo.src || activeVideo.currentSrc;
    if (url) {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return {
          ok: true,
          kind: 'video',
          base64: btoa(bin),
          mime: res.headers.get('content-type') || 'video/mp4',
          width: activeVideo.videoWidth,
          height: activeVideo.videoHeight,
          duration: activeVideo.duration,
          size: bytes.length,
          alt: target ? target.alt : ''
        };
      } catch (e) {
        // fall through to image
      }
    }
  }

  if (!target) return { ok: false, reason: 'no-target' };

  let url = target.el.src;
  let widthPicked = target.el.naturalWidth;
  if (target.el.srcset) {
    const opts = target.el.srcset.split(',').map(s => {
      const [u, d] = s.trim().split(/\s+/);
      return { u, w: parseInt(d) || 0 };
    }).filter(o => o.u).sort((a, b) => b.w - a.w);
    if (opts.length && opts[0].w > widthPicked) {
      url = opts[0].u;
      widthPicked = opts[0].w;
    }
  }

  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return {
      ok: true,
      kind: 'image',
      base64: btoa(bin),
      mime: res.headers.get('content-type') || 'image/jpeg',
      width: target.el.naturalWidth,
      height: target.el.naturalHeight,
      alt: target.alt,
      size: bytes.length,
      pickedWidth: widthPicked
    };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
"""

# 진행 상태 추출 (현재/총 스토리 위치)
JS_PROGRESS_INFO = r"""
() => {
  // Progress bars at top of story viewer
  const bars = Array.from(document.querySelectorAll('div[role="progressbar"]'));
  // Header info
  const headerText = (document.querySelector('section header')?.innerText || '').trim();
  // username + time ago typically
  return {
    barCount: bars.length,
    headerText: headerText.slice(0, 200),
    url: location.href
  };
}
"""


# ─────────────────────────────────────────────────────────
# 메인 함수
# ─────────────────────────────────────────────────────────

def archive_seller(
    seller: dict[str, Any],
    config: dict[str, Any],
    on_progress: PROGRESS_CB | None = None,
) -> dict[str, Any]:
    """셀러 한 명의 콘텐츠 아카이빙."""
    progress = on_progress or (lambda **kw: None)

    # 의존 모듈 lazy import (없을 때 graceful fail)
    from manifest import ManifestManager
    try:
        from drive import DriveStore
        drive_available = True
    except Exception as e:  # noqa: BLE001
        log.warning(f"Drive 모듈 로드 실패 (로컬 저장 fallback): {e}")
        drive_available = False
        DriveStore = None  # type: ignore
    try:
        from gemini import GeminiTagger
        gemini_available = True
    except Exception as e:  # noqa: BLE001
        log.warning(f"Gemini 모듈 로드 실패 (태깅 스킵): {e}")
        gemini_available = False
        GeminiTagger = None  # type: ignore

    handle = seller["instagram"]
    seller_id = seller["id"]
    name = seller["name"]
    seller_folder_name = f"{seller_id}.{name}_@{handle}"

    progress(message=f"{name} 시작 — 브라우저 준비...", progress=0, total=0)

    project_root = Path(__file__).resolve().parent.parent
    profile_dir = project_root / config.get("scraper", {}).get("browser_profile_dir", "data/browser_profile")
    profile_dir.mkdir(parents=True, exist_ok=True)

    # 백엔드 초기화
    drive = None
    if drive_available:
        try:
            drive = DriveStore(config)
            drive.ensure_root()
            drive.ensure_seller_folder(seller_folder_name)
        except Exception as e:  # noqa: BLE001
            log.error(f"Drive 초기화 실패: {e} — 로컬 저장으로 fallback")
            drive = None

    local_root = project_root / "data" / "local_archive" / seller_folder_name
    if drive is None:
        local_root.mkdir(parents=True, exist_ok=True)

    manifest = ManifestManager(seller_folder_name, drive=drive, local_root=local_root)
    manifest.load()
    # 기존 아이템들에 content_hash 채우기 (이전 버전 호환 + 중복 방지)
    try:
        backfilled = manifest.backfill_hashes(local_root)
        if backfilled:
            log.info(f"backfilled {backfilled} item hashes")
            manifest.save()
    except Exception as e:  # noqa: BLE001
        log.warning(f"backfill 실패: {e}")

    tagger = None
    if gemini_available:
        try:
            tagger = GeminiTagger(config)
        except Exception as e:  # noqa: BLE001
            log.error(f"Gemini 초기화 실패: {e} — 태깅 스킵")
            tagger = None

    items_added = 0
    max_stories = config.get("scraper", {}).get("max_stories_per_highlight", 50)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=False,
            viewport={"width": 1280, "height": 900},
            locale="ko-KR",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = context.new_page()
        try:
            page.goto(f"https://www.instagram.com/{handle}/", wait_until="domcontentloaded")
            _sleep(config)

            if "/accounts/login" in page.url:
                progress(
                    message="❗ 인스타그램 로그인 필요. 열린 브라우저 창에서 로그인 후 다시 업데이트 눌러주세요.",
                )
                return {"items_added": 0, "needs_login": True}

            # 로그인 여부 검증: sessionid 쿠키가 있으면 로그인된 것으로 간주
            cookies = context.cookies("https://www.instagram.com")
            has_sessionid = any(c.get("name") == "sessionid" and c.get("value") for c in cookies)
            log.info(f"login check: cookies={len(cookies)}, sessionid={has_sessionid}")
            logged_in = has_sessionid

            if not logged_in:
                progress(
                    message="❗ IG 로그인이 안 되어 있습니다. 우측 상단 [📷 인스타 로그인] 버튼 먼저 눌러주세요.",
                )
                return {"items_added": 0, "needs_login": True}

            # 프로필 메타
            progress(message=f"{name} 프로필 메타 수집...", progress=1, total=10)
            meta = page.evaluate(JS_GET_PROFILE)
            stats = _extract_profile_stats(meta)
            manifest.update_profile_meta({
                "instagram": handle,
                "username_text": meta.get("username"),
                "display_name": meta.get("displayName") or "",
                "header_text": (meta.get("headerText") or "")[:600],
                "meta_description": (meta.get("metaDescription") or "")[:300],
                "profile_pic_url": meta.get("profilePicUrl") or "",
                "stats_raw": meta.get("statsRaw"),
                "stats": stats,  # {posts, followers, following}
                "highlight_labels": meta.get("highlightLabels", []),
                "last_scraped_at": datetime.now().isoformat(timespec="seconds"),
            })
            # 매번 메타는 즉시 저장 (스크랩 도중 멈춰도 메타는 보존)
            try:
                manifest.save()
            except Exception as e:  # noqa: BLE001
                log.warning(f"중간 manifest 저장 실패: {e}")

            highlights = meta.get("highlightLabels", [])
            n_highlights = len(highlights)
            progress(
                message=f"{name}: 하이라이트 {n_highlights}개 / 스토리 순회 시작",
                progress=2,
                total=max(10, n_highlights * 5),
            )

            # ─── 하이라이트 순회 ───
            # 한국어 IG: aria-label 이 "XXX 하이라이트 보기" 인 링크
            # 영어 IG: aria-label 이 "Highlight: XXX" 등
            highlight_items = page.locator(
                'a[aria-label*="하이라이트"], a[aria-label*="Highlight"], a[href*="/stories/highlights/"]'
            )
            try:
                count = highlight_items.count()
            except Exception:
                count = 0

            if count == 0:
                progress(message=f"{name}: 하이라이트가 없거나 로그인이 필요합니다 (highlight 0개)")

            for h_idx in range(count):
                btn = highlight_items.nth(h_idx)
                try:
                    label_attr = btn.get_attribute("aria-label") or ""
                    # "XXX 하이라이트 보기" -> "XXX"
                    label = (
                        label_attr.replace("하이라이트 보기", "")
                        .replace("하이라이트", "")
                        .replace("Highlight:", "")
                        .replace("Highlight", "")
                        .strip()
                        or f"highlight_{h_idx}"
                    )
                except Exception:
                    label = f"highlight_{h_idx}"

                progress(message=f"하이라이트 [{h_idx + 1}/{count}] {label}", progress=h_idx + 2, total=count + 5)

                try:
                    btn.click(timeout=5000)
                except Exception as e:  # noqa: BLE001
                    log.warning(f"하이라이트 클릭 실패 ({label}): {e}")
                    continue

                _sleep(config, multiplier=0.7)
                # 스토리 시작 → 일시정지 위해 space
                try:
                    page.keyboard.press(" ")
                except Exception:
                    pass
                _sleep(config, multiplier=0.4)

                # 스토리 순회
                seen = 0
                for s_idx in range(max_stories):
                    try:
                        result = page.evaluate(JS_FETCH_ACTIVE_STORY)
                    except Exception as e:  # noqa: BLE001
                        log.warning(f"story fetch 실패: {e}")
                        result = {"ok": False, "reason": str(e)}

                    if result.get("ok"):
                        data = base64.b64decode(result["base64"])
                        # 콘텐츠 해시 기반 dedup (positional id 보다 안정적)
                        import hashlib
                        content_hash = hashlib.sha256(data).hexdigest()[:16]
                        if manifest.has_hash(content_hash):
                            # 이미 받은 콘텐츠 — 건너뜀
                            try:
                                page.keyboard.press("ArrowRight")
                            except Exception:
                                pass
                            _sleep(config, multiplier=0.4)
                            continue
                        item_id = f"{seller_id}_h{h_idx:02d}_{content_hash}"
                        if not manifest.has_item(item_id):
                            ext = "mp4" if result.get("kind") == "video" else "jpg"
                            fname = f"{datetime.now().strftime('%Y-%m-%d')}_{s_idx:03d}_{_safe_filename(label)}.{ext}"
                            rel_path = f"highlights/{_safe_filename(label, 40)}/{fname}"

                            # 저장
                            file_meta = _save_media(rel_path, data, drive=drive, local_root=local_root)
                            log.info(f"saved: {rel_path} ({len(data)} bytes)")

                            # Gemini 태깅 (이미지만 — 비디오는 다음 단계)
                            tags = {}
                            if tagger and result.get("kind") == "image":
                                try:
                                    tags = tagger.analyze_image(data, alt_text=result.get("alt", ""))
                                except Exception as e:  # noqa: BLE001
                                    log.warning(f"Gemini 태깅 실패: {e}")

                            manifest.add_item({
                                "id": item_id,
                                "content_hash": content_hash,
                                "type": "highlight_story",
                                "media": result.get("kind", "image"),
                                "highlight_label": label,
                                "highlight_index": h_idx,
                                "story_index": s_idx,
                                "file_path": rel_path,
                                "drive_id": file_meta.get("drive_id"),
                                "stored": file_meta.get("stored"),
                                "size": result.get("size"),
                                "width": result.get("width"),
                                "height": result.get("height"),
                                "alt_text": result.get("alt", ""),
                                "captured_at": datetime.now().isoformat(timespec="seconds"),
                                **tags,
                            })
                            items_added += 1
                            seen += 1
                            # 매 10개마다 manifest 중간 저장 (중단되도 손실 최소)
                            if items_added % 10 == 0:
                                try:
                                    manifest.save()
                                except Exception:
                                    pass

                    # 다음 스토리로
                    try:
                        page.keyboard.press("ArrowRight")
                    except Exception:
                        break
                    _sleep(config, multiplier=0.5)

                    # 만약 진행이 안 된다면(끝났다면) URL 변경 또는 viewer 닫힘 확인
                    if "/stories/highlights/" not in page.url:
                        break

                # 하이라이트 끝 → ESC 로 닫기
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass
                _sleep(config)

            # 매 셀러 완료시 manifest 저장
            manifest.save()

        finally:
            context.close()

    progress(message=f"{name} 완료 — {items_added}개 추가", progress=count + 5, total=count + 5)
    return {"items_added": items_added, "meta": meta}


def _save_media(rel_path: str, data: bytes, *, drive: Any | None, local_root: Path) -> dict[str, Any]:
    """Drive 가능하면 Drive에, 아니면 로컬에 저장."""
    if drive is not None:
        try:
            file_id = drive.upload_bytes(rel_path, data)
            return {"drive_id": file_id, "stored": "drive"}
        except Exception as e:  # noqa: BLE001
            log.error(f"Drive 업로드 실패 ({rel_path}): {e} — 로컬 fallback")
    full = local_root / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(data)
    return {"drive_id": None, "stored": "local", "local_path": str(full)}


def login_helper(config: dict[str, Any], on_progress: PROGRESS_CB | None = None) -> dict[str, Any]:
    """IG 로그인 전용 헬퍼.
    Playwright Chrome 창을 열고, 사용자가 로그인할 때까지 기다린 후 종료.
    세션은 persistent context에 저장되어 다음 업데이트부터는 자동 사용.
    """
    progress = on_progress or (lambda **kw: None)
    project_root = Path(__file__).resolve().parent.parent
    profile_dir = project_root / config.get("scraper", {}).get("browser_profile_dir", "data/browser_profile")
    profile_dir.mkdir(parents=True, exist_ok=True)

    progress(message="브라우저 창을 띄우는 중... 잠시만요", progress=0, total=10)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=False,
            viewport={"width": 1100, "height": 800},
            locale="ko-KR",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = context.new_page()
        page.goto("https://www.instagram.com/", wait_until="domcontentloaded")

        progress(
            message="새로 열린 Chrome 창에서 인스타그램에 로그인해주세요. 로그인 완료되면 자동 감지됩니다.",
            progress=1, total=10,
        )

        # 5분 동안 로그인 폴링 (sessionid 쿠키 기준)
        success = False
        for i in range(60):  # 60 * 5초 = 5분
            time.sleep(5)
            try:
                cookies = context.cookies("https://www.instagram.com")
                has_sessionid = any(c.get("name") == "sessionid" and c.get("value") for c in cookies)
                if has_sessionid:
                    success = True
                    progress(message="로그인 감지됨! 세션 저장 중...", progress=9, total=10)
                    time.sleep(3)  # 쿠키 디스크 저장 시간
                    break
                progress(
                    message=f"로그인 대기 중... ({(i+1)*5}초 / 300초)",
                    progress=min(i + 1, 8), total=10,
                )
            except Exception as e:  # noqa: BLE001
                log.warning(f"로그인 폴링 에러: {e}")

        context.close()

    if success:
        progress(message="✅ IG 로그인 완료. 이제 셀러 업데이트하세요.", progress=10, total=10)
    else:
        progress(message="⏰ 5분 내 로그인 안 됨. 다시 시도해주세요.", progress=10, total=10)

    return {"logged_in": success}


if __name__ == "__main__":
    cfg_path = Path(__file__).resolve().parent.parent / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    test_seller = {"id": "001", "name": "야곰", "instagram": "ya_gomi"}
    result = archive_seller(test_seller, cfg, lambda **kw: print(kw))
    print(json.dumps(result, ensure_ascii=False, indent=2))
