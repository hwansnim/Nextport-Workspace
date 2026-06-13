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
      body.innerHTML = `<tr><td colspan="14" class="empty">아직 답장 받은 인플루언서 없음</td></tr>`;
      return;
    }
    body.innerHTML = state.replies.map((r, i) => {
      const statusClass = statusToClass(r.status);
      const ed = (field) => `data-v2="edit-reply" data-id="${esc(r.influencer_id || '')}" data-field="${field}"`;
      return `
      <tr data-iid="${esc(r.influencer_id || '')}">
        <td style="text-align:center;color:#888">${i + 1}</td>
        <td contenteditable="true" ${ed('first_reply_date')}>${esc((r.first_reply_date || "").slice(0, 10))}</td>
        <td>
          <select class="reply-status-sel" ${ed('status')} data-current="${esc(r.status)}">
            ${["dm 소통중","회신중","카톡 소통중","미팅 fix","컨펌","이탈"].map(s =>
              `<option value="${s}" ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </td>
        <td contenteditable="true" ${ed('owner')}>${esc(r.owner || "")}</td>
        <td><b>${esc(r.seller_name || "-")}</b></td>
        <td style="text-align:right" contenteditable="true" ${ed('follower_count')}>${esc(r.follower_count || "")}</td>
        <td>
          <a href="${esc(r.influencer_url)}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">
            @${esc(r.influencer_handle || "?")}
          </a>
        </td>
        <td style="font-size:11px" contenteditable="true" ${ed('reply_account')}>@${esc(r.reply_account || r.our_account_handle || "")}</td>
        <td style="font-size:11px;color:#888">${esc(r.device || "-")}</td>
        <td style="font-size:11px" contenteditable="true" ${ed('email')}>${esc(r.email || "")}</td>
        <td contenteditable="true" ${ed('phone')}>${esc(r.phone || "")}</td>
        <td contenteditable="true" ${ed('kakao_id')}>${esc(r.kakao_id || "")}</td>
        <td style="font-size:11.5px;max-width:240px" contenteditable="true" ${ed('notes')}>${esc(r.notes || "")}</td>
        <td style="text-align:center;white-space:nowrap">
          <button class="btn-text" data-v2="replies-open" data-cid="${esc(r.conv_id)}" title="대화 보기">💬</button>
          <button class="btn-text" data-v2="reply-add-meeting" data-id="${esc(r.influencer_id || '')}" title="미팅 날짜 박기 → 진행 예정 자동 등록">📅</button>
          <button class="btn-text" data-v2="reply-to-pipeline" data-id="${esc(r.influencer_id || '')}" title="진행 예정으로 이동">🎯</button>
        </td>
      </tr>`;
    }).join("");
  }

  function statusToClass(s) {
    const m = {
      "dm 소통중": "active", "회신중": "active", "카톡 소통중": "warmup",
      "미팅 fix": "sent", "컨펌": "sent", "이탈": "failed",
    };
    return m[s] || "pending";
  }

  // ─── 진행 예정 셀러 ────────────────────────────────────
  async function loadPipeline() {
    const params = new URLSearchParams({
      q: state.pipelineQ || "",
      stage: state.pipelineStage || "",
    });
    try {
      const r = await api(`/api/pipeline?${params}`);
      state.pipeline = r.pipeline || [];
      renderPipeline(r);
      updatePipelineBadge(r.total);
    } catch (e) { console.error(e); }
  }

  function updatePipelineBadge(n) {
    const badge = $("#pipelineBadge");
    if (!badge) return;
    if (n > 0) { badge.textContent = n > 99 ? "99+" : n; badge.hidden = false; }
    else { badge.hidden = true; }
  }

  function renderPipeline(r) {
    const stat = $("#pipelineStat");
    if (stat) stat.textContent = `${r.total || 0}건`;

    const counts = r.counts || {};
    $("#pipeStatPlan") && ($("#pipeStatPlan").textContent = counts["진행예정"] || 0);
    $("#pipeStatMeetingScheduled") && ($("#pipeStatMeetingScheduled").textContent = counts["미팅예약"] || 0);
    $("#pipeStatMeetingDone") && ($("#pipeStatMeetingDone").textContent = counts["미팅완료"] || 0);
    $("#pipeStatLive") && ($("#pipeStatLive").textContent = counts["캠페인진행중"] || 0);

    const body = $("#pipelineBody");
    if (!body) return;
    if (!state.pipeline.length) {
      body.innerHTML = `<tr><td colspan="11" class="empty">진행 예정 셀러 없음. 회신 인플루언서 현황에서 🎯 버튼으로 추가.</td></tr>`;
      return;
    }
    const stages = ["진행예정","미팅예약","미팅완료","캠페인진행중","종료"];
    body.innerHTML = state.pipeline.map((p, i) => `
      <tr data-iid="${esc(p.influencer_id)}">
        <td style="text-align:center;color:#888">${i + 1}</td>
        <td>
          <select class="pipe-stage-sel" data-v2="edit-pipe" data-id="${esc(p.influencer_id)}" data-field="pipeline_stage">
            ${stages.map(s => `<option value="${s}" ${s === p.pipeline_stage ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </td>
        <td style="cursor:pointer;color:var(--blue)" data-v2="pipe-detail" data-id="${esc(p.influencer_id)}"><b>${esc(p.seller_name || "-")}</b> →</td>
        <td>
          <a href="${esc(p.url || `https://www.instagram.com/${p.instagram_id}/`)}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">
            @${esc(p.instagram_id || "")}
          </a>
        </td>
        <td style="text-align:right">${esc(p.follower_count || "")}</td>
        <td contenteditable="true" data-v2="edit-pipe" data-id="${esc(p.influencer_id)}" data-field="owner">${esc(p.owner || "")}</td>
        <td style="text-align:center"><b>${p.meeting_count || 0}</b>차</td>
        <td style="font-size:11px;color:#888">${esc(p.last_meeting_date || "-")}</td>
        <td contenteditable="true" data-v2="edit-pipe" data-id="${esc(p.influencer_id)}" data-field="next_action">${esc(p.next_action || "")}</td>
        <td style="font-size:11px">${p.campaign_name ? esc(p.campaign_name) : `<span class="hint">연결 없음</span>`}</td>
        <td style="text-align:center">
          <button class="btn-text" data-v2="pipe-add-meeting" data-id="${esc(p.influencer_id)}" title="미팅 추가">📅</button>
          <button class="btn-text" data-v2="pipe-to-campaign" data-id="${esc(p.influencer_id)}" title="캠페인 추가">📣</button>
        </td>
      </tr>
    `).join("");
  }

  // ─── 진행 예정 디테일 모달 (미팅 기록 + 녹취) ─────────
  async function openPipelineDetail(iid) {
    if (!iid) return;
    let root = $("#pipeDetailModal");
    if (!root) {
      root = document.createElement("div");
      root.id = "pipeDetailModal";
      root.className = "pipe-detail-backdrop";
      document.body.appendChild(root);
    }
    root.innerHTML = `<div class="pipe-detail-modal"><div class="empty" style="padding:40px;text-align:center">불러오는 중…</div></div>`;
    root.style.display = "flex";
    try {
      const inf = await api(`/api/pipeline/${iid}/detail`);
      renderPipelineDetail(root, inf);
    } catch (err) {
      root.innerHTML = `<div class="pipe-detail-modal"><div class="empty" style="padding:40px">실패: ${esc(err.message)}</div></div>`;
    }
  }

  function closePipelineDetail() {
    const root = $("#pipeDetailModal");
    if (root) root.style.display = "none";
  }

  function renderPipelineDetail(root, inf) {
    const meetings = inf.meetings || [];
    root.innerHTML = `
      <div class="pipe-detail-modal">
        <div class="pipe-detail-head">
          <div>
            <h2>🎯 ${esc(inf.seller_name || inf.instagram_id)}</h2>
            <div class="hint">
              @${esc(inf.instagram_id)} ·
              팔로워 ${esc(inf.follower_count || "?")} ·
              담당 ${esc(inf.owner || "미정")} ·
              단계 <b>${esc(inf.pipeline_stage || "-")}</b>
            </div>
          </div>
          <button class="btn-text" data-v2="pipe-detail-close" style="font-size:24px">×</button>
        </div>

        <div class="pipe-detail-body">
          <div class="pipe-detail-contact">
            <div class="pdc-row"><span class="pdc-lbl">이메일</span> <span>${esc(inf.email || "-")}</span></div>
            <div class="pdc-row"><span class="pdc-lbl">전화</span> <span>${esc(inf.phone || "-")}</span></div>
            <div class="pdc-row"><span class="pdc-lbl">카톡</span> <span>${esc(inf.kakao_id || "-")}</span></div>
            <div class="pdc-row"><span class="pdc-lbl">회신 계정</span> <span>@${esc(inf.reply_account || "-")}</span></div>
            <div class="pdc-row"><span class="pdc-lbl">첫 회신일</span> <span>${esc(inf.first_reply_date || "-")}</span></div>
            <div class="pdc-row"><span class="pdc-lbl">차수</span> <span>${inf.send_count || 0}차 발송</span></div>
            <div class="pdc-row pdc-wide"><span class="pdc-lbl">비고</span> <span>${esc(inf.notes || "-")}</span></div>
          </div>

          <div class="pipe-meetings-head">
            <h3>📋 미팅 기록 (${meetings.length}건)</h3>
            <button class="btn-secondary" data-v2="pipe-add-meeting" data-id="${esc(inf.id)}">+ 미팅 박기</button>
          </div>

          <div class="pipe-meetings">
            ${meetings.length === 0
              ? `<div class="empty" style="padding:30px;text-align:center;color:#888">미팅 없음. [+ 미팅 박기] 클릭</div>`
              : meetings.map((m, i) => `
                <div class="pipe-meeting-card">
                  <div class="pmc-head">
                    <b>${m.round}차 미팅</b>
                    <input type="date" data-field="date" value="${esc(m.date || "")}" />
                    <input type="text" data-field="outcome" placeholder="결과: 진행/거절/추가논의 등" value="${esc(m.outcome || "")}" />
                    <button class="btn-text" data-v2="pipe-meeting-upload" data-id="${esc(inf.id)}" data-idx="${i}" title="녹취 업로드">🎙</button>
                    <button class="btn-text" data-v2="pipe-meeting-save" data-id="${esc(inf.id)}" data-idx="${i}">💾</button>
                    <button class="btn-text" data-v2="pipe-meeting-del" data-id="${esc(inf.id)}" data-idx="${i}">🗑</button>
                  </div>
                  <textarea data-field="note" placeholder="미팅 메모..." rows="2">${esc(m.note || "")}</textarea>
                  <textarea data-field="transcript" placeholder="녹취록 (직접 입력 또는 녹취 파일 업로드 후 Gemini 분석)" rows="4">${esc(m.transcript || "")}</textarea>
                  ${m.audio_file ? `<div class="hint">🎵 ${esc(m.audio_file.split(/[\\\\/]/).pop())}</div>` : ""}
                </div>
              `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  // 백드롭 클릭으로 닫기
  document.addEventListener("click", (e) => {
    if (e.target?.id === "pipeDetailModal") closePipelineDetail();
  });

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
      const cid = trg.dataset.cid;
      const inboxTab = document.querySelector('.side-item[data-tab="dm-inbox"]');
      if (inboxTab) inboxTab.click();
      setTimeout(() => {
        const convEl = document.querySelector(`[data-v2="open-conv"][data-cid="${cid}"]`);
        if (convEl) convEl.click();
      }, 300);
      return;
    }
    if (what === "reply-to-pipeline") {
      const iid = trg.dataset.id;
      if (!iid) return;
      try {
        await api(`/api/pipeline/${iid}`, {
          method: "PATCH",
          body: JSON.stringify({ pipeline_stage: "진행예정" }),
        });
        window.showToast?.({ icon: "🎯", title: "진행 예정으로 이동", body: "" });
        await loadReplies();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "reply-add-meeting") {
      // 회신 표에서 미팅 박기 → 진행 예정 자동 등록 + 캘린더
      const iid = trg.dataset.id;
      const date = prompt("미팅 날짜 (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
      if (!date) return;
      const note = prompt("메모 (선택):", "") || "";
      try {
        const r = await api(`/api/dm/replies/${iid}/meeting`, {
          method: "POST",
          body: JSON.stringify({ date, note }),
        });
        window.showToast?.({
          icon: "📅", title: `${r.meeting_round}차 미팅 박힘`,
          body: `진행 예정 셀러 + 캘린더 자동 등록 (${date})`, accent: true, ttl: 7000,
        });
        await loadReplies();
        await loadPipeline();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "pipe-add-meeting") {
      const iid = trg.dataset.id;
      const date = prompt("미팅 날짜 (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
      if (!date) return;
      const note = prompt("메모 (선택):", "") || "";
      try {
        const r = await api(`/api/pipeline/${iid}/meeting`, {
          method: "POST",
          body: JSON.stringify({ date, note }),
        });
        window.showToast?.({ icon: "📅", title: `${r.meeting_round}차 미팅 추가됨`, body: `캘린더에도 박힘 (${date})` });
        await loadPipeline();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "pipe-detail") {
      return openPipelineDetail(trg.dataset.id);
    }
    if (what === "pipe-detail-close") {
      return closePipelineDetail();
    }
    if (what === "pipe-meeting-save") {
      const iid = trg.dataset.id, idx = parseInt(trg.dataset.idx);
      const root = trg.closest(".pipe-meeting-card");
      const date = root.querySelector("[data-field='date']").value;
      const note = root.querySelector("[data-field='note']").value;
      const transcript = root.querySelector("[data-field='transcript']").value;
      const outcome = root.querySelector("[data-field='outcome']").value;
      try {
        await api(`/api/pipeline/${iid}/meeting/${idx}`, {
          method: "PATCH",
          body: JSON.stringify({ date, note, transcript, outcome }),
        });
        window.showToast?.({ icon: "✓", title: "미팅 저장됨", body: "" });
        await openPipelineDetail(iid);
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "pipe-meeting-del") {
      const iid = trg.dataset.id, idx = parseInt(trg.dataset.idx);
      if (!confirm("미팅 삭제할까?")) return;
      try {
        await api(`/api/pipeline/${iid}/meeting/${idx}`, { method: "DELETE" });
        await openPipelineDetail(iid);
        await loadPipeline();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
    if (what === "pipe-meeting-upload") {
      const iid = trg.dataset.id, idx = parseInt(trg.dataset.idx);
      const fi = document.createElement("input");
      fi.type = "file"; fi.accept = ".m4a,.mp3,.wav,.ogg";
      fi.onchange = async () => {
        const f = fi.files[0]; if (!f) return;
        const fd = new FormData(); fd.append("file", f);
        try {
          const res = await fetch(`/api/pipeline/${iid}/meeting/${idx}/audio`, { method: "POST", body: fd });
          const j = await res.json();
          if (j.error) { alert("실패: " + j.error); return; }
          window.showToast?.({ icon: "🎙", title: "녹취 업로드 완료", body: `${j.size_kb} KB` });
          await openPipelineDetail(iid);
        } catch (err) { alert("실패: " + err.message); }
      };
      fi.click();
      return;
    }
    if (what === "pipe-to-campaign") {
      const iid = trg.dataset.id;
      if (!confirm("이 셀러를 캠페인으로 박을까? (캠페인 + 1차 세트 자동 생성)")) return;
      try {
        const r = await api(`/api/campaigns_v2/from_influencer/${iid}`, {
          method: "POST",
          body: "{}",
        });
        window.showToast?.({ icon: "📣", title: "캠페인 추가됨", body: r.campaign?.seller_name || "", ttl: 6000 });
        await loadPipeline();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
  });

  // 인라인 편집 commit (회신 + 파이프라인)
  document.addEventListener("blur", async (e) => {
    const trg = e.target.closest("[data-v2='edit-reply'], [data-v2='edit-pipe']");
    if (!trg) return;
    const iid = trg.dataset.id;
    const field = trg.dataset.field;
    if (!iid || !field) return;
    const value = trg.tagName === "SELECT" ? trg.value : (trg.textContent || "").trim();
    const url = trg.dataset.v2 === "edit-reply"
      ? `/api/dm/replies/${iid}`
      : `/api/pipeline/${iid}`;
    try {
      await api(url, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value }),
      });
      trg.style.background = "#e8f5e8";
      setTimeout(() => { trg.style.background = ""; }, 600);
    } catch (err) {
      trg.style.background = "#fdecea";
      console.error("PATCH 실패:", err);
    }
  }, true);

  document.addEventListener("change", (e) => {
    if (e.target.classList?.contains("reply-status-sel")) e.target.blur();
    if (e.target.classList?.contains("pipe-stage-sel")) e.target.blur();
  });

  let repliesSearchTimer, pipelineSearchTimer;
  document.addEventListener("input", (e) => {
    if (e.target.id === "repliesSearch") {
      clearTimeout(repliesSearchTimer);
      repliesSearchTimer = setTimeout(() => {
        state.repliesQ = e.target.value;
        loadReplies();
      }, 300);
    }
    if (e.target.id === "pipelineSearch") {
      clearTimeout(pipelineSearchTimer);
      pipelineSearchTimer = setTimeout(() => {
        state.pipelineQ = e.target.value;
        loadPipeline();
      }, 300);
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "repliesStatusFilter") loadReplies();
    if (e.target.id === "pipelineStageFilter") {
      state.pipelineStage = e.target.value;
      loadPipeline();
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
    } else if (which === "pipeline") {
      setTimeout(loadPipeline, 80);
    } else {
      stopLivePolling();
    }
  });

  // 백그라운드 폴링 — 라이브 / 회신 / 파이프라인 배지
  setInterval(loadLive, 8000);
  setInterval(loadReplies, 60000);
  setInterval(loadPipeline, 90000);

  setTimeout(loadLive, 1000);
  setTimeout(loadReplies, 1500);
  setTimeout(loadPipeline, 2000);
})();

// ─── Toast 알람 시스템 (전역) ─────────────────────────────
(function () {
  if (window.showToast) return;
  const container = document.createElement("div");
  container.id = "toastContainer";
  container.style.cssText = "position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none";
  document.body.appendChild(container);

  window.showToast = function ({ icon = "🔔", title = "", body = "", accent = false, ttl = 5000, onclick } = {}) {
    const t = document.createElement("div");
    t.className = "toast" + (accent ? " toast-accent" : "");
    t.style.cssText = `
      pointer-events:auto;cursor:${onclick ? "pointer" : "default"};
      background:${accent ? "linear-gradient(135deg,#fff5e8 0%,#fbe9d6 100%)" : "#fff"};
      border:1px solid ${accent ? "var(--accent)" : "var(--border)"};
      border-radius:10px;padding:12px 16px;min-width:280px;max-width:380px;
      box-shadow:0 6px 18px rgba(0,0,0,.12);font-size:13px;
      animation:toastIn .25s ease-out;`;
    t.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-start">
        <div style="font-size:22px;line-height:1">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;margin-bottom:2px">${title.replace(/</g, "&lt;")}</div>
          <div style="color:#555;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${body.replace(/</g, "&lt;")}</div>
        </div>
        <button style="background:none;border:0;cursor:pointer;color:#999;font-size:16px;padding:0 4px">×</button>
      </div>`;
    if (onclick) t.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON") { onclick(); t.remove(); } });
    t.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); t.remove(); });
    container.appendChild(t);
    if (ttl > 0) setTimeout(() => { t.style.animation = "toastOut .2s ease-in forwards"; setTimeout(() => t.remove(), 200); }, ttl);
  };

  const style = document.createElement("style");
  style.textContent = `
    @keyframes toastIn { from { transform: translateX(40px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
    @keyframes toastOut { from { transform: translateX(0); opacity: 1 } to { transform: translateX(40px); opacity: 0 } }
  `;
  document.head.appendChild(style);
})();
