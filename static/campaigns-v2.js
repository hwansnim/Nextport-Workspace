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
      loadGrandTotal();
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

  // 세트 진척도 — features 기준 체크리스트
  function setProgress(set) {
    const feats = set.features || { schedule: true, events: true, drive: true, banners: true, reels: true };
    const ad = (set.ads || [])[0] || {};
    const chips = [];
    if (feats.schedule) {
      const days = ad.content_days || [];
      const hasContent = days.length > 0 && days.some(d => (d.slots || []).some(s2 => s2.caption));
      chips.push({ label: "콘텐츠 생성", done: hasContent });
      // 공유 = 셀러가 한 번이라도 접속했거나 게시 시작
      const posted = days.some(d => (d.slots || []).some(s2 => s2.posted));
      chips.push({ label: "게시 시작", done: posted });
    }
    if (feats.events) chips.push({ label: "이벤트", done: (ad.events || []).length > 0 });
    if (feats.drive) chips.push({ label: "자료 전달", done: (ad.drive_links || []).length > 0 });
    if (feats.banners) {
      const bn = ad.banners || {};
      const allBanner = ["openfeed", "price", "event"].every(k => bn[k]?.checked);
      chips.push({ label: "배너", done: allBanner });
    }
    if (feats.reels) chips.push({ label: "릴스", done: (ad.reels || []).some(r => r.status === "완료") });
    const done = chips.filter(c => c.done).length;
    return { chips, pct: chips.length ? Math.round(done / chips.length * 100) : 0 };
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
  // 펼침 상태 (캠페인id / 세트id Set)
  s.expanded = s.expanded || new Set();

  function renderAll() {
    const items = filtered();
    $("#camV2Stat").textContent = `${items.length} / ${s.campaigns.length}`;
    renderHierarchy(items);
  }

  // ─── 단일 계층 테이블 (캠페인 ▸ 세트 ▸ 마켓) ───────────
  function chevron(open) {
    return `<svg class="ch-chev ${open ? "open" : ""}" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
  }
  function marginCell(m) {
    const cls = m != null && m > 0 ? "meta-good" : (m != null && m < 0 ? "meta-bad" : "");
    return `<span class="ch-margin ${cls}">${fmtPct(m)}</span>`;
  }
  function renderHierarchy(items) {
    const body = $("#camHierBody");
    if (!body) return;
    if (!items.length) {
      body.innerHTML = `<div class="empty" style="padding:40px;text-align:center">캠페인 없음 — [+ 캠페인 만들기] 또는 [진행 예정 셀러]에서 추가</div>`;
      return;
    }
    let html = "";
    items.forEach(c => {
      const t = campaignTotals(c);
      const cOpen = s.expanded.has(c.id);
      html += `
        <div class="ch-row ch-camp" data-v2="ch-toggle-camp" data-id="${esc(c.id)}">
          <span class="ch-toggle"><button class="status-toggle ${c.status === "진행중" ? "on" : ""}" data-v2="cam-toggle-active" data-id="${esc(c.id)}" title="진행중 / 미진행"></button></span>
          <span class="ch-name">
            ${chevron(cOpen)}
            <span class="ch-name-text"><b>${esc(c.seller_name || "셀러 미정")}</b><span class="hint">${esc(c.brand || "-")} · ${esc(c.product || "-")}</span></span>
          </span>
          <span class="ch-type"><span class="cam-type cam-type-${esc(c.type || "")}">${esc(c.type || "?")}</span></span>
          <span class="ch-status"><span class="meta-status s-${esc(c.status || "준비중")}">${statusDot(c.status)} ${esc(c.status || "준비중")}</span></span>
          <span class="ch-num"><b>${fmtKRW(t.revenue)}</b></span>
          <span class="ch-num ch-muted">${fmtKRW(t.cost)}</span>
          ${marginCell(marginPct(t.revenue, t.cost))}
          <span class="ch-date">${esc((c.market_schedule || "-").slice(5))}</span>
        </div>`;
      if (cOpen) {
        (c.sets || []).forEach(st => {
          const stt = setTotals(st);
          const setKey = c.id + "/" + st.id;
          const sOpen = s.expanded.has(setKey);
          const statuses = (st.ads || []).map(a => a.status || "준비중");
          const stStatus = statuses.includes("진행중") ? "진행중" : statuses.includes("완료") ? "완료" : statuses.includes("중단") ? "중단" : "준비중";
          html += `
            <div class="ch-row ch-set" data-v2="ch-toggle-set" data-cam="${esc(c.id)}" data-id="${esc(st.id)}">
              <span class="ch-toggle"></span>
              <span class="ch-name" style="padding-left:34px">
                ${chevron(sOpen)}
                <span class="ch-name-text"><b>${esc(st.label || st.round + "차")}</b><span class="hint">세트</span></span>
              </span>
              <span class="ch-type"></span>
              <span class="ch-status"><span class="meta-status s-${esc(stStatus)}">${esc(stStatus)}</span></span>
              <span class="ch-num">${fmtKRW(stt.revenue)}</span>
              <span class="ch-num ch-muted">${fmtKRW(stt.cost)}</span>
              ${marginCell(marginPct(stt.revenue, stt.cost))}
              <span class="ch-date"></span>
            </div>`;
          if (sOpen) {
            (st.ads || []).forEach(ad => {
              const at = marketTotals(ad);
              html += `
                <div class="ch-row ch-market" data-v2="market-open" data-cam="${esc(c.id)}" data-set="${esc(st.id)}" data-id="${esc(ad.id)}">
                  <span class="ch-toggle"></span>
                  <span class="ch-name" style="padding-left:62px">
                    <span class="ch-name-text"><b style="font-weight:500">${esc(ad.name || "공동구매")}</b></span>
                  </span>
                  <span class="ch-type"></span>
                  <span class="ch-status"><span class="meta-status s-${esc(ad.status || "준비중")}">${esc(ad.status || "준비중")}</span></span>
                  <span class="ch-num">${fmtKRW(at.revenue)}</span>
                  <span class="ch-num ch-muted">${fmtKRW(at.cost)}</span>
                  ${marginCell(marginPct(at.revenue, at.cost))}
                  <span class="ch-date">${esc((ad.scheduling?.start_date || "-").slice(5))}</span>
                </div>`;
            });
            if (!(st.ads || []).length) html += `<div class="ch-row ch-empty">마켓 없음</div>`;
          }
        });
        if (!(c.sets || []).length) html += `<div class="ch-row ch-empty">세트 없음 — 캠페인 진입 후 [+ 다음 차수 추가]</div>`;
      }
    });
    body.innerHTML = html;
  }

  function statusDot(s) {
    const m = { "진행중": "🟢", "준비중": "⚪", "완료": "🟣", "중단": "🔴" };
    return m[s] || "⚪";
  }

  // ─── 정산 (일자별 가로 스크롤 + 열 토글) ───────────────
  // 컬럼 정의: computed는 자동계산
  const STL_COLS = [
    { key: "date", label: "날짜", type: "date", w: 110, fixed: true },
    { key: "product", label: "제품", type: "text", w: 120 },
    { key: "open_type", label: "오픈", type: "select", opts: ["본사", "셀러"], w: 70 },
    { key: "is_business", label: "사업자", type: "select", opts: ["Y", "N"], w: 64 },
    { key: "qty", label: "건수", type: "num", w: 64 },
    { key: "revenue", label: "매출", type: "won", w: 110 },
    { key: "rs_pct", label: "RS%", type: "pct", w: 64 },
    { key: "cogs", label: "원가", type: "won", w: 100 },
    { key: "shipping", label: "배송비", type: "won", w: 90 },
    { key: "event_cost", label: "이벤트비", type: "won", w: 95 },
    { key: "seller_fee", label: "셀러수수료", type: "won", w: 100 },
    { key: "pg_fee", label: "PG수수료", type: "won", w: 95 },
    { key: "pg_split", label: "PG반반", type: "select", opts: ["Y", "N"], w: 64 },
    { key: "contribution", label: "공헌", type: "won", w: 110, computed: true },
    { key: "contribution_pct", label: "매출대비%", type: "pct", w: 80, computed: true },
    { key: "memo", label: "메모", type: "text", w: 140 },
  ];
  const STL_DEFAULT_VISIBLE = STL_COLS.map(c => c.key); // 기본 전부

  function rowContribution(r) {
    const rev = parseInt(r.revenue) || 0;
    const cost = ["cogs", "shipping", "event_cost", "seller_fee", "pg_fee"]
      .reduce((a, k) => a + (parseInt(r[k]) || 0), 0);
    return rev - cost;
  }

  function renderSettlement(c) {
    const stl = c.settlement || { settings: {}, rows: [] };
    const visible = stl.settings?.visible_columns || STL_DEFAULT_VISIBLE;
    const rows = stl.rows || [];
    s.settleVisible = visible;

    const cols = STL_COLS.filter(col => visible.includes(col.key) || col.fixed);

    // 헤더
    const head = $("#stlHead");
    if (head) {
      head.innerHTML = `<tr>${cols.map(col =>
        `<th style="min-width:${col.w}px" class="${["won","num","pct"].includes(col.type)?'num':''}">${esc(col.label)}</th>`
      ).join("")}<th style="min-width:40px"></th></tr>`;
    }
    // 바디
    const body = $("#stlBody");
    if (body) {
      if (!rows.length) {
        body.innerHTML = `<tr><td colspan="${cols.length+1}" class="empty">정산 행 없음 — [+ 일자 추가]</td></tr>`;
      } else {
        body.innerHTML = rows.map((r, ri) => {
          const contrib = rowContribution(r);
          const rev = parseInt(r.revenue) || 0;
          const cPct = rev ? Math.round(contrib / rev * 1000) / 10 : null;
          return `<tr data-ri="${ri}">${cols.map(col => {
            if (col.key === "contribution") return `<td class="num"><b style="color:${contrib>=0?'var(--accent)':'#c62828'}">${fmtKRW(contrib)}</b></td>`;
            if (col.key === "contribution_pct") return `<td class="num">${cPct!=null?cPct+'%':'—'}</td>`;
            const val = r[col.key] ?? "";
            if (col.type === "select") {
              return `<td><select class="stl-cell-sel" data-v2="stl-edit" data-ri="${ri}" data-k="${col.key}">
                <option value=""></option>
                ${col.opts.map(o => `<option ${o===val?'selected':''}>${o}</option>`).join("")}
              </select></td>`;
            }
            const align = ["won","num","pct"].includes(col.type) ? 'num' : '';
            const inputType = (col.type==="date") ? "date" : (["won","num","pct"].includes(col.type) ? "number" : "text");
            const disp = col.type === "won" && val !== "" ? val : val;
            return `<td class="${align}"><input class="stl-cell-inp" type="${inputType}" data-v2="stl-edit" data-ri="${ri}" data-k="${col.key}" value="${esc(disp)}" /></td>`;
          }).join("")}<td><button class="btn-text" data-v2="stl-del-row" data-ri="${ri}">×</button></td></tr>`;
        }).join("");
      }
    }
    // 합계
    const foot = $("#stlFoot");
    if (foot && rows.length) {
      const sum = (k) => rows.reduce((a, r) => a + (parseInt(r[k]) || 0), 0);
      const tRev = sum("revenue"), tContrib = rows.reduce((a, r) => a + rowContribution(r), 0);
      const tPct = tRev ? Math.round(tContrib / tRev * 1000) / 10 : null;
      foot.innerHTML = `<tr class="stl-total">${cols.map(col => {
        if (col.fixed) return `<td><b>합계</b></td>`;
        if (col.key === "revenue") return `<td class="num"><b>${fmtKRW(tRev)}</b></td>`;
        if (col.key === "contribution") return `<td class="num"><b style="color:var(--accent)">${fmtKRW(tContrib)}</b></td>`;
        if (col.key === "contribution_pct") return `<td class="num"><b>${tPct!=null?tPct+'%':'—'}</b></td>`;
        if (["cogs","shipping","event_cost","seller_fee","pg_fee","qty"].includes(col.key)) return `<td class="num">${col.type==='won'?fmtKRW(sum(col.key)):sum(col.key)}</td>`;
        return `<td></td>`;
      }).join("")}<td></td></tr>`;
    } else if (foot) foot.innerHTML = "";

    // 요약 + 기본값
    const summ = $("#camSettleSummary");
    if (summ) {
      const tRev = rows.reduce((a, r) => a + (parseInt(r.revenue)||0), 0);
      const tContrib = rows.reduce((a, r) => a + rowContribution(r), 0);
      summ.innerHTML = `매출 <b>${fmtKRW(tRev)}</b> · 공헌 <b style="color:var(--accent)">${fmtKRW(tContrib)}</b> · ${tRev?Math.round(tContrib/tRev*100):0}%`;
    }
    // 기본값 패널
    const defRoot = $("#stlDefaults");
    if (defRoot) {
      const st = stl.settings || {};
      defRoot.innerHTML = `
        <span class="stl-def-item">신규행 기본:
          오픈 <select data-v2="stl-default" data-k="open_type"><option value="">-</option>${["본사","셀러"].map(o=>`<option ${o===st.open_type?'selected':''}>${o}</option>`).join("")}</select>
          사업자 <select data-v2="stl-default" data-k="is_business"><option value="">-</option>${["Y","N"].map(o=>`<option ${o===st.is_business?'selected':''}>${o}</option>`).join("")}</select>
          RS% <input type="number" data-v2="stl-default" data-k="rs_pct" value="${esc(st.rs_pct??'')}" style="width:54px" />
          PG반반 <select data-v2="stl-default" data-k="pg_split"><option value="">-</option>${["Y","N"].map(o=>`<option ${o===st.pg_split?'selected':''}>${o}</option>`).join("")}</select>
        </span>`;
    }
  }

  function toggleColPop() {
    const pop = $("#stlColPop");
    if (!pop) return;
    if (!pop.hidden) { pop.hidden = true; return; }
    const visible = s.settleVisible || STL_DEFAULT_VISIBLE;
    pop.innerHTML = `<div class="stl-colpop-title">표시할 열 선택</div><div class="stl-colpop-grid">${
      STL_COLS.filter(c => !c.fixed).map(c =>
        `<label><input type="checkbox" data-v2="stl-col-toggle" data-k="${c.key}" ${visible.includes(c.key)?'checked':''} /> ${esc(c.label)}</label>`
      ).join("")
    }</div>`;
    pop.hidden = false;
  }

  async function patchSettlement(patch) {
    try {
      await api(`/api/campaigns_v2/${s.activeCamId}/settlement`, { method: "PATCH", body: JSON.stringify(patch) });
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      s.cachedCampaign = c;
      renderSettlement(c);
      loadGrandTotal();
    } catch (e) { alert("실패: " + e.message); }
  }

  async function loadGrandTotal() {
    try {
      const r = await api("/api/campaigns_v2/totals");
      $("#cgtRevenue") && ($("#cgtRevenue").textContent = fmtKRW(r.total_revenue));
      $("#cgtContrib") && ($("#cgtContrib").textContent = fmtKRW(r.total_contribution));
      $("#cgtPct") && ($("#cgtPct").textContent = r.total_contribution_pct != null ? r.total_contribution_pct + "%" : "—");
      $("#cgtCount") && ($("#cgtCount").textContent = (r.count || 0));
    } catch (e) { /* noop */ }
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
    s.cachedCampaign = c;
    $("#camBcCampaign").textContent = `${c.seller_name || "?"} · ${c.brand || "?"} / ${c.product || "?"}`;
    $("#camBcSetSep").hidden = true;
    $("#camBcSet").hidden = true;

    // 실시간 매출 (마켓 합산)
    const tt = campaignTotals(c);
    const liveEl = $("#camRevenueLive");
    if (liveEl) liveEl.innerHTML = `매출 <b>${fmtKRW(tt.revenue)}</b> · 마진 <b>${marginPct(tt.revenue, tt.cost) ?? "—"}%</b>`;

    const igHref = c.instagram_url || (c.linked_influencer_handle ? `https://instagram.com/${c.linked_influencer_handle}/` : "");
    $("#camMetaBody").innerHTML = `
      <div class="cam-meta-row"><span class="lbl">셀러명</span><span class="val"><b>${esc(c.seller_name || "-")}</b></span></div>
      <div class="cam-meta-row"><span class="lbl">브랜드 / 제품</span><span class="val">${esc(c.brand || "-")} / ${esc(c.product || "-")}</span></div>
      <div class="cam-meta-row"><span class="lbl">타입</span><span class="val"><span class="cam-type cam-type-${esc(c.type || "")}">${esc(c.type || "-")}</span></span></div>
      <div class="cam-meta-row"><span class="lbl">상태</span><span class="val">
        <select data-v2="cam-edit-status" class="cam-edit-sel">
          ${["준비중","진행중","완료","중단"].map(v => `<option ${v===c.status?"selected":""}>${v}</option>`).join("")}
        </select>
      </span></div>
      <div class="cam-meta-row"><span class="lbl">인스타</span><span class="val">
        ${igHref ? `<a href="${esc(igHref)}" target="_blank" rel="noopener" style="color:var(--blue)">@${esc(c.linked_influencer_handle || igHref.split("/").filter(Boolean).pop() || "")}  ↗</a>` : "<span class='hint'>미연결</span>"}
      </span></div>
      <div class="cam-meta-row"><span class="lbl">마켓 시작</span><span class="val">${esc(c.market_schedule || "-")}</span></div>
      <div class="cam-meta-row cam-meta-wide"><span class="lbl">셀러 특징</span>
        <textarea class="cam-edit-textarea" data-v2="cam-edit-traits" rows="2" placeholder="톤·스타일·USP·주의사항">${esc(c.seller_traits || "")}</textarea>
      </div>
      <div class="cam-meta-row cam-meta-wide"><span class="lbl">메모 (내부)</span>
        <textarea class="cam-edit-textarea" data-v2="cam-edit-notes" rows="2">${esc(c.notes || "")}</textarea>
      </div>
    `;

    // 정산 (일자별)
    renderSettlement(c);
    const settleDoneEl = $("#camSettleDone");
    if (settleDoneEl) settleDoneEl.checked = !!c.settlement_done;

    // 제품 발송 (캠페인 레벨)
    const ps = c.product_shipping || {};
    const shipRoot = $("#camShippingBody");
    if (shipRoot) {
      shipRoot.innerHTML = `
        <div class="cam-meta-row"><span class="lbl">발송일</span><span class="val"><input type="date" data-v2="cam-ship" data-f="sent_date" value="${esc(ps.sent_date || "")}" /></span></div>
        <div class="cam-meta-row"><span class="lbl">택배사</span><span class="val"><input type="text" data-v2="cam-ship" data-f="carrier" value="${esc(ps.carrier || "")}" placeholder="CJ대한통운" /></span></div>
        <div class="cam-meta-row"><span class="lbl">송장번호</span><span class="val"><input type="text" data-v2="cam-ship" data-f="tracking_no" value="${esc(ps.tracking_no || "")}" /></span></div>
        <div class="cam-meta-row cam-meta-wide"><span class="lbl">메모</span><span class="val"><input type="text" data-v2="cam-ship" data-f="note" value="${esc(ps.note || "")}" placeholder="구성: 3개월 분량, 1+1 등" /></span></div>
      `;
    }

    const setsRoot = $("#camSetsBody");
    if (!(c.sets || []).length) {
      setsRoot.innerHTML = `<div class="empty" style="padding:30px;text-align:center;color:#888">세트 없음. [+ 다음 차수 추가] 클릭</div>`;
    } else {
      setsRoot.innerHTML = c.sets.map(st => {
        const tt = setTotals(st);
        const margin = marginPct(tt.revenue, tt.cost);
        const adCount = (st.ads || []).length;
        const sd = (st.ads || [])[0]?.scheduling?.start_date || "";
        const ed = (st.ads || [])[0]?.scheduling?.end_date || "";
        const prog = setProgress(st);
        return `
          <div class="cam-set ${st.id === s.activeSetId ? "active" : ""}">
            <div class="cam-set-head" data-v2="set-open" data-id="${esc(st.id)}">
              <span class="cam-set-round">${esc(st.label || st.round + "차")}</span>
              <span class="cam-set-stat">${adCount}개 마켓 · ${sd || "—"} ~ ${ed || "—"}</span>
              <span class="cam-set-rev">매출 <b>${fmtKRW(tt.revenue)}</b> · 마진 <b>${margin ?? "—"}%</b></span>
            </div>
            <div class="cam-set-progress">
              <div class="csp-bar"><span style="width:${prog.pct}%"></span></div>
              <div class="csp-chips">
                ${prog.chips.map(ch => `<span class="csp-chip ${ch.done?'csp-done':''}">${ch.done?'✓':'○'} ${esc(ch.label)}</span>`).join("")}
              </div>
            </div>
            <input class="cam-set-memo" placeholder="세트 메모 (이번 차수 키 포인트)" data-v2="set-memo" data-id="${esc(st.id)}" value="${esc(st.memo || "")}" />
            <label class="cam-set-ship">📦 마지막 제품 발송일 <input type="date" data-v2="set-ship" data-id="${esc(st.id)}" value="${esc(st.last_ship_date || "")}" /></label>
            <div class="cam-set-ads">
              ${(st.ads || []).map(a => `
                <div class="cam-ad-chip ${a.id === s.activeMarketId ? "active" : ""}" data-v2="ad-open" data-set="${esc(st.id)}" data-id="${esc(a.id)}">
                  <span>${esc(a.name)}</span>
                  <span class="cam-status s-${esc(a.status || "준비중")}">${esc(a.status || "준비중")}</span>
                </div>
              `).join("")}
            </div>
          </div>
        `;
      }).join("");
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

    // 세트 features 토글에 따라 섹션 표시/숨김
    applyFeatureToggles(set);

    renderContentGuide(ad);

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

    // 날짜별 매출 + 셀러 미리보기(모바일) + 트래킹
    renderSalesTable(ad);
    renderSellerMobilePreview(set, ad);
    loadTracking();
  }

  // 세트 features 토글 — 섹션 표시/숨김
  function applyFeatureToggles(set) {
    const feats = set.features || { schedule: true, events: true, drive: true, banners: true, reels: true };
    document.querySelectorAll("#camAdDetailWrap [data-feat]").forEach(el => {
      const f = el.dataset.feat;
      // sales / preview 는 항상 표시
      if (f === "sales" || f === "preview") { el.hidden = false; return; }
      el.hidden = !feats[f];
    });
  }

  // 날짜별 매출/비용 테이블
  function renderSalesTable(ad) {
    const body = $("#adSalesBody");
    const foot = $("#adSalesFoot");
    if (!body) return;
    const sales = ad.sales || [];
    body.innerHTML = sales.length
      ? sales.map((r, i) => `
        <tr data-idx="${i}">
          <td>${esc(r.date || "")}</td>
          <td>${esc(r.memo || "")}</td>
          <td class="num">${r.qty || 0}</td>
          <td class="num">${fmtKRW(r.revenue)}</td>
          <td class="num" style="color:#888">${fmtKRW(r.cost)}</td>
          <td><button class="btn-text" data-v2="ad-sales-del" data-idx="${i}">×</button></td>
        </tr>`).join("")
      : `<tr><td colspan="6" class="empty">매출 입력 없음 — 아래에서 날짜별로 박기</td></tr>`;
    const tRev = sales.reduce((a, r) => a + (parseInt(r.revenue) || 0), 0);
    const tCost = sales.reduce((a, r) => a + (parseInt(r.cost) || 0), 0);
    const tQty = sales.reduce((a, r) => a + (parseInt(r.qty) || 0), 0);
    const margin = marginPct(tRev, tCost);
    if (foot) {
      foot.innerHTML = sales.length ? `
        <tr class="ad-sales-total">
          <td colspan="2" style="text-align:right;font-weight:700">합계</td>
          <td class="num"><b>${tQty}</b></td>
          <td class="num"><b>${fmtKRW(tRev)}</b></td>
          <td class="num"><b>${fmtKRW(tCost)}</b></td>
          <td></td>
        </tr>
        <tr><td colspan="6" style="text-align:right;font-size:11.5px;color:var(--accent)">공헌이익 <b>${fmtKRW(tRev - tCost)}</b> · 마진율 <b>${fmtPct(margin)}</b></td></tr>
      ` : "";
    }
  }

  // 셀러 노출 미리보기 — 모바일 프레임에 실제 셀러뷰 iframe
  async function renderSellerMobilePreview(set, ad) {
    const iframe = $("#adSellerIframe");
    if (!iframe) return;
    try {
      const r = await api(`/api/campaigns_v2/${s.activeCamId}/sets/${s.activeSetId}/ads/${s.activeMarketId}/share`);
      const url = r.path + "?preview=1";
      if (iframe.dataset.src !== url) {
        iframe.dataset.src = url;
        iframe.src = url;
      }
    } catch (e) { /* noop */ }
  }

  // 셀러 접속 트래킹
  async function loadTracking() {
    const root = $("#adSellerTrack");
    if (!root) return;
    try {
      const r = await api(`/api/campaigns_v2/${s.activeCamId}/sets/${s.activeSetId}/ads/${s.activeMarketId}/tracking`);
      const fmtDur = sec => {
        sec = sec || 0;
        if (sec < 60) return `${sec}초`;
        const m = Math.floor(sec / 60), s2 = sec % 60;
        return m < 60 ? `${m}분 ${s2}초` : `${Math.floor(m/60)}시간 ${m%60}분`;
      };
      const sessions = r.sessions || [];
      root.innerHTML = `
        <div class="sp-track-stat">
          <div><span class="t-num">${r.visit_count || 0}</span><span class="t-lbl">접속 횟수</span></div>
          <div><span class="t-num">${fmtDur(r.total_seconds)}</span><span class="t-lbl">누적 체류</span></div>
        </div>
        ${r.last_at ? `<div class="hint" style="margin:6px 0">마지막 접속: ${esc(r.last_at.replace("T"," "))}</div>` : ""}
        <div class="sp-track-list">
          ${sessions.length ? sessions.slice(0, 12).map(se => `
            <div class="sp-track-row">
              <span>${esc((se.started_at||"").replace("T"," ").slice(5,16))}</span>
              <span class="t-dur">${fmtDur(se.seconds)}</span>
            </div>`).join("") : '<div class="hint">아직 접속 기록 없음 — 셀러가 링크 열면 쌓임</div>'}
        </div>
      `;
    } catch (e) {
      root.innerHTML = `<div class="hint">트래킹 로드 실패</div>`;
    }
  }

  // ─── 콘텐츠 가이드 (스토리 자동 스케줄) ───────────────
  function renderContentGuide(ad) {
    const root = $("#contentGuideBody");
    const stat = $("#contentGuideStat");
    if (!root) return;
    const days = ad.content_days || [];
    const meta = ad.content_gen_meta || {};
    if (stat) {
      stat.textContent = days.length
        ? `${days.length}일 · ${meta.gemini_used ? "🤖 AI 생성" : "수동"}${meta.tone_samples_count ? ` · 톤샘플 ${meta.tone_samples_count}` : ""}`
        : "비어있음";
    }
    if (!days.length) {
      root.innerHTML = `
        <div class="empty" style="padding:30px;text-align:center">
          [✨ 생성] 눌러서 제품 정보 + 소구점 입력<br>
          <span class="hint">셀러 인스타 말투를 학습해서 복붙 가능한 콘텐츠를 만들어줍니다</span>
        </div>`;
      return;
    }
    const slotCell = (sl, di, si, isFeed) => `
      <td class="cg-slot ${isFeed ? "cg-feed-slot" : ""} ${sl.posted ? "cg-posted" : ""}" data-di="${di}" data-si="${si}">
        <div class="cg-img-box" data-v2="cg-pick-img" data-di="${di}" data-si="${si}">
          ${sl.image_url
            ? `<img src="${esc(sl.image_url)}" alt="" loading="lazy" /><span class="cg-img-change">🔄 변경</span>`
            : `<span class="cg-img-empty">📷 이미지 선택</span>`}
        </div>
        <input class="cg-concept" placeholder="소구점/제목" data-v2="cg-slot-edit" data-di="${di}" data-si="${si}" data-f="concept" value="${esc(sl.concept || "")}" />
        <textarea class="cg-caption" placeholder="스토리 멘트" data-v2="cg-slot-edit" data-di="${di}" data-si="${si}" data-f="caption" rows="4">${esc(sl.caption || "")}</textarea>
        <div class="cg-slot-foot">
          ${sl.live_url ? `<a href="${esc(sl.live_url)}" target="_blank" rel="noopener" class="cg-live-link" title="셀러가 올린 링크">🔗 라이브</a>` : `<span class="hint" style="font-size:10px">${sl.posted ? "✅ 올림" : "미게시"}</span>`}
          <button class="btn-text cg-post-btn" data-v2="cg-toggle-posted" data-di="${di}" data-si="${si}" title="${sl.posted ? '게시 취소' : '게시 완료'}">${sl.posted ? "✅" : "⬜"}</button>
        </div>
      </td>`;
    root.innerHTML = `
      <div class="cg-table-wrap">
        <table class="cg-table">
          <thead>
            <tr>
              <th style="width:70px">날짜</th>
              <th style="width:56px">D-day</th>
              ${[1,2,3,4,5].map(i => `<th>STORY ${i}</th>`).join("")}
              <th>📸 피드</th>
              <th style="width:40px"></th>
            </tr>
          </thead>
          <tbody>
            ${days.map((d, di) => `
              <tr class="cg-day cg-phase-${esc(d.phase)}">
                <td class="cg-date-cell"><b>${esc(d.date.slice(5))}</b><br><span class="hint">${esc(d.weekday)}</span></td>
                <td class="cg-dday-cell"><span class="cg-dlabel">${esc(d.d_label)}</span><br><span class="cg-phase-tag">${esc(d.phase)}</span></td>
                ${(d.slots || []).slice(0, 5).map((sl, si) => slotCell(sl, di, si, false)).join("")}
                ${(d.slots || []).slice(5, 6).map((sl) => slotCell(sl, di, 5, true)).join("")}
                <td class="cg-day-actions">
                  <button class="btn-text" data-v2="cg-clear-day" data-di="${di}" title="이 날 빈슬롯">🧹</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="hint" style="padding:8px 12px">💡 셀 직접 수정 → 자동 저장 · 이미지 클릭 = 아카이브에서 변경 · ✅ = 게시 완료 (셀러가 올리면 자동 체크됨)</div>
    `;
  }

  async function patchContentSlot(di, si, field, value) {
    const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
    const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
    if (!ad) return;
    const days = JSON.parse(JSON.stringify(ad.content_days || []));
    if (!days[di] || !days[di].slots || !days[di].slots[si]) return;
    days[di].slots[si][field] = value;
    return patchAd({ content_days: days });
  }

  // ─── 생성 다이얼로그 ───
  function openGenDialog() {
    const c = s.cachedCampaign;
    const dlg = $("#contentGenDialog");
    if (!dlg) return;
    const form = $("#contentGenForm");
    if (form) {
      form.reset();
      // 캠페인에서 제품명 자동 채움
      if (c?.product) form.querySelector("[name=p_name]").value = c.product;
    }
    // 톤 안내
    const note = $("#cgToneNote");
    if (note) {
      const handle = c?.linked_influencer_handle;
      note.innerHTML = handle
        ? `🎤 학습 대상: <b>@${esc(handle)}</b> — 아카이브에 이 셀러 콘텐츠가 있으면 말투를 더 정확히 따라합니다.`
        : `⚠️ 연결된 인스타 핸들이 없어 generic 톤으로 생성됩니다. (캠페인 편집에서 인스타 링크 박으면 톤 학습)`;
    }
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  }

  async function submitGen(e) {
    e.preventDefault();
    const form = $("#contentGenForm");
    const fd = new FormData(form);
    const pName = (fd.get("p_name") || "").toString().trim();
    if (!pName) { alert("제품명 박아"); return; }
    const sp = (fd.get("selling_points") || "").toString().split("\n").map(x => x.trim()).filter(Boolean);
    const payload = {
      product: {
        name: pName,
        usp: (fd.get("p_usp") || "").toString().trim(),
        detail: (fd.get("p_detail") || "").toString().trim(),
        price: (fd.get("p_price") || "").toString().trim(),
        avoid: (fd.get("p_avoid") || "").toString().trim(),
      },
      selling_points: sp,
      length: fd.get("length") || "medium",
      attach_images: fd.get("attach_images") === "1",
    };
    const btn = $("#cgGenSubmit");
    if (btn) { btn.disabled = true; btn.textContent = "✨ 생성 중… (최대 30초)"; }
    try {
      const r = await api(`/api/campaigns_v2/${s.activeCamId}/sets/${s.activeSetId}/ads/${s.activeMarketId}/generate`, {
        method: "POST", body: JSON.stringify(payload),
      });
      $("#contentGenDialog")?.close?.();
      if (r.error) { alert("실패: " + r.error); return; }
      window.showToast?.({
        icon: r.gemini_used ? "🤖" : "📝",
        title: r.gemini_used ? "AI 콘텐츠 생성 완료" : "생성 완료 (Gemini 미사용)",
        body: `${r.days}일 · 톤샘플 ${r.tone_samples_count} · 이미지 ${r.images_attached}`,
        accent: true, ttl: 6000,
      });
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
    } catch (err) {
      alert("실패: " + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "✨ 생성 시작"; }
    }
  }

  // ─── 이미지 피커 ───
  async function openImgPicker(di, si) {
    s.pickTarget = { di, si };
    const dlg = $("#imgPickerDialog");
    if (!dlg) return;
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    const grid = $("#imgPickerGrid");
    grid.innerHTML = `<div class="empty">로딩…</div>`;
    try {
      const handle = s.cachedCampaign?.linked_influencer_handle || "";
      // 본인 셀러 우선, 없으면 전체
      let r = handle ? await api(`/api/archive/images?handle=${encodeURIComponent(handle)}`) : { images: [] };
      if (!r.images?.length) r = await api(`/api/archive/images`);
      if (!r.images?.length) {
        grid.innerHTML = `<div class="empty" style="padding:30px;text-align:center">
          아카이브에 이미지 없음.<br><span class="hint">[콘텐츠 도구 → 셀러 아카이브]에서 셀러 콘텐츠를 먼저 긁어오세요 (PC + 인스타 로그인 필요)</span>
        </div>`;
        return;
      }
      grid.innerHTML = r.images.map(img => `
        <div class="img-pick-item" data-v2="imgpick-select" data-url="${esc(img.url)}">
          <img src="${esc(img.url)}" alt="" loading="lazy" />
          <span class="ipi-src">${esc(img.source)}${img.highlight ? " · " + esc(img.highlight) : ""}</span>
        </div>`).join("");
    } catch (e) {
      grid.innerHTML = `<div class="empty">실패: ${esc(e.message)}</div>`;
    }
  }

  async function shareLink() {
    if (!s.activeMarketId) { alert("광고(마켓) 먼저 선택"); return; }
    try {
      const r = await api(`/api/campaigns_v2/${s.activeCamId}/sets/${s.activeSetId}/ads/${s.activeMarketId}/share`);
      const url = location.origin + r.path;
      await navigator.clipboard.writeText(url);
      window.showToast?.({ icon: "🔗", title: "셀러 링크 복사됨", body: "셀러한테 그대로 보내세요 (모바일 최적화)", accent: true, ttl: 7000 });
      prompt("셀러한테 보낼 링크 (복사됨):", url);
    } catch (e) { alert("실패: " + e.message); }
  }

  function exportContentToClipboard() {
    const c = s.cachedCampaign;
    const set = c?.sets?.find(x => x.id === s.activeSetId);
    const ad = set?.ads?.find(x => x.id === s.activeMarketId);
    if (!ad?.content_days?.length) { alert("콘텐츠 없음"); return; }
    const lines = [];
    lines.push(`${c.seller_name || ""}${c.linked_influencer_handle ? "(@" + c.linked_influencer_handle + ")" : ""} × 하루픽스 ${c.brand || ""} ${set?.label || ""} 공동구매 스케줄링`);
    lines.push("");
    if (c.seller_traits) { lines.push(`[셀러 특징] ${c.seller_traits}`); lines.push(""); }
    ad.content_days.forEach(d => {
      lines.push(`━━━━━ ${d.date}(${d.weekday}) ${d.d_label} [${d.phase}] ━━━━━`);
      d.slots.forEach((sl, i) => {
        if (sl.concept || sl.caption) {
          lines.push(`▸ ${sl.title} — ${sl.concept || ""}`);
          if (sl.caption) lines.push(`  "${sl.caption}"`);
          if (sl.image_url) lines.push(`  📷 ${sl.image_url}`);
        }
      });
      lines.push("");
    });
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      window.showToast?.({ icon: "📋", title: "복사됨", body: `${ad.content_days.length}일치 콘텐츠`, accent: true });
    });
  }

  function previewSellerSheet() {
    const c = s.cachedCampaign;
    const set = c?.sets?.find(x => x.id === s.activeSetId);
    const ad = set?.ads?.find(x => x.id === s.activeMarketId);
    if (!ad) return;
    const w = window.open("", "_blank");
    if (!w) return;
    const days = ad.content_days || [];
    const igLink = c.instagram_url || (c.linked_influencer_handle ? `https://instagram.com/${c.linked_influencer_handle}/` : "");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(c.seller_name || "")} 공구 스케줄</title>
      <style>
        body{font-family:Pretendard,sans-serif;padding:30px;max-width:1400px;margin:auto;background:#f9fafb;color:#222}
        h1{color:#3182F6;border-bottom:3px solid #3182F6;padding-bottom:10px}
        h2{color:#3182F6;margin-top:24px;font-size:16px}
        .hdr{background:#eff6ff;padding:12px 16px;border-radius:8px;margin-bottom:18px;border-left:4px solid #3182F6}
        table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.05);font-size:11px}
        th{background:#eff6ff;padding:10px;font-size:11px;text-align:left;border:1px solid #f0ede5}
        td{padding:10px;border:1px solid #f0ede5;vertical-align:top}
        .date-cell{background:#f9fafb;font-weight:700;white-space:nowrap}
        .dday{color:#3182F6;font-weight:700}
        .phase{font-size:10px;color:#888}
        .slot{min-width:170px}
        .slot b{display:block;margin-bottom:4px;color:#3182F6;font-size:11px}
        .slot .cap{font-size:11.5px;line-height:1.5;color:#333;white-space:pre-wrap}
        .feed{background:#fffbeb}
      </style></head><body>
      <h1>${esc(c.seller_name || "")}${c.linked_influencer_handle ? `(@${esc(c.linked_influencer_handle)})` : ""} × 하루픽스 ${esc(c.brand || "")} ${esc(set?.label || "")} 공동구매 스케줄링</h1>
      <div class="hdr">
        <b>📦 제품:</b> ${esc(c.product || "-")} ·
        <b>📅 일정:</b> ${esc((ad.scheduling || {}).start_date || "-")} ~ ${esc((ad.scheduling || {}).end_date || "-")}
        ${igLink ? ` · <b>🔗</b> <a href="${esc(igLink)}" target="_blank">${esc(igLink)}</a>` : ""}
      </div>
      ${c.seller_traits ? `<div class="hdr"><b>✨ 셀러 특징:</b><br>${esc(c.seller_traits).replace(/\n/g, "<br>")}</div>` : ""}
      <table>
        <thead><tr>
          <th style="width:80px">날짜</th><th style="width:60px">D-day</th>
          ${[1,2,3,4,5].map(i => `<th>STORY ${i}</th>`).join("")}
          <th>📸 피드</th>
        </tr></thead>
        <tbody>
          ${days.map(d => `
            <tr>
              <td class="date-cell">${esc(d.date.slice(5))} (${esc(d.weekday)})</td>
              <td class="date-cell"><div class="dday">${esc(d.d_label)}</div><div class="phase">${esc(d.phase)}</div></td>
              ${d.slots.slice(0, 5).map(sl => `<td class="slot"><b>${esc(sl.concept || sl.title)}</b><div class="cap">${esc(sl.caption || "—")}</div></td>`).join("")}
              ${d.slots.slice(5, 6).map(sl => `<td class="slot feed"><b>${esc(sl.concept || sl.title)}</b><div class="cap">${esc(sl.caption || "—")}</div></td>`).join("")}
            </tr>`).join("")}
        </tbody>
      </table>
      </body></html>`);
    w.document.close();
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

    // 인스타 링크 → 핸들 추출
    let igUrl = (fd.get("instagram_url") || "").toString().trim();
    let handle = "";
    if (igUrl) {
      const m = igUrl.match(/instagram\.com\/([^/?\s]+)/);
      if (m) handle = m[1];
      else handle = igUrl.replace(/^@/, "").trim();
      if (!igUrl.startsWith("http")) igUrl = `https://www.instagram.com/${handle}/`;
    }

    const payload = {
      seller_name: seller,
      brand: (fd.get("brand") || "").toString().trim(),
      product: (fd.get("product") || "").toString().trim(),
      type: fd.get("type") || "마이크로",
      status: fd.get("status") || "준비중",
      start_date: fd.get("start_date") || "",
      end_date: fd.get("end_date") || "",
      instagram_url: igUrl,
      linked_handle: handle,
      seller_traits: (fd.get("seller_traits") || "").toString().trim(),
      notes: (fd.get("notes") || "").toString().trim(),
      auto_schedule: true,
    };
    try {
      const r = await api("/api/campaigns_v2", { method: "POST", body: JSON.stringify(payload) });
      $("#campNewDialog")?.close?.();
      window.showToast?.({
        icon: "📣", title: "캠페인 만들어짐",
        body: `${seller}${payload.start_date ? " · 스케줄 자동 생성" : ""}`,
        accent: true,
      });
      await loadList();
      openCampaign(r.campaign.id);
    } catch (err) { alert("실패: " + err.message); }
  }

  // 차수(세트) 추가 — 기능 체크박스 다이얼로그
  function openSetDialog() {
    const dlg = $("#setAddDialog");
    if (!dlg) return;
    const form = $("#setAddForm");
    if (form) {
      form.reset();
      form.querySelectorAll("input[name=feat]").forEach(cb => cb.checked = true);
      const c = s.cachedCampaign;
      const nextRound = ((c?.sets || []).length || 0) + 1;
      $("#setAddLabel").value = `${nextRound}차`;
    }
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  }

  async function submitSetForm(e) {
    e.preventDefault();
    const form = $("#setAddForm");
    const fd = new FormData(form);
    const feats = {};
    ["schedule","events","drive","banners","reels"].forEach(f => feats[f] = false);
    fd.getAll("feat").forEach(f => feats[f] = true);
    try {
      const r = await api(`/api/campaigns_v2/${s.activeCamId}/sets`, {
        method: "POST",
        body: JSON.stringify({ label: (fd.get("set_label") || "").toString().trim(), features: feats }),
      });
      $("#setAddDialog")?.close?.();
      window.showToast?.({ icon: "🎬", title: "차수 추가됨", body: r.set?.label || "", accent: true });
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
    } catch (err) { alert("실패: " + err.message); }
  }

  // ─── EVENT HANDLERS ─────────────────────────────────────
  document.addEventListener("click", async (e) => {
    // 디테일 섹션 접기/펴기 (아코디언) — 헤더 클릭 시. 버튼/입력은 무시.
    const head = e.target.closest("#camV2DetailView .acc > .panel-head, .ad-section > .ad-sec-head");
    if (head && !e.target.closest("button, input, select, textarea, a, label")) {
      head.parentElement.classList.toggle("collapsed");
      return;
    }

    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    // 리스트: 진행/미진행 토글 (맨 좌측)
    if (what === "cam-toggle-active") {
      e.stopPropagation();
      const id = trg.dataset.id;
      const cam = (s.campaigns || []).find(x => x.id === id);
      const next = cam && cam.status === "진행중" ? "준비중" : "진행중";
      try {
        await api(`/api/campaigns_v2/${id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
        if (cam) cam.status = next;
        renderAll();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }

    // 계층 펼침/접힘
    if (what === "ch-toggle-camp") {
      const id = trg.dataset.id;
      if (s.expanded.has(id)) s.expanded.delete(id); else s.expanded.add(id);
      renderAll();
      return;
    }
    if (what === "ch-toggle-set") {
      const key = trg.dataset.cam + "/" + trg.dataset.id;
      if (s.expanded.has(key)) s.expanded.delete(key); else s.expanded.add(key);
      renderAll();
      return;
    }

    if (what === "cam-new") return newCampaign();
    if (what === "cnf-close") { $("#campNewDialog")?.close?.(); return; }
    if (what === "cg-open-gen") return openGenDialog();
    if (what === "cg-gen-close") { $("#contentGenDialog")?.close?.(); return; }
    if (what === "cg-share") return shareLink();
    if (what === "cg-preview") return previewSellerSheet();
    if (what === "cg-export-clip") return exportContentToClipboard();
    if (what === "cg-pick-img") return openImgPicker(parseInt(trg.dataset.di), parseInt(trg.dataset.si));
    if (what === "imgpick-close") { $("#imgPickerDialog")?.close?.(); return; }
    if (what === "imgpick-select") {
      const url = trg.dataset.url;
      const { di, si } = s.pickTarget || {};
      if (di == null) return;
      $("#imgPickerDialog")?.close?.();
      await patchContentSlot(di, si, "image_url", url);
      window.showToast?.({ icon: "🖼", title: "이미지 박힘", body: "" });
      return;
    }
    if (what === "cg-toggle-posted") {
      const di = parseInt(trg.dataset.di), si = parseInt(trg.dataset.si);
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const days = JSON.parse(JSON.stringify(ad.content_days || []));
      if (days[di]?.slots?.[si]) {
        days[di].slots[si].posted = !days[di].slots[si].posted;
        days[di].slots[si].posted_at = days[di].slots[si].posted ? new Date().toISOString() : "";
      }
      return patchAd({ content_days: days });
    }
    if (what === "cg-clear-day") {
      const di = parseInt(trg.dataset.di);
      if (!confirm("이 날 슬롯 다 비울까?")) return;
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const days = JSON.parse(JSON.stringify(ad.content_days || []));
      if (days[di]?.slots) {
        days[di].slots.forEach(sl => { sl.concept = ""; sl.caption = ""; sl.image_url = ""; });
      }
      return patchAd({ content_days: days });
    }
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
    if (what === "cam-add-set") return openSetDialog();

    // ─── 정산 ───
    if (what === "stl-settings") return toggleColPop();
    if (what === "stl-add-row") {
      const c = s.cachedCampaign;
      const st = c.settlement?.settings || {};
      const rows = [...(c.settlement?.rows || [])];
      const today = new Date().toISOString().slice(0, 10);
      rows.push({ date: today, product: c.product || "", open_type: st.open_type || "", is_business: st.is_business || "", rs_pct: st.rs_pct || "", pg_split: st.pg_split || "", qty: "", revenue: "", cogs: "", shipping: "", event_cost: "", seller_fee: "", pg_fee: "", memo: "" });
      return patchSettlement({ rows });
    }
    if (what === "stl-del-row") {
      const ri = parseInt(trg.dataset.ri);
      const rows = (s.cachedCampaign.settlement?.rows || []).filter((_, i) => i !== ri);
      return patchSettlement({ rows });
    }
    if (what === "setadd-close") { $("#setAddDialog")?.close?.(); return; }
    if (what === "sp-reload") {
      const iframe = $("#adSellerIframe");
      if (iframe && iframe.dataset.src) iframe.src = iframe.dataset.src;
      loadTracking();
      return;
    }

    // 날짜별 매출 추가/삭제
    if (what === "ad-sales-add") {
      const date = $("#adSalesNewDate").value;
      if (!date) { alert("날짜 박아"); return; }
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const sales = [...(ad.sales || []), {
        date,
        memo: $("#adSalesNewMemo").value.trim(),
        qty: parseInt($("#adSalesNewQty").value) || 0,
        revenue: parseInt($("#adSalesNewRev").value) || 0,
        cost: parseInt($("#adSalesNewCost").value) || 0,
      }];
      sales.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      ["adSalesNewDate","adSalesNewMemo","adSalesNewQty","adSalesNewRev","adSalesNewCost"].forEach(id => { const e = $("#"+id); if (e) e.value = ""; });
      return patchAd({ sales });
    }
    if (what === "ad-sales-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeMarketId);
      const sales = (ad.sales || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ sales });
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
    // 정산 select 셀 편집 (즉시 저장)
    if (e.target.dataset.v2 === "stl-edit" && e.target.tagName === "SELECT") {
      const ri = parseInt(e.target.dataset.ri), k = e.target.dataset.k;
      const rows = JSON.parse(JSON.stringify(s.cachedCampaign.settlement?.rows || []));
      if (rows[ri]) { rows[ri][k] = e.target.value; patchSettlement({ rows }); }
    }
    // 열 토글
    if (e.target.dataset.v2 === "stl-col-toggle") {
      let vis = [...(s.settleVisible || STL_DEFAULT_VISIBLE)];
      const k = e.target.dataset.k;
      if (e.target.checked) { if (!vis.includes(k)) vis.push(k); }
      else vis = vis.filter(x => x !== k);
      patchSettlement({ settings: { visible_columns: vis } });
    }
    // 신규행 기본값
    if (e.target.dataset.v2 === "stl-default") {
      patchSettlement({ settings: { [e.target.dataset.k]: e.target.value } });
    }
  });

  // 캠페인 메타 인라인 편집
  async function patchCampaign(patch) {
    try {
      await api(`/api/campaigns_v2/${s.activeCamId}`, { method: "PATCH", body: JSON.stringify(patch) });
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
    } catch (err) { alert("실패: " + err.message); }
  }

  document.addEventListener("change", async (e) => {
    if (e.target.dataset.v2 === "cam-edit-status") patchCampaign({ status: e.target.value });
    if (e.target.dataset.v2 === "cam-ship") {
      const f = e.target.dataset.f;
      patchCampaign({ product_shipping: { [f]: e.target.value } });
    }
    // 세트: 마지막 제품 발송일 (발송란 흡수)
    if (e.target.dataset.v2 === "set-ship") {
      try {
        await api(`/api/campaigns_v2/${s.activeCamId}/sets/${e.target.dataset.id}`, {
          method: "PATCH", body: JSON.stringify({ last_ship_date: e.target.value }),
        });
        window.showToast?.({ icon: "📦", title: "발송일 저장됨", body: e.target.value || "비움" });
      } catch (err) { alert("실패: " + err.message); }
    }
    // 정산 완료 체크 → 대시보드 표시용 플래그
    if (e.target.dataset.v2 === "cam-settle-done") {
      patchCampaign({ settlement_done: e.target.checked });
    }
  });

  document.addEventListener("blur", async (e) => {
    // 정산 input 셀 (text/num/date) blur 저장
    if (e.target.dataset.v2 === "stl-edit" && e.target.tagName === "INPUT") {
      const ri = parseInt(e.target.dataset.ri), k = e.target.dataset.k;
      const rows = JSON.parse(JSON.stringify(s.cachedCampaign.settlement?.rows || []));
      if (rows[ri] && String(rows[ri][k] ?? "") !== e.target.value) {
        rows[ri][k] = e.target.value;
        patchSettlement({ rows });
      }
      return;
    }
    if (e.target.dataset.v2 === "cam-edit-traits") patchCampaign({ seller_traits: e.target.value });
    if (e.target.dataset.v2 === "cam-edit-notes") patchCampaign({ notes: e.target.value });
    if (e.target.dataset.v2 === "set-memo") {
      try {
        await api(`/api/campaigns_v2/${s.activeCamId}/sets/${e.target.dataset.id}`, {
          method: "PATCH", body: JSON.stringify({ memo: e.target.value }),
        });
      } catch {}
    }
    if (e.target.dataset.v2 === "cg-slot-edit") {
      const di = parseInt(e.target.dataset.di), si = parseInt(e.target.dataset.si);
      const f = e.target.dataset.f;
      await patchContentSlot(di, si, f, e.target.value);
    }
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

  // 세그먼트 토글 (전체 타입/메가/마이크로/벤더, 전체 상태/진행중/완료)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#camV2ListView .seg-btn");
    if (!btn) return;
    const grp = btn.closest(".seg");
    if (!grp) return;
    grp.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b === btn));
    const which = grp.dataset.seg;
    if (which === "type") s.typeFilter = btn.dataset.val;
    else if (which === "status") s.statusFilter = btn.dataset.val;
    renderAll();
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item[data-tab="campaigns"]');
    if (t) setTimeout(loadList, 80);
  });

  // 폼 submit 바인딩
  setTimeout(() => {
    const form = document.getElementById("campNewForm");
    if (form) form.addEventListener("submit", submitCampaignForm);
    const genForm = document.getElementById("contentGenForm");
    if (genForm) genForm.addEventListener("submit", submitGen);
    const setForm = document.getElementById("setAddForm");
    if (setForm) setForm.addEventListener("submit", submitSetForm);
  }, 200);

  setTimeout(loadList, 800);
})();
