/*
 * 사용자 액션 자동 로깅 → 백엔드 → Drive 자동 sync.
 * 탭 전환 / 클릭 / 검색 등 주요 액션 기록.
 */
(function () {
  if (!window.api) return;

  // 디바운스용 큐 — 5초마다 묶어서 백엔드 호출
  const queue = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue.splice(0);
    // 각 액션 개별 POST (배치 endpoint 만들 수도 있지만 일단 단순)
    batch.forEach(entry => {
      api("/api/activity/log", { method: "POST", body: JSON.stringify(entry) }).catch(() => {});
    });
  }

  window.trackAction = function (action, opts = {}) {
    queue.push({
      action,
      tab: opts.tab || (document.querySelector(".side-item.active")?.dataset.tab || ""),
      target: opts.target || "",
      detail: opts.detail || {},
    });
    if (!flushTimer) flushTimer = setTimeout(flush, 5000);
  };

  // 탭 전환 자동 트래킹
  document.addEventListener("click", (e) => {
    const tab = e.target.closest(".side-item");
    if (tab) trackAction("tab_open", { tab: tab.dataset.tab });
  });

  // Drive sync 상태 사이드바 하단에 표시
  async function updateSyncStatus() {
    try {
      const r = await api("/api/drive/status");
      const el = document.getElementById("driveSyncStatus");
      if (!el) return;
      if (r.synced) {
        el.innerHTML = `☁️ Drive sync · ${r.elapsed_seconds}s 전`;
        el.style.color = "#2e7d32";
      } else {
        el.innerHTML = `☁️ Drive sync · 대기`;
        el.style.color = "#888";
      }
    } catch {}
  }
  setInterval(updateSyncStatus, 30000);
  setTimeout(updateSyncStatus, 2000);

  window.triggerDriveSync = async function (force = false) {
    try {
      const r = await api("/api/drive/sync", { method: "POST", body: JSON.stringify({ force }) });
      if (r.error) {
        window.showToast?.({ icon: "⚠️", title: "Drive sync 실패", body: r.error.slice(0, 100) });
      } else if (r.skipped) {
        window.showToast?.({ icon: "⏳", title: "쿨다운 중", body: r.reason });
      } else {
        window.showToast?.({
          icon: "☁️", title: "Drive sync 완료",
          body: `${r.uploaded?.length || 0}개 업로드`, accent: true,
        });
        updateSyncStatus();
      }
    } catch (e) {
      window.showToast?.({ icon: "⚠️", title: "Drive sync 실패", body: e.message });
    }
  };

  // 페이지 벗어날때 마지막 flush
  window.addEventListener("beforeunload", flush);
})();
