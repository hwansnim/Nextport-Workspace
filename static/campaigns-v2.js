/*
 * 셀러 캠페인 v2 — 메타 광고관리자 스타일.
 * 캠페인 > 세트(차수) > 광고(공동구매) 드릴다운.
 * 광고 디테일 6섹션: 제품발송 / 스케줄링 / 이벤트 / 드라이브 / 배너 / 릴스
 */
(function () {
  if (!window.api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));

  const s = {
    campaigns: [],
    activeCamId: null,
    activeSetId: null,
    activeAdId: null,
    q: "",
    typeFilter: "",
    statusFilter: "",
  };

  // ─── LIST ───────────────────────────────────────────────
  async function loadList() {
    try {
      const r = await api("/api/campaigns_v2");
      s.campaigns = r.campaigns || [];
      renderList();
    } catch (e) { console.error(e); }
  }

  function filteredCampaigns() {
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

  function renderList() {
    const items = filteredCampaigns();
    $("#camV2Stat").textContent = `${items.length} / ${s.campaigns.length}`;
    const grid = $("#camV2Grid");
    if (!items.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:40px;text-align:center;color:#888">
        ${s.campaigns.length ? "필터에 해당하는 캠페인 없음" : "캠페인 없음 — [+ 캠페인 추가] 또는 [진행 예정 셀러]에서 📣 박기"}
      </div>`;
      return;
    }
    grid.innerHTML = items.map(c => {
      const setCount = (c.sets || []).length;
      const adCount = (c.sets || []).reduce((sum, st) => sum + (st.ads || []).length, 0);
      const typeBadge = `<span class="cam-type cam-type-${esc(c.type || "")}">${esc(c.type || "?")}</span>`;
      return `
      <div class="cam-card" data-v2="cam-open" data-id="${esc(c.id)}">
        <div class="cam-card-head">
          <div>
            <div class="cam-card-seller">${esc(c.seller_name || "셀러 미정")}</div>
            <div class="cam-card-brand">${esc(c.brand || "-")} · ${esc(c.product || "-")}</div>
          </div>
          ${typeBadge}
        </div>
        <div class="cam-card-meta">
          <span>${setCount}차 · 공구 ${adCount}건</span>
          <span class="cam-status s-${esc(c.status || "준비중")}">${esc(c.status || "준비중")}</span>
        </div>
        ${c.market_schedule ? `<div class="cam-card-mkt">🗓 ${esc(c.market_schedule)}</div>` : ""}
      </div>`;
    }).join("");
  }

  // ─── DETAIL (캠페인) ───────────────────────────────────
  async function openCampaign(camId) {
    try {
      const c = await api(`/api/campaigns_v2/${camId}`);
      s.activeCamId = camId;
      s.activeSetId = null;
      s.activeAdId = null;
      $("#camV2ListView").hidden = true;
      $("#camV2DetailView").hidden = false;
      $("#camAdDetailWrap").hidden = true;
      renderCamDetail(c);
    } catch (e) { alert("실패: " + e.message); }
  }

  function backToList() {
    s.activeCamId = null; s.activeSetId = null; s.activeAdId = null;
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
      ${c.linked_influencer_handle ? `<div class="cam-meta-row"><span class="lbl">연결된 인플루언서</span><span class="val">@${esc(c.linked_influencer_handle)}</span></div>` : ""}
    `;

    const setsRoot = $("#camSetsBody");
    if (!(c.sets || []).length) {
      setsRoot.innerHTML = `<div class="empty" style="padding:30px;text-align:center;color:#888">세트 없음. [+ 다음 차수 추가] 클릭</div>`;
    } else {
      setsRoot.innerHTML = c.sets.map(st => `
        <div class="cam-set ${st.id === s.activeSetId ? "active" : ""}" data-v2="set-open" data-id="${esc(st.id)}">
          <div class="cam-set-head">
            <span class="cam-set-round">${esc(st.label || st.round + "차")}</span>
            <span class="hint">${(st.ads || []).length}건 광고</span>
          </div>
          <div class="cam-set-ads">
            ${(st.ads || []).map(a => `
              <div class="cam-ad-chip ${a.id === s.activeAdId ? "active" : ""}" data-v2="ad-open" data-set="${esc(st.id)}" data-id="${esc(a.id)}">
                <span>${esc(a.name)}</span>
                <span class="cam-status s-${esc(a.status || "준비중")}">${esc(a.status || "준비중")}</span>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("");
    }

    // 활성 광고 있으면 디테일 표시
    if (s.activeAdId) {
      const set = c.sets.find(x => x.id === s.activeSetId);
      const ad = set?.ads.find(x => x.id === s.activeAdId);
      if (ad) renderAdDetail(set, ad);
    }
  }

  // ─── AD DETAIL ──────────────────────────────────────────
  function renderAdDetail(set, ad) {
    s.activeSetId = set.id;
    s.activeAdId = ad.id;
    $("#camAdDetailWrap").hidden = false;
    $("#camBcSetSep").hidden = false;
    $("#camBcSet").hidden = false;
    $("#camBcSet").textContent = `${set.label || set.round + "차"} · ${ad.name}`;

    // 상태
    $("#camAdStatusLabel").textContent = ad.status || "준비중";
    $("#camAdStatusSel").value = ad.status || "준비중";

    // 1. 제품 발송
    $("#adProductSentDate").value = ad.product_sent_date || "";

    // 2. 스케줄링
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

    // 3. 이벤트
    const events = ad.events || [];
    $("#adEventList").innerHTML = events.length
      ? events.map((ev, i) => `<div class="ad-list-row">
          <span class="ad-list-text">${esc(typeof ev === "string" ? ev : ev.text || "")}</span>
          <button class="btn-text" data-v2="ad-event-del" data-idx="${i}">×</button>
        </div>`).join("")
      : `<div class="hint">이벤트 없음</div>`;

    // 4. 드라이브
    const drives = ad.drive_links || [];
    $("#adDriveList").innerHTML = drives.length
      ? drives.map((d, i) => `<div class="ad-list-row">
          <span class="ad-list-tag">${esc(d.label || "자료")}</span>
          <a href="${esc(d.url)}" target="_blank" rel="noopener" class="ad-list-text" style="color:var(--blue)">${esc(d.url)}</a>
          <button class="btn-text" data-v2="ad-drive-del" data-idx="${i}">×</button>
        </div>`).join("")
      : `<div class="hint">드라이브 링크 없음</div>`;

    // 5. 배너
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

    // 6. 릴스
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
            <input type="url" placeholder="영상 URL (Drive / YouTube / 직접 업로드 후 링크)" data-v2="ad-reel-field" data-idx="${i}" data-field="video_url" value="${esc(r.video_url || "")}" />
            ${r.video_url ? `<a href="${esc(r.video_url)}" target="_blank" rel="noopener" class="btn-text">▶️ 영상 보기</a>` : ""}
          </div>`).join("")
      : `<div class="hint">릴스 없음. [+ 릴스 추가] 클릭</div>`;
  }

  // ─── ACTIONS ────────────────────────────────────────────
  async function patchAd(patch) {
    try {
      await api(`/api/campaigns_v2/${s.activeCamId}/sets/${s.activeSetId}/ads/${s.activeAdId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      // 화면 즉시 재로드
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
    } catch (e) { alert("실패: " + e.message); }
  }

  async function newCampaign() {
    const seller = prompt("셀러명:");
    if (!seller) return;
    const brand = prompt("브랜드 (선택):") || "";
    const product = prompt("제품 (선택):") || "";
    const type = prompt("타입 (메가/마이크로/벤더):", "마이크로") || "마이크로";
    const market = prompt("마켓 일정 (선택, 예: 2026-06-20):") || "";
    try {
      const r = await api("/api/campaigns_v2", {
        method: "POST",
        body: JSON.stringify({ seller_name: seller, brand, product, type, market_schedule: market }),
      });
      window.showToast?.({ icon: "📣", title: "캠페인 추가됨", body: `${seller} · ${brand}`, accent: true });
      await loadList();
      openCampaign(r.campaign.id);
    } catch (e) { alert("실패: " + e.message); }
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

  // ─── EVENT HANDLERS ─────────────────────────────────────
  document.addEventListener("click", async (e) => {
    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    if (what === "cam-open") return openCampaign(trg.dataset.id);
    if (what === "cam-back") return backToList();
    if (what === "cam-new") return newCampaign();
    if (what === "cam-add-set") return addSet();

    if (what === "set-open") {
      // 세트 클릭 = 해당 세트의 첫 광고 열기
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const set = c.sets.find(x => x.id === trg.dataset.id);
      if (set && set.ads && set.ads[0]) {
        s.activeSetId = set.id;
        s.activeAdId = set.ads[0].id;
        renderCamDetail(c);
      }
      return;
    }
    if (what === "ad-open") {
      s.activeSetId = trg.dataset.set;
      s.activeAdId = trg.dataset.id;
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      renderCamDetail(c);
      return;
    }

    if (what === "ad-save-product") {
      return patchAd({ product_sent_date: $("#adProductSentDate").value || null });
    }
    if (what === "ad-save-sched") {
      return patchAd({ scheduling: {
        start_date: $("#adSchedStart").value || null,
        end_date: $("#adSchedEnd").value || null,
      }});
    }
    if (what === "ad-sched-add") {
      const date = $("#adSchedNewDate").value;
      const label = $("#adSchedNewLabel").value.trim();
      if (!date || !label) { alert("날짜 + 라벨 박아"); return; }
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const items = ad.scheduling?.items || [];
      items.push({ date, label });
      $("#adSchedNewDate").value = "";
      $("#adSchedNewLabel").value = "";
      return patchAd({ scheduling: { ...(ad.scheduling || {}), items } });
    }
    if (what === "ad-sched-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const items = (ad.scheduling?.items || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ scheduling: { ...(ad.scheduling || {}), items } });
    }
    if (what === "ad-event-add") {
      const text = $("#adEventNew").value.trim();
      if (!text) return;
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const events = [...(ad.events || []), { text, ts: new Date().toISOString() }];
      $("#adEventNew").value = "";
      return patchAd({ events });
    }
    if (what === "ad-event-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const events = (ad.events || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ events });
    }
    if (what === "ad-drive-add") {
      const label = $("#adDriveNewLabel").value.trim();
      const url = $("#adDriveNewUrl").value.trim();
      if (!url) { alert("URL 박아"); return; }
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const drive_links = [...(ad.drive_links || []), { label: label || "자료", url }];
      $("#adDriveNewLabel").value = "";
      $("#adDriveNewUrl").value = "";
      return patchAd({ drive_links });
    }
    if (what === "ad-drive-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const drive_links = (ad.drive_links || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ drive_links });
    }
    if (what === "ad-reel-add") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const reels = [...(ad.reels || []), { plan: "", video_url: "", status: "기획중" }];
      return patchAd({ reels });
    }
    if (what === "ad-reel-del") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const reels = (ad.reels || []).filter((_, i) => i !== parseInt(trg.dataset.idx));
      return patchAd({ reels });
    }
  });

  // 배너 toggle / 필드 / 릴스 필드 변경 → blur 시 save
  document.addEventListener("change", async (e) => {
    if (e.target.dataset.v2 === "ad-banner-toggle") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const banners = { ...(ad.banners || {}) };
      banners[e.target.dataset.key] = { ...(banners[e.target.dataset.key] || {}), checked: e.target.checked };
      patchAd({ banners });
    }
    if (e.target.id === "camAdStatusSel") {
      patchAd({ status: e.target.value });
    }
  });

  document.addEventListener("blur", async (e) => {
    if (e.target.dataset.v2 === "ad-banner-field") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const banners = { ...(ad.banners || {}) };
      const key = e.target.dataset.key;
      banners[key] = { ...(banners[key] || {}), [e.target.dataset.field]: e.target.value };
      patchAd({ banners });
    }
    if (e.target.dataset.v2 === "ad-reel-field") {
      const c = await api(`/api/campaigns_v2/${s.activeCamId}`);
      const ad = c.sets.find(x => x.id === s.activeSetId)?.ads.find(x => x.id === s.activeAdId);
      const reels = [...(ad.reels || [])];
      const idx = parseInt(e.target.dataset.idx);
      reels[idx] = { ...(reels[idx] || {}), [e.target.dataset.field]: e.target.value };
      patchAd({ reels });
    }
  }, true);

  // 검색 / 필터
  let searchTimer;
  document.addEventListener("input", (e) => {
    if (e.target.id === "camV2Search") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { s.q = e.target.value; renderList(); }, 200);
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "camV2TypeFilter") { s.typeFilter = e.target.value; renderList(); }
    if (e.target.id === "camV2StatusFilter") { s.statusFilter = e.target.value; renderList(); }
  });

  // 탭 진입
  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item[data-tab="campaigns"]');
    if (t) setTimeout(loadList, 80);
  });

  setTimeout(loadList, 800);
})();
