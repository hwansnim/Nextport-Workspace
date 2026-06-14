/*
 * 셀러 캠페인 v2 — 메타 광고관리자 카피 (3탭 행단위 + 매출/비용).
 * 캠페인 / 세트(차수) / 마켓(공동구매) 3단계.
 */
(function () {
  if (!window.api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));
  const fmtKRW = n => "₩" + (n || 0).toLocaleString();
  const fmtPct = n => (n == null) ? "—" : `${n.toFixed(0)}%`;

  const s = {
    campaigns: [],
    activeMetaTab: "campaigns",
    activeCamId: null,
    activeSetId: null,
    activeMarketId: null,
    q: "", typeFilter: "", statusFilter: "",
  };

  // ─── 데이터 ─────────────────────────────────────────────
  async function loadList() {
    try {
      const r = await api("/api/campaigns_v2");
      s.campaigns = r.campaigns || [];
      renderAll();
    } catch (e) { console.error(e); }
  }

  function filtered() {
    return s.campaigns.filter(c => {
      if (s.typeFilter && c.type !== s.typeFilter) return false;
      if (s.statusFilter && c.status !== s.statusFilter) return false;
      if (s.q) {
        const blob = `${c.seller_name} ${c.brand} ${c.product}`.toLowerCase();
        if (!blob.includes(s.q.toLowerCase())) return false;
      }
      return true;
    });
  }

  // 매출/비용 합계 (마켓 → 세트 → 캠페인 roll-up)
  function marketTotals(market) {
    return {
      revenue: market.revenue || 0,
      cost: market.cost || 0,
    };
  }
  function setTotals(set) {
    return (set.ads || []).reduce((a, m) => {
      const t = marketTotals(m);
      return { revenue: a.revenue + t.revenue, cost: a.cost + t.cost };
    }, { revenue: 0, cost: 0 });
  }
  function campaignTotals(cam) {
    return (cam.sets || []).reduce((a, st) => {
      const t = setTotals(st);
      return { revenue: a.revenue + t.revenue, cost: a.cost + t.cost };
    }, { revenue: 0, cost: 0 });
  }
  function marginPct(rev, cost) {
    if (!rev) return null;
    return Math.round((rev - cost) / rev * 1000) / 10;
  }

  // ─── RENDER ALL ─────────────────────────────────────────
  function renderAll() {
    const items = filtered();
    $("#camV2Stat").textContent = `${items.length} / ${s.campaigns.length}`;

    // 카운트
    let setCount = 0, marketCount = 0;
    items.forEach(c => {
      (c.sets || []).forEach(st => {
        setCount++;
        marketCount += (st.ads || []).length;
      });
    });
    $("#metaCntCampaigns").textContent = items.length;
    $("#metaCntSets").textContent = setCount;
    $("#metaCntMarkets").textContent = marketCount;

    renderCampaignsTab(items);
    renderSetsTab(items);
    renderMarketsTab(items);
  }

  // ─── 캠페인 탭 ──────────────────────────────────────────
  function renderCampaignsTab(items) {
    const body = $("#metaCampaignsBody");
    if (!body) return;
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="12" class="empty">캠페인 없음 — [+ 캠페인 만들기] 또는 [진행 예정 셀러]에서 📣 박기</td></tr>`;
      return;
    }
    body.innerHTML = items.map(c => {
      const t = campaignTotals(c);
      const margin = marginPct(t.revenue, t.cost);
      const setCount = (c.sets || []).length;
      const adCount = (c.sets || []).reduce((sum, st) => sum + (st.ads || []).length, 0);
      return `
        <tr class="meta-row" data-v2="cam-open" data-id="${esc(c.id)}">
          <td onclick="event.stopPropagation()"><input type="checkbox" /></td>
          <td onclick="event.stopPropagation()"><label class="meta-toggle"><input type="checkbox" ${c.status === "진행중" ? "checked" : ""} data-v2="cam-toggle-status" data-id="${esc(c.id)}" /><span></span></label></td>
          <td><div class="meta-name"><b>${esc(c.seller_name || "셀러 미정")}</b><span class="hint">${esc(c.brand || "-")} · ${esc(c.product || "-")}</span></div></td>
          <td><span class="cam-type cam-type-${esc(c.type || "")}">${esc(c.type || "?")}</span></td>
          <td><span class="meta-status s-${esc(c.status || "준비중")}">${statusDot(c.status)} ${esc(c.status || "준비중")}</span></td>
          <td style="text-align:center">${setCount}</td>
          <td style="text-align:center">${adCount}</td>
          <td style="text-align:right"><b>${fmtKRW(t.revenue)}</b></td>
          <td style="text-align:right;color:#888">${fmtKRW(t.cost)}</td>
          <td style="text-align:center" class="${margin != null && margin > 0 ? 'meta-good' : (margin != null && margin < 0 ? 'meta-bad' : '')}">${fmtPct(margin)}</td>
          <td style="font-size:11px;color:#888">${esc(c.market_schedule || "-")}</td>
          <td onclick="event.stopPropagation()"><button class="btn-text" data-v2="cam-detail" data-id="${esc(c.id)}">→</button></td>
        </tr>
      `;
    }).join("");
  }

  // ─── 세트 탭 ────────────────────────────────────────────
  function renderSetsTab(items) {
    const body = $("#metaSetsBody");
    if (!body) return;
    const rows = [];
    items.forEach(c => {
      (c.sets || []).forEach(st => {
        const t = setTotals(st);
        const margin = marginPct(t.revenue, t.cost);
        const adCount = (st.ads || []).length;
        // 세트 상태 = 자식 마켓의 가장 진행된 상태
        const statuses = (st.ads || []).map(a => a.status || "준비중");
        const stStatus = statuses.includes("진행중") ? "진행중" :
                         statuses.includes("완료") ? "완료" :
                         statuses.includes("중단") ? "중단" : "준비중";
        rows.push(`
          <tr class="meta-row" data-v2="set-open" data-cam="${esc(c.id)}" data-id="${esc(st.id)}">
            <td onclick="event.stopPropagation()"><input type="checkbox" /></td>
            <td onclick="event.stopPropagation()"><label class="meta-toggle"><input type="checkbox" ${stStatus === "진행중" ? "checked" : ""} /><span></span></label></td>
            <td><div class="meta-name"><b>${esc(st.label || st.round + "차")}</b><span class="hint">세트 ID ${esc(st.id)}</span></div></td>
            <td>${esc(c.seller_name || "?")} <span class="hint">${esc(c.brand || "")}</span></td>
            <td><span class="meta-status s-${esc(stStatus)}">${statusDot(stStatus)} ${esc(stStatus)}</span></td>
            <td style="text-align:center">${adCount}</td>
            <td style="text-align:right"><b>${fmtKRW(t.revenue)}</b></td>
            <td style="text-align:right;color:#888">${fmtKRW(t.cost)}</td>
            <td style="text-align:center" class="${margin != null && margin > 0 ? 'meta-good' : (margin != null && margin < 0 ? 'meta-bad' : '')}">${fmtPct(margin)}</td>
            <td onclick="event.stopPropagation()"><button class="btn-text" data-v2="set-detail" data-cam="${esc(c.id)}" data-id="${esc(st.id)}">→</button></td>
          </tr>
        `);
      });
    });
    body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="10" class="empty">세트 없음 — 캠페인 진입 후 [+ 다음 차수 추가]</td></tr>`;
  }

  // ─── 마켓 탭 ────────────────────────────────────────────
  function renderMarketsTab(items) {
    const body = $("#metaMarketsBody");
    if (!body) return;
    const rows = [];
    items.forEach(c => {
      (c.sets || []).forEach(st => {
        (st.ads || []).forEach(ad => {
          const t = marketTotals(ad);
          const margin = marginPct(t.revenue, t.cost);
          rows.push(`
            <tr class="meta-row" data-v2="market-open" data-cam="${esc(c.id)}" data-set="${esc(st.id)}" data-id="${esc(ad.id)}">
              <td onclick="event.stopPropagation()"><input type="checkbox" /></td>
              <td onclick="event.stopPropagation()"><label class="meta-toggle"><input type="checkbox" ${ad.status === "진행중" ? "checked" : ""} /><span></span></label></td>
              <td><div class="meta-name"><b>${esc(ad.name || "공동구매")}</b><span class="hint">${esc(c.seller_name || "")} · ${esc(st.label || st.round + "차")}</span></div></td>
              <td>${esc(st.label || st.round + "차")}</td>
              <td>${esc(c.seller_name || "?")}</td>
              <td><span class="meta-status s-${esc(ad.status || "준비중")}">${statusDot(ad.status)} ${esc(ad.status || "준비중")}</span></td>
              <td style="font-size:11px">${esc(ad.scheduling?.start_date || "-")}</td>
              <td style="font-size:11px">${esc(ad.scheduling?.end_date || "-")}</td>
              <td style="text-align:right"><b>${fmtKRW(t.revenue)}</b></td>
              <td style="text-align:right;color:#888">${fmtKRW(t.cost)}</td>
              <td style="text-align:center" class="${margin != null && margin > 0 ? 'meta-good' : (margin != null && margin < 0 ? 'meta-bad' : '')}">${fmtPct(margin)}</td>
              <td onclick="event.stopPropagation()"><button class="btn-text" data-v2="market-detail" data-cam="${esc(c.id)}" data-set="${esc(st.id)}" data-id="${esc(ad.id)}">→</button></td>
            </tr>
          `);
        });
      });
    });
    body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="12" class="empty">마켓 없음 — 캠페인+세트 만든 후 자동 생성</td></tr>`;
  }

  function statusDot(s) {
    const m = { "진행중": "🟢", "준비중": "⚪", "완료": "🟣", "중단": "🔴" };
    return m[s] || "⚪";
  }

  // ─── DETAIL ────────────────────────────────────────────
  async function openCampaign(camId) {
    try {
      const c = await api(`/api/campaigns_v2/${camId}`);
      s.activeCamId = camId;
      s.activeSetId = null;
      s.activeMarketId = null;
      $("#camV2ListView").hidden = true;
      $("#camV2DetailView").hidden = false;
      $("#camAdDetailWrap").hidden = true;
      renderCamDetail(c);
    } catch (e) { alert("실패: " + e.message); }
  }

  function backToList() {
    s.activeCamId = null; s.activeSetId = null; s.activeMarketId = null;
    $("#camV2DetailView").hidden = true;
    $("#camV2ListView").hidden = false;
    loadList();
  }

  function renderCamDetail(c) {
    $("#camBcCampaign").textContent = `${c.seller_name || "?"} · ${c.brand || "?"} / ${c.product || "?"}`;
    $("#camBcSetSep").hidden = true;
    $("#camBcSet").hidden = true;

    $("#camMetaBody").innerHTML = `
      <div class="cam-meta-row"><span class="lbl">셀러명</span><span class="val">${esc(c.seller_name || "-")}</span></div>
      <div class="cam-meta-row"><span class="lbl">브랜드</span><span class="val">${esc(c.brand || "-")}</span></div>
      <div class="cam-meta-row"><span class="lbl">제품</span><span class="val">${esc(c.product || "-")}</span></div>
      <div class="cam-meta-row"><span class="lbl">타입</span><span class="val"><span class="cam-type cam-type-${esc(c.type || "")}">${esc(c.type || "-")}</span></span></div>
      <div class="cam-meta-row"><span class="lbl">상태</span><span class="val"><span class="cam-status s-${esc(c.status || "준비중")}">${esc(c.status || "준비중")}</span></span></div>
      <div class="cam-meta-row"><span class="lbl">마켓 일정</span><span class="val">${esc(c.market_schedule || "-")}</span></div>
      ${c.linked_influencer_handle ? `<div class="cam-meta-row"><span class="lbl">연결 인플루언서</span><span class="val">@${esc(c.linked_influencer_handle)}</span></div>` : ""}
    `;

    const setsRoot = $("#camSetsBody");
    if (!(c.sets || []).length) {
      setsRoot.innerHTML = `<div class="empty" style="padding:30px;text-align:center;color:#888">세트 없음. [+ 다음 차수 추가] 클릭</div>`;
    } else {
      setsRoot.innerHTML = c.sets.map(st => `
        <div class="cam-set ${st.id === s.activeSetId ? "active" : ""}" data-v2="set-open" data-id="${esc(st.id)}">
          <div class="cam-set-head">
            <span class="cam-set-round">${esc(st.label || st.round + "차")}</span>
            <span class="hint">${(st.ads || []).length}건 마켓</span>
          </div>
          <div class="cam-set-ads">
            ${(st.ads || []).map(a => `
              <div class="cam-ad-chip ${a.id === s.activeMarketId ? "active" : ""}" data-v2="ad-open" data-set="${esc(st.id)}" data-id="${esc(a.id)}">
                <span>${esc(a.name)}</span>
                <span class="cam-status s-${esc(a.status || "준비중")}">${esc(a.status || "준비중")}</span>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("");
    }

    if (s.activeMarketId) {
      const set = c.sets.find(x => x.id === s.activeSetId);
      const ad = set?.ads.find(x => x.id === s.activeMarketId);
      if (ad) renderAdDetail(set, ad);
    }
  }

  function renderAdDetail(set, ad) {
    s.activeSetId = set.id;
    s.activeMarketId = ad.id;
    $("#camAdDetailWrap").hidden = false;
    $("#camBcSetSep").hidden = false;
    $("#camBcSet").hidden = false;
    $("#camBcSet").textContent = `${set.label || set.round + "차"} · ${ad.name}`;

    $("#camAdStatusLabel").textContent = ad.status || "준비중";
    $("#camAdStatusSel").value = ad.status || "준비중";
    $("#adProductSentDate").value = ad.product_sent_date || "";
    $("#adSchedStart").value = ad.scheduling?.start_date || "";
    $("#adSchedEnd").value = ad.scheduling?.end_date || "";

    const items = ad.scheduling?.items || [];
    $("#adSchedItems").innerHTML = items.length
      ? items.map((it, i) => `<div class="ad-list-row">
          <span class="ad-list-tag">${esc(it.date || "")}</span>
          <span class="ad-list-text">${esc(it.label || "")}</span>
          <button class="btn-text" data-v2="ad-sched-del" data-idx="${i}">×</button>
        </div>`).join("")
      : `<div class="hint">세부 일정 없음</div>`;

    const events = ad.events || [];
    $("#adEventList").innerHTML = events.length
      ? events.map((ev, i) => `<div class="ad-list-row">
          <span class="ad-list-text">${esc(typeof ev === "string" ? ev : ev.text || "")}</span>
          <button class="btn-text" data-v2="ad-event-del" data-idx="${i}">×</button>
        </div>`).join("")
      : `<div class="hint">이벤트 없음</div>`;

    const drives = ad.drive_links || [];
    $("#adDriveList").innerHTML = drives.length
      ? drives.map((d, i) => `<div class="ad-list-row">
          <span class="ad-list-tag">${esc(d.label || "자료")}</span>
          <a href="${esc(d.url)}" target="_blank" rel="noopener" class="ad-list-text" style="color:var(--blue)">${esc(d.url)}</a>
          <button class="btn-text" data-v2="ad-drive-del" data-idx="${i}">×</button>
        </div>`).join("")
      : `<div class="hint">드라이브 링크 없음</div>`;

    // 배너
    const bn = ad.banners || {};
    const bannerTypes = [
      { key: "openfeed", label: "오픈피드 배너" },
      { key: "price", label: "가격 배너" },
      { key: "event", label: "이벤트 배너" },
    ];
    $("#adBannerGrid").innerHTML = bannerTypes.map(b => {
      const bv = bn[b.key] || {};
      return `
        <div class="ad-banner-card">
          <div class="ad-banner-head">
            <label><input type="checkbox" data-v2="ad-banner-toggle" data-key="${b.key}" ${bv.checked ? "checked" : ""} /> <b>${b.label}</b></label>
            <span class="hint">${bv.checked ? "✓ 전달됨" : "미전달"}</span>
          </div>
          <input type="url" placeholder="기획안 URL" data-v2="ad-banner-field" data-key="${b.key}" data-field="draft_url" value="${esc(bv.draft_url || "")}" />
          <input type="url" placeholder="최종 이미지 URL" data-v2="ad-banner-field" data-key="${b.key}" data-field="final_url" value="${esc(bv.final_url || "")}" />
          <input type="text" placeholder="메모" data-v2="ad-banner-field" data-key="${b.key}" data-field="note" value="${esc(bv.note || "")}" />
          ${bv.final_url ? `<a href="${esc(bv.final_url)}" target="_blank" rel="noopener" class="btn-text">🖼 미리보기</a>` : ""}
        </div>
      `;
    }).join("");

    // 릴스
    const reels = ad.reels || [];
    $("#adReelsList").innerHTML = reels.length
      ? reels.map((r, i) => `
          <div class="ad-reel-card">
            <div class="ad-reel-head">
              <b>릴스 #${i + 1}</b>
              <select data-v2="ad-reel-field" data-idx="${i}" data-field="status">
                ${["기획중","제작중","검수중","완료"].map(st => `<option ${r.status === st ? "selected" : ""}>${st}</option>`).join("")}
              </select>
              <button class="btn-text" data-v2="ad-reel-del" data-idx="${i}">🗑</button>
            </div>
            <textarea placeholder="기획안" data-v2="ad-reel-field" data-idx="${i}" data-field="plan" rows="2">${esc(r.plan || "")}</textarea>
            <input type="url" placeholder="영상 URL" data-v2="ad-reel-field" data-idx="${i}" data-field="video_url" value="${esc(r.video_url || "")}" />
            ${r.video_url ? `<a href="${esc(r.video_url)}" target="_blank" rel="noopener" class="btn-text">▶️ 영상 보기</a>` : ""}
          </div>`).join("")
      : `<div class="hint">릴스 없음. [+ 릴스 추가] 클릭</div>`;

    // 매출/비용 + 스케줄링 자동생성 + 셀러 미리보기
    renderMarketRevenue(ad);
    renderSchedulingTools(ad);
    renderSellerPreview(set, ad);
  }

  // 매출/비용 입력
  function renderMarketRevenue(ad) {
    const root = $("#adRevenueBody");
    if (!root) return;
    const rev = ad.revenue || 0;
    const cost = ad.cost || 0;
    const margin = marginPct(rev, cost);
    root.innerHTML = `
      <div class="ad-field"><span>매출</span><input type="number" id="adRevenueInput" value="${rev}" min="0" /></div>
      <div class="ad-field"><span>비용</span><input type="number" id="adCostInput" value="${cost}" min="0" /></div>
      <div class="ad-field"><span>마진율</span><span style="font-weight:700;color:${margin != null && margin > 0 ? 'var(--accent)' : '#888'}">${fmtPct(margin)}</span></div>
      <button class="btn-secondary" data-v2="ad-save-revenue">저장</button>
    `;
  }

  // 스케줄링 자동 생성 도구
  function renderSchedulingTools(ad) {
    const root = $("#adSchedAutoBody");
    if (!root) return;
    root.innerHTML = `
      <div class="hint" style="margin-bottom:6px">라이브 시작일만 박으면 거꾸로 일정 전체 자동 생성</div>
      <div class="ad-field"><span>라이브 시작</span><input type="date" id="adAutoLiveDate" value="${esc(ad.scheduling?.start_date || "")}" /></div>
      <div class="ad-field"><span>라이브 길이</span>
        <select id="adAutoLiveDays" style="padding:5px 8px;border:1px solid var(--border);border-radius:4px">
          <option value="3">3일</option>
          <option value="5">5일</option>
          <option value="7" selected>7일</option>
          <option value="10">10일</option>
        </select>
      </div>
      <button class="btn-primary" data-v2="ad-auto-schedule">⚡ 자동 스케줄링</button>
      <div class="hint" style="margin-top:8px;font-size:11px">
        자동 생성 항목: 제품 발송 (D-5) / 배너 마감 (D-3) / 릴스 마감 (D-2) / 리허설 (D-1) / 라이브 (D-day) / 마감 (D+N)
      </div>
    `;
  }

  // 셀러 노출 미리보기
  function renderSellerPreview(set, ad) {
    const root = $("#adSellerPreview");
    if (!root) return;
    const sched = ad.scheduling || {};
    const items = sched.items || [];
    const drives = ad.drive_links || [];
    const events = ad.events || [];
    const bn = ad.banners || {};

    const dateRange = sched.start_date && sched.end_date
      ? `${sched.start_date} ~ ${sched.end_date}`
      : "일정 미정";

    root.innerHTML = `
      <div class="seller-preview-card">
        <div class="spc-head">
          <h3>📋 셀러 전달용 스케줄 시트</h3>
          <span class="hint">셀러가 보게 될 화면 미리보기</span>
        </div>

        <div class="spc-section">
          <div class="spc-label">공동구매 일정</div>
          <div class="spc-value"><b>${esc(dateRange)}</b></div>
        </div>

        <div class="spc-section">
          <div class="spc-label">📅 진행 일정</div>
          <div class="spc-timeline">
            ${items.length ? items.map(it => `
              <div class="spc-tl-row">
                <span class="spc-tl-date">${esc(it.date || "")}</span>
                <span class="spc-tl-text">${esc(it.label || "")}</span>
              </div>
            `).join("") : '<div class="hint">스케줄 미설정 — 위 [⚡ 자동 스케줄링]</div>'}
          </div>
        </div>

        ${events.length ? `
        <div class="spc-section">
          <div class="spc-label">🎁 이벤트</div>
          <ul class="spc-list">
            ${events.map(e => `<li>${esc(typeof e === "string" ? e : e.text || "")}</li>`).join("")}
          </ul>
        </div>` : ""}

        ${drives.length ? `
        <div class="spc-section">
          <div class="spc-label">🔗 전달 자료</div>
          <ul class="spc-list">
            ${drives.map(d => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label || "자료")}</a></li>`).join("")}
          </ul>
        </div>` : ""}

        <div class="spc-section">
          <div class="spc-label">🖼️ 배너 진행 현황</div>
          <div class="spc-banner-grid">
            ${["openfeed","price","event"].map(k => {
              const v = bn[k] || {};
              const lbl = { openfeed: "오픈피드", price: "가격", event: "이벤트" }[k];
              return `<div class="spc-banner ${v.checked ? "spc-done" : ""}">${v.checked ? "✓" : "○"} ${lbl}</div>`;
            }).join("")}
          </div>
        </div>

        <div class="spc-actions">
          <button class="btn-secondary" data-v2="ad-preview-export">📋 클립보드로 복사</button>
          <button class="btn-secondary" data-v2="ad-preview-print">🖨 인쇄 / PDF</button>
        </div>
      </div>
    `;
  }

  // ─── ACTIONS ────────────────────────────────────────────
  async function patchAd(patch) {
    try {
      await api(`/api/campaigns_v2/${s.activeCamId}/sets/${s.activeSetId}/ads/${s.activeMarketId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
    } catch (e) { alert("실패: " + e.message); }
  }

  function newCampaign() {
    const dlg = $("#campNewDialog");
    if (!dlg) return;
    const form = $("#campNewForm");
    if (form) form.reset();
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  }

  async function submitCampaignForm(e) {
    e.preventDefault();
    const form = $("#campNewForm");
    if (!form) return;
    const fd = new FormData(form);
    const seller = (fd.get("seller_name") || "").toString().trim();
    if (!seller) { alert("셀러명 박아"); return; }
    const payload = {
      seller_name: seller,
      brand: (fd.get("brand") || "").toString().trim(),
      product: (fd.get("product") || "").toString().trim(),
      type: fd.get("type") || "마이크로",
      status: fd.get("status") || "준비중",
      market_schedule: fd.get("market_schedule") || "",
      expected_revenue: parseInt(fd.get("expected_revenue")) || 0,
      expected_cost: parseInt(fd.get("expected_cost")) || 0,
      linked_handle: (fd.get("linked_handle") || "").toString().trim().replace(/^@/, ""),
      notes: (fd.get("notes") || "").toString().trim(),
    };
    try {
      const r = await api("/api/campaigns_v2", { method: "POST", body: JSON.stringify(payload) });
      $("#campNewDialog")?.close?.();
      window.showToast?.({ icon: "📣", title: "캠페인 만들어짐", body: `${seller} · ${payload.brand}`, accent: true });
      await loadList();
      openCampaign(r.campaign.id);
    } catch (err) { alert("실패: " + err.message); }
  }

  async function addSet() {
    try {
      await api(`/api/campaigns_v2/${s.activeCamId}/sets`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
    } catch (e) { alert("실패: " + e.message); }
  }

  // 자동 스케줄링 — 라이브 시작일 + 길이 → 거꾸로 일정 박기
  async function autoSchedule() {
    const date = $("#adAutoLiveDate").value;
    const days = parseInt($("#adAutoLiveDays").value || "7");
    if (!date) { alert("라이브 시작일 박아"); return; }
    const start = new Date(date);
    const end = new Date(start); end.setDate(end.getDate() + days - 1);
    const off = d => { const x = new Date(start); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

    const items = [
      { date: off(-5), label: "📦 제품 발송 마감" },
      { date: off(-3), label: "🖼️ 배너 최종 마감" },
      { date: off(-2), label: "🎬 릴스 최종 마감" },
      { date: off(-1), label: "🎤 사전 리허설" },
      { date: off(0), label: "🟢 공동구매 라이브 시작" },
      { date: off(Math.floor(days / 2)), label: "📊 중간 점검" },
      { date: off(days - 1), label: "🔴 공동구매 마감" },
    ];
    return patchAd({
      scheduling: {
        start_date: date,
        end_date: end.toISOString().slice(0, 10),
        items,
      },
    });
  }

  // 셀러 미리보기 → 클립보드 복사
  function exportPreviewToClipboard() {
    const root = $("#adSellerPreview");
    if (!root) return;
    const text = root.innerText.replace(/\n{3,}/g, "\n\n").trim();
    navigator.clipboard.writeText(text).then(() => {
      window.showToast?.({ icon: "📋", title: "클립보드 복사 완료", body: "셀러한테 그대로 붙여넣기" });
    }).catch(e => alert("복사 실패: " + e.message));
  }

  function printPreview() {
    const root = $("#adSellerPreview");
    if (!root) return;
    const w = window.open("", "_blank");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>셀러 스케줄</title>
      <style>body{font-family:Pretendard,sans-serif;padding:30px;max-width:700px;margin:auto}
      h3{color:#FF6B35;border-bottom:2px solid #FF6B35;padding-bottom:6px}
      .spc-section{margin:14px 0;padding:10px 12px;background:#fafaf6;border-radius:6px}
      .spc-label{font-size:11px;color:#888;text-transform:uppercase;margin-bottom:4px}
      .spc-tl-row{padding:4px 0;display:flex;gap:10px}
      .spc-tl-date{font-weight:600;color:#FF6B35;min-width:90px}
      .spc-banner-grid{display:flex;gap:8px}
      .spc-banner{padding:4px 10px;background:#fff;border:1px solid #ccc;border-radius:4px;font-size:12px}
      .spc-done{background:#e8f5e8;color:#2e7d32}
      .spc-actions{display:none}
      ul{padding-left:20px}</style></head><body>` + root.innerHTML + "</body></html>");
    w.document.close();
    setTimeout(() => w.print(), 300);
  }

  // ─── EVENT HANDLERS ─────────────────────────────────────
  document.addEventListener("click", async (e) => {
    // 메타 탭 전환
    const mt = e.target.closest(".meta-tab");
    if (mt) {
      const tab = mt.dataset.metaTab;
      s.activeMetaTab = tab;
      $$(".meta-tab").forEach(t => t.classList.toggle("active", t === mt));
      ["campaigns","sets","markets"].forEach(t => {
        const p = $(`#metaPane${t.charAt(0).toUpperCase() + t.slice(1)}`);
        if (p) p.hidden = (t !== tab);
      });
      return;
    }

    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    if (what === "cam-new") return newCampaign();
    if (what === "cnf-close") { $("#campNewDialog")?.close?.(); return; }
    if (what === "cam-open" || what === "cam-detail") return openCampaign(trg.dataset.id);
    if (what === "set-open" || what === "set-detail") {
      const camId = trg.dataset.cam || s.activeCamId;
      if (camId !== s.activeCamId) await openCampaign(camId);
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const set = c.sets.find(x => x.id === trg.dataset.id);
      if (set && set.ads && set.ads[0]) {
        s.activeSetId = set.id;
        s.activeMarketId = set.ads[0].id;
        renderCamDetail(c);
      }
      return;
    }
    if (what === "market-open" || what === "market-detail") {
      const camId = trg.dataset.cam;
      if (camId !== s.activeCamId) await openCampaign(camId);
      s.activeSetId = trg.dataset.set;
      s.activeMarketId = trg.dataset.id;
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
      return;
    }
    if (what === "ad-open") {
      s.activeSetId = trg.dataset.set;
      s.activeMarketId = trg.dataset.id;
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
      return;
    }
    if (what === "cam-back") return backToList();
    if (what === "cam-add-set") return addSet();

    // AD 내부 액션
    if (what === "ad-save-product") return patchAd({ product_sent_date: $("#adProductSentDate").value || null });
    if (what === "ad-save-sched") {
      return patchAd({ scheduling: {
        start_date: $("#adSchedStart").value || null,
        end_date: $("#adSchedEnd").value || null,
      }});
    }
    if (what === "ad-save-revenue") {
      return patchAd({
        revenue: parseInt($("#adRevenueInput").value) || 0,
        cost: parseInt($("#adCostInput").value) || 0,
      });
    }
    if (what === "ad-auto-schedule") return autoSchedule();
    if (what === "ad-preview-export") return exportPreviewToClipboard();
    if (what === "ad-preview-print") return printPreview();

    if (what === "ad-sched-add") {
      const date = $("#adSchedNewDate").value;
      const label = $("#adSchedNewLabel").value.trim();
      if (!date || !label) { alert("날짜 + 라벨 박아"); return; }
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const items = ad.scheduling?.items || [];
      items.push({ date, label });
      $("#adSchedNewDate").value = "";
      $("#adSchedNewLabel").value = "";
      return patchAd({ scheduling: { ...(ad.scheduling || {}), items } });
    }
    if (what === "ad-sched-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const items = (ad.scheduling?.items || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ scheduling: { ...(ad.scheduling || {}), items } });
    }
    if (what === "ad-event-add") {
      const text = $("#adEventNew").value.trim();
      if (!text) return;
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const events = [...(ad.events || []), { text, ts: new Date().toISOString() }];
      $("#adEventNew").value = "";
      return patchAd({ events });
    }
    if (what === "ad-event-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const events = (ad.events || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ events });
    }
    if (what === "ad-drive-add") {
      const label = $("#adDriveNewLabel").value.trim();
      const url = $("#adDriveNewUrl").value.trim();
      if (!url) { alert("URL 박아"); return; }
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const drive_links = [...(ad.drive_links || []), { label: label || "자료", url }];
      $("#adDriveNewLabel").value = "";
      $("#adDriveNewUrl").value = "";
      return patchAd({ drive_links });
    }
    if (what === "ad-drive-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const drive_links = (ad.drive_links || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ drive_links });
    }
    if (what === "ad-reel-add") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      return patchAd({ reels: [...(ad.reels || []), { plan: "", video_url: "", status: "기획중" }] });
    }
    if (what === "ad-reel-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      return patchAd({ reels: (ad.reels || []).filter((_, i) => i !== parseInt(trg.dataset.idx)) });
    }
  });

  document.addEventListener("change", async (e) => {
    if (e.target.dataset.v2 === "ad-banner-toggle") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const banners = { ...(ad.banners || {}) };
      banners[e.target.dataset.key] = { ...(banners[e.target.dataset.key] || {}), checked: e.target.checked };
      patchAd({ banners });
    }
    if (e.target.id === "camAdStatusSel") patchAd({ status: e.target.value });
    if (e.target.dataset.v2 === "cam-toggle-status") {
      // 캠페인 상태 토글
      const camId = e.target.dataset.id;
      const newStatus = e.target.checked ? "진행중" : "준비중";
      try {
        await api(`/api/campaigns_v2/${camId}`, { method: "PATCH", body: JSON.stringify({ status: newStatus }) });
        loadList();
      } catch (err) { alert("실패: " + err.message); }
    }
  });

  document.addEventListener("blur", async (e) => {
    if (e.target.dataset.v2 === "ad-banner-field") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const banners = { ...(ad.banners || {}) };
      const key = e.target.dataset.key;
      banners[key] = { ...(banners[key] || {}), [e.target.dataset.field]: e.target.value };
      patchAd({ banners });
    }
    if (e.target.dataset.v2 === "ad-reel-field") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const reels = [...(ad.reels || [])];
      const idx = parseInt(e.target.dataset.idx);
      reels[idx] = { ...(reels[idx] || {}), [e.target.dataset.field]: e.target.value };
      patchAd({ reels });
    }
  }, true);

  let searchTimer;
  document.addEventListener("input", (e) => {
    if (e.target.id === "camV2Search") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { s.q = e.target.value; renderAll(); }, 200);
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "camV2TypeFilter") { s.typeFilter = e.target.value; renderAll(); }
    if (e.target.id === "camV2StatusFilter") { s.statusFilter = e.target.value; renderAll(); }
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item[data-tab="campaigns"]');
    if (t) setTimeout(loadList, 80);
  });

  // 폼 submit 바인딩
  setTimeout(() => {
    const form = document.getElementById("campNewForm");
    if (form) form.addEventListener("submit", submitCampaignForm);
  }, 200);

  setTimeout(loadList, 800);
})();
