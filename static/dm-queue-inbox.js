/*
 * Phase B (발송 큐) + Phase C (통합 인박스) 위젯.
 * 의존: window.api, window.escapeHtml
 */
(function () {
  if (!window.api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));

  const state = {
    queue: [],
    queueReasons: {},
    templates: [],
    selectedTemplateId: null,
    inbox: [],
    inboxAccounts: [],
    inboxSummary: {},
    activeConvId: null,
    activeConv: null,
    inboxQ: "",
    inboxOnlyUnread: false,
    inboxAccountFilter: "",
  };

  // ─── TEMPLATES ──────────────────────────────────────────
  async function loadTemplates() {
    try {
      const r = await api("/api/dm/templates_v2");
      state.templates = r.templates || [];
      const sel = $("#dmQueueTemplate");
      if (sel) {
        sel.innerHTML = `<option value="">— 템플릿 선택 —</option>` +
          state.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
        if (state.templates.length) {
          state.selectedTemplateId = state.templates[0].id;
          sel.value = state.selectedTemplateId;
        }
      }
      await loadTemplateStats();
    } catch (e) { console.error(e); }
  }

  async function loadTemplateStats() {
    try {
      const r = await api("/api/dm/stats/templates");
      const root = $("#dmTemplateStats");
      if (!root) return;
      const top5 = (r.templates || []).slice(0, 5);
      if (!top5.length || !top5.some(t => (t.sent_count || 0) > 0)) {
        root.innerHTML = `<div class="empty" style="padding:14px;font-size:12px">발송 데이터 누적 후 표시</div>`;
        return;
      }
      root.innerHTML = top5.map(t => `
        <div class="dm-tpl-stat-row">
          <span class="dm-tpl-stat-name">${esc(t.name || "(이름 없음)")}</span>
          <span class="dm-tpl-stat-rate"><b>${t.reply_rate || 0}%</b></span>
          <span class="dm-tpl-stat-sub">${t.reply_count || 0}/${t.sent_count || 0}</span>
        </div>
      `).join("");
    } catch (e) { console.error(e); }
  }

  // ─── QUEUE ──────────────────────────────────────────────
  async function loadQueue() {
    const stat = $("#dmQueueStat");
    if (stat) stat.textContent = "계산 중…";
    try {
      const r = await api("/api/dm/queue/today?max=200");
      state.queue = r.queue || [];
      state.queueReasons = r.reasons || {};
      renderQueue();
    } catch (e) {
      if (stat) stat.textContent = "실패";
      console.error(e);
    }
  }

  function renderQueue() {
    const stat = $("#dmQueueStat");
    if (stat) stat.textContent = `${state.queue.length}건 후보`;
    const body = $("#dmQueueBody");
    if (body) {
      if (!state.queue.length) {
        body.innerHTML = `<tr><td colspan="8" class="empty">발송 후보 없음 — 사유는 아래 참고</td></tr>`;
      } else {
        body.innerHTML = state.queue.map(q => `
          <tr data-iid="${esc(q.influencer_id)}" data-aid="${esc(q.account_id)}">
            <td><input type="checkbox" class="dm-q-chk" data-iid="${esc(q.influencer_id)}" data-aid="${esc(q.account_id)}" checked /></td>
            <td>${esc(q.seller_name || "-")}</td>
            <td>@${esc(q.influencer_handle || "?")}</td>
            <td style="text-align:center"><b>${q.next_send_count}</b>차</td>
            <td style="font-size:11px;color:#888">${esc(q.last_sent_date || "미발송")}</td>
            <td style="font-size:11px">${q.days_since_last >= 99999 ? "—" : q.days_since_last + "일"}</td>
            <td style="font-size:11px">@${esc(q.account_handle || q.account_id)}</td>
            <td><button class="btn-text" data-v2="queue-send-one" data-iid="${esc(q.influencer_id)}" data-aid="${esc(q.account_id)}">📤</button></td>
          </tr>
        `).join("");
      }
    }
    const reasonRoot = $("#dmQueueReasons");
    if (reasonRoot) {
      const r = state.queueReasons;
      reasonRoot.innerHTML = `
        제외 사유 —
        통과 ${r.ok || 0} ·
        상태제외 ${r.excluded_status || 0} ·
        10차 도달 ${r.max_count_reached || 0} ·
        7일 미경과 ${r.too_recent || 0} ·
        쓸 계정 없음 ${r.no_account || 0}
      `;
    }
    const sendAll = document.querySelector('[data-v2="queue-send-all"]');
    if (sendAll) sendAll.disabled = !state.queue.length;
  }

  async function sendOne(infId, accId, btn) {
    const tplId = $("#dmQueueTemplate")?.value;
    const tpl = state.templates.find(t => t.id === tplId);
    // 사용자 직접 입력 멘트가 있으면 우선 — 멘트 박스 비어있으면 템플릿
    const customMsg = ($("#dmQueueCustomMsg")?.value || "").trim();
    const message = customMsg || tpl?.body || "";
    if (!message) {
      alert("템플릿 선택하거나 멘트 직접 박아.");
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "발송중…"; }
    try {
      const r = await api("/api/dm/send", {
        method: "POST",
        body: JSON.stringify({
          influencer_id: infId,
          account_id: accId,
          message,
          template_id: customMsg ? "" : tplId,  // 커스텀 멘트면 템플릿 통계 X
        }),
      });
      if (r.ok) {
        const row = document.querySelector(`#dmQueueBody tr[data-iid="${infId}"][data-aid="${accId}"]`);
        if (row) row.style.background = "#e8f5e8";
        if (btn) btn.textContent = "✓";
      } else {
        if (btn) { btn.disabled = false; btn.textContent = "📤"; }
        alert(`발송 실패: ${r.error || "unknown"}`);
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "📤"; }
      alert(`발송 실패: ${e.message}`);
    }
  }

  async function sendAll() {
    const checked = Array.from(document.querySelectorAll(".dm-q-chk:checked"));
    if (!checked.length) { alert("체크된 큐 없음"); return; }
    if (!confirm(`${checked.length}건 순차 발송. 진행할까?\n(중간 중단하려면 페이지 닫기)`)) return;
    for (const cb of checked) {
      const btn = document.querySelector(`[data-v2="queue-send-one"][data-iid="${cb.dataset.iid}"][data-aid="${cb.dataset.aid}"]`);
      await sendOne(cb.dataset.iid, cb.dataset.aid, btn);
      // 사람 패턴 — 발송 사이 30~120초
      await new Promise(r => setTimeout(r, 30000 + Math.random() * 90000));
    }
  }

  // ─── INBOX ──────────────────────────────────────────────
  async function loadInbox() {
    const params = new URLSearchParams({
      q: state.inboxQ,
      only_unread: state.inboxOnlyUnread ? "1" : "",
      account_id: state.inboxAccountFilter,
      page: 1,
      page_size: 100,
    });
    try {
      const r = await api(`/api/dm/inbox?${params}`);
      state.inbox = r.conversations || [];
      state.inboxSummary = r.summary || {};
      // 계정 필터 옵션 채우기 (첫 로드)
      const sel = $("#inboxAccountFilter");
      if (sel && sel.options.length <= 1) {
        const accs = state.inboxSummary.by_account || {};
        Object.keys(accs).sort().forEach(h => {
          const opt = document.createElement("option");
          opt.value = h;
          opt.textContent = `@${h} (${accs[h]})`;
          sel.appendChild(opt);
        });
      }
      renderInbox();
      detectNewReplies();
      updateUnreadBadge();
    } catch (e) { console.error(e); }
  }

  // 답장 도착 감지 → toast 알람 (첫 로드는 baseline 만 잡고 알람 X)
  let _lastUnreadCount = null;
  function detectNewReplies() {
    const cur = state.inboxSummary.unread_total || 0;
    if (_lastUnreadCount === null) { _lastUnreadCount = cur; return; }
    if (cur > _lastUnreadCount) {
      const newCount = cur - _lastUnreadCount;
      // 가장 최근 대화 정보 뽑아서 toast
      const newest = (state.inbox || []).find(c => (c.unread_count || 0) > 0);
      if (newest) {
        window.showToast?.({
          icon: "💬",
          title: `새 답장 ${newCount}건!`,
          body: `@${newest.their_handle} · ${(newest.last_message_preview || "").slice(0, 60)}`,
          accent: true,
          ttl: 8000,
          onclick: () => {
            const tab = document.querySelector('.side-item[data-tab="dm-inbox"]');
            tab?.click();
            setTimeout(() => {
              const conv = document.querySelector(`[data-v2="open-conv"][data-cid="${newest.id}"]`);
              conv?.click();
            }, 300);
          },
        });
        // 사운드 (브라우저가 막으면 무시)
        try { new Audio("/static/ding.mp3").play().catch(() => {}); } catch {}
      }
    }
    _lastUnreadCount = cur;
  }

  function updateUnreadBadge() {
    const badge = $("#inboxUnreadBadge");
    if (!badge) return;
    const n = state.inboxSummary.unread_total || 0;
    if (n > 0) {
      badge.textContent = n > 99 ? "99+" : n;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // 아바타 색 (핸들 해시 → 팔레트)
  const AV_COLORS = ["#0071e3", "#1d8a3f", "#e8830c", "#5e5ce6", "#d23b3b", "#0a7ea4", "#b8860b"];
  function avatarColor(s) {
    let h = 0; for (const ch of (s || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AV_COLORS[h % AV_COLORS.length];
  }
  function relTime(iso) {
    if (!iso) return "";
    const d = new Date(String(iso).replace(" ", "T"));
    if (isNaN(d)) return "";
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "방금";
    if (diff < 3600) return Math.floor(diff / 60) + "분";
    if (diff < 86400) return Math.floor(diff / 3600) + "시간";
    const days = Math.floor(diff / 86400);
    return days === 1 ? "어제" : days + "일";
  }

  function renderInbox() {
    const root = $("#inboxList");
    if (!root) return;
    if (!state.inbox.length) {
      root.innerHTML = `<div class="inbox-empty-sm">대화 없음 · [답장 동기화] 클릭</div>`;
      return;
    }
    root.innerHTML = state.inbox.map(c => {
      const unread = (c.unread_count || 0) > 0;
      const active = c.id === state.activeConvId;
      const handle = c.their_handle || "";
      const initial = (handle[0] || "?").toUpperCase();
      return `
        <div class="inbox-conv ${active ? "active" : ""} ${unread ? "unread" : ""}" data-v2="open-conv" data-cid="${esc(c.id)}">
          <div class="ic-avatar" style="background:${avatarColor(handle)}">${esc(initial)}</div>
          <div class="ic-main">
            <div class="ic-row">
              <span class="ic-handle">${esc(handle)}</span>
              <span class="ic-time">${esc(relTime(c.last_message_at))}</span>
            </div>
            <div class="ic-seller">${esc(c.seller_name || "")}</div>
            <div class="ic-row">
              <span class="ic-preview">${esc((c.last_message_preview || "").slice(0, 40))}</span>
              ${unread ? `<span class="ic-badge">${c.unread_count}</span>` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  async function openConversation(cid) {
    state.activeConvId = cid;
    renderInbox();
    const thread = $("#inboxThread");
    if (thread) thread.innerHTML = `<div class="empty" style="padding:20px">불러오는 중…</div>`;
    try {
      const r = await api(`/api/dm/inbox/${cid}`);
      state.activeConv = r;
      // 자동 읽음 처리
      if ((r.unread_count || 0) > 0) {
        api(`/api/dm/inbox/${cid}/read`, { method: "POST" }).then(() => loadInbox());
      }
      renderThread();
    } catch (e) {
      if (thread) thread.innerHTML = `<div class="empty">실패: ${esc(e.message)}</div>`;
    }
  }

  function renderThread() {
    const root = $("#inboxThread");
    if (!root || !state.activeConv) return;
    const c = state.activeConv;
    const handle = c.their_handle || "";
    const initial = (handle[0] || "?").toUpperCase();
    const acct = "@" + (c.our_account_handle || "?");
    const msgs = (c.messages || []).map(m => `
      <div class="tmsg ${m.from === "us" ? "us" : "them"}"><div class="tbub">${esc(m.text || "")}</div></div>
    `).join("");
    root.innerHTML = `
      <div class="thread-head">
        <div class="th-avatar" style="background:${avatarColor(handle)}">${esc(initial)}</div>
        <div class="th-info">
          <div class="th-name">${esc(handle)}</div>
          <div class="th-sub">${esc(c.seller_name || "")} · 수신 계정 ${esc(acct)}</div>
        </div>
        <button class="btn-outline btn-outline-sm" data-v2="inbox-book-meeting" data-cid="${esc(c.id)}">미팅 잡기</button>
      </div>
      <div class="thread-body" id="threadBody">
        ${msgs || '<div class="inbox-empty">메시지 없음</div>'}
      </div>
      <div class="thread-compose">
        <div class="tc-pill">
          <textarea id="replyText" rows="1" placeholder="메시지 입력 — 이 대화의 ${esc(acct)}로 발송"></textarea>
          <button class="tc-send" data-v2="reply-send" data-cid="${esc(c.id)}" title="발송">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
      </div>
    `;
    // 가장 아래로 스크롤
    const body = $("#threadBody");
    if (body) body.scrollTop = body.scrollHeight;
  }

  async function sendReply(cid, btn) {
    const ta = $("#replyText");
    const text = (ta?.value || "").trim();
    if (!text) { alert("내용 박아"); return; }
    if (btn) { btn.disabled = true; btn.style.opacity = ".5"; }
    try {
      const r = await api(`/api/dm/inbox/${cid}/reply`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      if (r.ok) {
        if (ta) ta.value = "";
        await openConversation(cid);
      } else {
        alert("실패: " + (r.error || "unknown"));
      }
    } catch (e) {
      alert("실패: " + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = ""; }
    }
  }

  async function syncInbox(btn) {
    if (!confirm("모든 활성 계정에서 받은 답장 동기화. 시간 좀 걸림 (계정당 ~10초). 진행할까?")) return;
    if (btn) { btn.disabled = true; btn.style.opacity = ".5"; }
    try {
      const r = await api("/api/dm/inbox/sync", { method: "POST", body: "{}" });
      if (r.error) {
        alert("실패: " + r.error);
      } else {
        alert(`✓ 새 메시지 ${r.total_new}건\n계정 ${r.per_account?.length || 0}개 처리`);
        await loadInbox();
      }
    } catch (e) {
      alert("실패: " + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = ""; }
    }
  }

  // ─── EVENTS ─────────────────────────────────────────────
  document.addEventListener("click", async (e) => {
    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    if (what === "queue-rebuild") return loadQueue();
    if (what === "queue-send-all") return sendAll();
    if (what === "queue-send-one") {
      return sendOne(trg.dataset.iid, trg.dataset.aid, trg);
    }
    if (what === "open-conv") {
      return openConversation(trg.dataset.cid);
    }
    if (what === "reply-send") {
      return sendReply(trg.dataset.cid, trg);
    }
    if (what === "inbox-sync") {
      return syncInbox(trg);
    }
    if (what === "inbox-book-meeting") {
      document.querySelector('.side-item[data-tab="meetings"]')?.click();
      setTimeout(() => document.getElementById("btnAddMeeting")?.click(), 150);
      return;
    }
  });

  // Enter = 발송, Shift+Enter = 줄바꿈
  document.addEventListener("keydown", (e) => {
    if (e.target.id === "replyText" && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const cid = e.target.closest("[data-cid]")?.dataset.cid
        || document.querySelector('[data-v2="reply-send"]')?.dataset.cid;
      const btn = document.querySelector('[data-v2="reply-send"]');
      if (cid) sendReply(cid, btn);
    }
  });

  let inboxSearchTimer;
  document.addEventListener("input", (e) => {
    if (e.target.id === "inboxSearch") {
      clearTimeout(inboxSearchTimer);
      inboxSearchTimer = setTimeout(() => {
        state.inboxQ = e.target.value;
        loadInbox();
      }, 300);
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "inboxOnlyUnread") {
      state.inboxOnlyUnread = e.target.checked;
      loadInbox();
    }
    if (e.target.id === "inboxAccountFilter") {
      state.inboxAccountFilter = e.target.value;
      loadInbox();
    }
  });

  // 탭 진입 시 — 새 탭 매핑
  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item');
    if (!t) return;
    const which = t.dataset.tab;
    if (which === "dm-inbox") {
      setTimeout(() => loadInbox(), 80);
    } else if (which === "daily-dm") {
      setTimeout(() => { loadTemplates(); loadQueue(); }, 80);
    }
  });

  // 초기 — 인박스 안 읽음 배지만 백그라운드 폴링
  setTimeout(loadInbox, 800);
  setInterval(loadInbox, 90000);  // 1.5분마다 새 답장 체크
})();
