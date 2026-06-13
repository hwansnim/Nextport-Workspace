/*
 * Phase D — 라이브 발송 / 회신 현황 / 데일리 통계 위젯.
 */
(function () {
  if (!window.api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));

  const state = {
    live: { current: null, log: [], running: false },
    livePollTimer: null,
    replies: [],
    repliesQ: "",
  };

  // ─── LIVE 발송 상태 ─────────────────────────────────────
  async function loadLive() {
    try {
      const r = await api("/api/dm/live");
      state.live = r;
      renderLive();
      updateLiveBadge();
    } catch (e) { console.error(e); }
  }

  function updateLiveBadge() {
    const badge = $("#dmLiveBadge");
    if (!badge) return;
    if (state.live.running) {
      badge.textContent = "●";
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function renderLive() {
    const stat = $("#dmLiveStat");
    if (stat) {
      stat.textContent = state.live.running
        ? "🟢 발송 중"
        : (state.live.log?.length ? "대기 중" : "발송 안 함");
    }

    const now = $("#dmLiveNow");
    if (now) {
      if (state.live.current) {
        const c = state.live.current;
        const elapsed = c.started_at ?
          Math.floor((Date.now() - new Date(c.started_at).getTime()) / 1000) : 0;
        now.innerHTML = `
          <div class="live-now-card">
            <div class="live-row">
              <div class="live-label">발송 계정</div>
              <div class="live-val"><b>@${esc(c.account_handle || "?")}</b></div>
            </div>
            <div class="live-arrow">→</div>
            <div class="live-row">
              <div class="live-label">받는 셀러</div>
              <div class="live-val">
                <b>@${esc(c.influencer_handle || "?")}</b>
                <span class="hint">${esc(c.seller_name || "")}</span>
              </div>
            </div>
            <div class="live-row">
              <div class="live-label">차수</div>
              <div class="live-val">${c.send_count || "?"}차</div>
            </div>
            <div class="live-row">
              <div class="live-label">경과</div>
              <div class="live-val">${elapsed}초</div>
            </div>
            <div class="live-msg">
              <div class="live-label">메시지</div>
              <div class="live-msg-text">${esc(c.message_preview || "")}</div>
            </div>
          </div>
        `;
      } else {
        now.innerHTML = `
          <div class="empty" style="padding:30px;text-align:center;color:#888">
            발송 중인 작업 없음. <br><br>
            <span style="font-size:12px">[📤 데일리 DM 관리] 탭에서 발송 시작 가능</span>
          </div>
        `;
      }
    }

    const log = $("#dmLiveLog");
    const logStat = $("#dmLiveLogStat");
    if (logStat) logStat.textContent = `${state.live.log_count || 0}건`;
    if (log) {
      if (!state.live.log || !state.live.log.length) {
        log.innerHTML = `<div class="empty" style="padding:20px;text-align:center;color:#888;font-size:12px">로그 없음</div>`;
      } else {
        log.innerHTML = state.live.log.map(e => {
          const ts = (e.ts || "").slice(11, 19);
          const cls = e.status === "fail" ? "fail" : (e.type === "start" ? "start" : "ok");
          const ico = e.type === "start" ? "▶️" : (e.status === "fail" ? "❌" : "✓");
          return `
            <div class="live-log-row ${cls}">
              <span class="ll-ts">${esc(ts)}</span>
              <span class="ll-ico">${ico}</span>
              <span class="ll-acc">@${esc(e.account || "?")}</span>
              <span class="ll-arrow">→</span>
              <span class="ll-tgt">@${esc(e.target || "?")}</span>
              <span class="ll-msg">${esc(e.message || e.error || "")}</span>
            </div>
          `;
        }).join("");
      }
    }
  }

  function startLivePolling() {
    if (state.livePollTimer) return;
    state.livePollTimer = setInterval(loadLive, 2500);
  }

  function stopLivePolling() {
    if (state.livePollTimer) {
      clearInterval(state.livePollTimer);
      state.livePollTimer = null;
    }
  }

  // ─── 데일리 통계 ────────────────────────────────────────
  async function loadDailyStats() {
    try {
      const r = await api("/api/dm/daily_stats");
      $("#statCandidates") && ($("#statCandidates").textContent = r.candidates ?? "—");
      $("#statActiveAcc") && ($("#statActiveAcc").textContent = r.active_accounts ?? "—");
      $("#statSentToday") && ($("#statSentToday").textContent = r.sent_today ?? "—");
      $("#statReplies") && ($("#statReplies").textContent = r.replies ?? "—");
    } catch (e) { console.error(e); }
  }

  // ─── 회신 인플루언서 현황 ───────────────────────────────
  async function loadReplies() {
    try {
      const r = await api(`/api/dm/replies?q=${encodeURIComponent(state.repliesQ)}`);
      state.replies = r.replies || [];
      renderReplies(r.total);
      updateRepliesBadge(r.total);
    } catch (e) { console.error(e); }
  }

  function updateRepliesBadge(n) {
    const badge = $("#repliesBadge");
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? "99+" : n;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function renderReplies(total) {
    const stat = $("#repliesStat");
    if (stat) stat.textContent = `${total || 0}건`;
    const body = $("#repliesBody");
    if (!body) return;
    if (!state.replies.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">아직 답장 받은 인플루언서 없음</td></tr>`;
      return;
    }
    body.innerHTML = state.replies.map(r => `
      <tr>
        <td><b>${esc(r.seller_name || "-")}</b></td>
        <td>@${esc(r.influencer_handle || "?")}</td>
        <td style="font-size:11px">@${esc(r.our_account_handle || "?")}</td>
        <td style="text-align:center">${r.send_count != null ? r.send_count + "차" : "-"}</td>
        <td style="font-size:11px;color:#888">${esc(r.last_sent_date || "-")}</td>
        <td style="font-size:11px;color:var(--accent);font-weight:600">${esc((r.last_reply_at || "").replace("T", " ").slice(0, 16))}</td>
        <td style="font-size:11.5px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.last_message_preview || '')}">${esc((r.last_message_preview || "").slice(0, 40))}</td>
        <td><button class="btn-text" data-v2="replies-open" data-cid="${esc(r.conv_id)}">💬 대화</button></td>
      </tr>
    `).join("");
  }

  // ─── EVENT HANDLERS ─────────────────────────────────────
  document.addEventListener("click", async (e) => {
    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    if (what === "live-clear") {
      try {
        await api("/api/dm/live/clear", { method: "POST" });
        await loadLive();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "live-pause") {
      try {
        const r = await api("/api/dm/live/pause", { method: "POST" });
        trg.textContent = r.paused ? "▶️ 재개" : "⏸ 일시정지";
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "live-export") {
      // CSV 다운로드 — 클라이언트 사이드 변환
      if (!state.live.log?.length) { alert("로그 비어있음"); return; }
      const csv = ["ts,type,account,target,status,message"]
        .concat(state.live.log.map(e =>
          [e.ts, e.type || "", e.account || "", e.target || "", e.status || "", (e.message || e.error || "").replace(/,/g, " ")].join(",")))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dm_live_log_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (what === "replies-open") {
      // 회신 탭에서 대화 클릭 → DM (수신) 탭으로 이동 + 그 대화 열기
      const cid = trg.dataset.cid;
      const inboxTab = document.querySelector('.side-item[data-tab="dm-inbox"]');
      if (inboxTab) inboxTab.click();
      // dm-queue-inbox.js 의 openConversation 호출
      setTimeout(() => {
        const convEl = document.querySelector(`[data-v2="open-conv"][data-cid="${cid}"]`);
        if (convEl) convEl.click();
      }, 300);
      return;
    }
  });

  let repliesSearchTimer;
  document.addEventListener("input", (e) => {
    if (e.target.id === "repliesSearch") {
      clearTimeout(repliesSearchTimer);
      repliesSearchTimer = setTimeout(() => {
        state.repliesQ = e.target.value;
        loadReplies();
      }, 300);
    }
  });

  // 탭 진입 시
  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item');
    if (!t) return;
    const which = t.dataset.tab;
    if (which === "dm-live") {
      setTimeout(() => { loadLive(); startLivePolling(); }, 80);
    } else if (which === "daily-dm") {
      setTimeout(loadDailyStats, 80);
    } else if (which === "replies") {
      setTimeout(loadReplies, 80);
    } else {
      // 다른 탭으로 이동 → 라이브 폴링 중지 (배지는 별도 폴링)
      stopLivePolling();
    }
  });

  // 백그라운드 — 라이브 배지 + 회신 배지 (저빈도)
  setInterval(loadLive, 8000);
  setInterval(loadReplies, 60000);

  setTimeout(loadLive, 1000);
  setTimeout(loadReplies, 1500);
})();
