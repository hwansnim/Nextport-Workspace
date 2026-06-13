/*
 * 모바일 모드 토글.
 * localStorage 'mobile_mode' = '1' 이면 body에 .mobile-mode 박힘.
 * 화면 너비 < 760px 면 자동으로 박힘.
 */
(function () {
  const KEY = "nextport_mobile_mode";

  function apply() {
    const forced = localStorage.getItem(KEY) === "1";
    const auto = window.innerWidth < 760;
    document.body.classList.toggle("mobile-mode", forced || auto);
  }

  function bindToggle() {
    const cb = document.getElementById("mobileModeToggle");
    if (!cb) return;
    cb.checked = localStorage.getItem(KEY) === "1";
    cb.addEventListener("change", () => {
      if (cb.checked) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
      apply();
    });
  }

  // Drive 상태 표시 in settings
  async function bindDriveStatus() {
    const el = document.getElementById("settingsDriveStatus");
    if (!el) return;
    try {
      const r = await window.api("/api/drive/status");
      if (r.synced) {
        el.innerHTML = `✅ 마지막 sync: <b>${r.last_synced_at}</b> · ${r.elapsed_seconds}초 전 · 다음까지 ${r.next_in_seconds}초`;
      } else {
        el.innerHTML = `⏳ 아직 sync 안 됨. 우측 [지금 sync] 누르거나 5분 대기.`;
      }
    } catch (e) { el.textContent = "Drive 상태 확인 실패: " + e.message; }
  }

  // 사이드바 하단 햄버거 박기 (모바일 전용)
  function ensureMobileHamburger() {
    if (document.getElementById("mobileHamburger")) return;
    const btn = document.createElement("button");
    btn.id = "mobileHamburger";
    btn.className = "mobile-hamburger";
    btn.innerHTML = "☰";
    btn.title = "메뉴";
    btn.addEventListener("click", () => {
      document.body.classList.toggle("mobile-nav-open");
    });
    document.body.appendChild(btn);

    // 백드롭
    const bd = document.createElement("div");
    bd.id = "mobileNavBackdrop";
    bd.className = "mobile-nav-backdrop";
    bd.addEventListener("click", () => document.body.classList.remove("mobile-nav-open"));
    document.body.appendChild(bd);
  }

  // 사이드바 아이템 클릭 시 자동으로 메뉴 닫기 (모바일 모드)
  document.addEventListener("click", (e) => {
    if (e.target.closest(".side-item") && document.body.classList.contains("mobile-mode")) {
      document.body.classList.remove("mobile-nav-open");
    }
  });

  // 초기 + resize
  apply();
  ensureMobileHamburger();
  window.addEventListener("resize", apply);

  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item[data-tab="settings"]');
    if (t) setTimeout(() => { bindToggle(); bindDriveStatus(); }, 80);
  });

  // 페이지 로드 시도
  setTimeout(() => { bindToggle(); bindDriveStatus(); }, 600);
})();
