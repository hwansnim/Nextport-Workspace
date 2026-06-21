// 하루픽스 공동구매 컨텐츠 툴 - 클라이언트
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  sellers: [],
  stats: {},      // seller_id -> stats
  jobs: {},       // seller_id -> job
  products: [],
  refSelected: new Set(),
  // 신규
  calMonth: null,        // { year, month } — month: 0~11
  calEvents: [],
  today: null,
  campaigns: [],
  meetings: [],
  currentMeetingId: null,
  brands: [],
  activeBrandId: "",  // "" = 전체, "harufix", "ivenoff" 등
};

// 셀러별 고유 컬러 팔레트 (부드러운 톤, 흰 텍스트 잘 보임)
const SELLER_PALETTE = [
  "#c9a368",  // 골드
  "#7a9bbe",  // 더스티 블루
  "#b8826c",  // 테라코타
  "#8fa86e",  // 세이지 그린
  "#a87a9b",  // 라벤더
  "#c4a87a",  // 베이지 골드
  "#6b8e9e",  // 슬레이트 블루
  "#a89270",  // 머스타드 브라운
  "#8aa68a",  // 모스
  "#8a8aa6",  // 그레이 퍼플
  "#b88a7a",  // 더스티 로즈
  "#7ea890",  // 민트 세이지
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function sellerColor(sellerName) {
  if (!sellerName) return "#c9a368";
  return SELLER_PALETTE[hashStr(sellerName) % SELLER_PALETTE.length];
}

function campaignBrandId(c) {
  return c.brand_id || "";
}

function filterByBrand(items, getBrandId) {
  if (!state.activeBrandId) return items;
  return items.filter(it => getBrandId(it) === state.activeBrandId);
}

const STAGE_LABEL = {
  contact: "컨택", confirmed: "셀러 컨펌", shipped: "제품 발송", received: "수령 확인",
  sheet_drafted: "시트 작성", sheet_confirmed: "시트 컨펌", live: "라이브", complete: "완료"
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatNumber(n) {
  if (n == null) return "—";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "만";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}
function formatBytes(n) {
  if (!n) return "0 B";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}
function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  } catch { return iso; }
}

// ─── TAB SWITCHING ───
function switchTab(name) {
  $$(".side-item").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "schedule") renderRefSellers();
  if (name === "products") loadProducts();
  if (name === "settings") loadSettings();
  if (name === "home") { loadCalendar(); loadToday(); }
  if (name === "campaigns") loadCampaigns();
  if (name === "meetings") loadMeetings();
  if (name === "dashboard") loadDashboard();
}

document.addEventListener("click", (e) => {
  const item = e.target.closest(".side-item");
  if (item) switchTab(item.dataset.tab);
});

// ─── STATUS PILLS ───
function pillSet(id, ok, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("bad", !ok);
}
async function refreshConfigStatus() {
  try {
    const cfg = await api("/api/config");
    pillSet("pillGemini", cfg.gemini_set, cfg.gemini_set ? "Gemini ✓" : "Gemini 키 없음");
  } catch {}
  refreshBackupStatus();
}

async function refreshBackupStatus() {
  const panel = $("#backupStatusPanel");
  if (!panel) return;
  try {
    const s = await api("/api/backup_status");
    if (!s.connected) {
      panel.innerHTML = `<div class="b-title bad">💾 백업 폴더 없음</div>
        <div class="b-path">스크립트 한 번 실행 필요</div>`;
      return;
    }
    const cloud = s.is_gdrive ? "☁️ Google Drive" : "📁 로컬";
    const t = s.last_backup ? formatDate(s.last_backup) : "—";
    panel.innerHTML = `
      <div class="b-title">${cloud} 백업 활성</div>
      <div class="b-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</div>
      <div>마지막 백업: <span class="b-time">${escapeHtml(t)}</span></div>
      <div>파일 ${s.file_count}개 · 히스토리 ${s.history_count}개</div>
      <div style="display:flex;gap:4px;margin-top:4px">
        <button class="btn-text" data-action="open-backup" style="font-size:10px;padding:3px 6px">📁 폴더</button>
        <button class="btn-text" data-action="run-backup" style="font-size:10px;padding:3px 6px">↻ 지금 백업</button>
      </div>
    `;
  } catch (e) {
    panel.innerHTML = `<div class="b-title bad">💾 백업 상태 확인 실패</div>`;
  }
}

// ─── HOLIDAYS CACHE ───
let HOLIDAYS = {};
async function loadHolidays() {
  try {
    const { holidays } = await api("/api/holidays");
    HOLIDAYS = holidays || {};
  } catch { HOLIDAYS = {}; }
}

// ─── BRANDS ───
async function loadBrands() {
  try {
    const { brands } = await api("/api/brands");
    state.brands = brands || [];
    renderBrandSwitcher();
    populateCampaignBrandSelect();
  } catch { state.brands = []; }
}

function renderBrandSwitcher() {
  const root = $("#brandList");
  if (!root) return;
  const totalCount = state.brands.reduce((s, b) => s + (b.campaign_count || 0), 0);
  const items = [{ id: "", emoji: "📊", name: "전체", campaign_count: totalCount }, ...state.brands];
  root.innerHTML = items.map(b => {
    const active = state.activeBrandId === b.id ? "active" : "";
    return `<button class="bs-item ${active}" data-brand-id="${escapeHtml(b.id)}" title="${escapeHtml(b.name)}">
      <span class="bs-emoji">${b.emoji || "🏷️"}</span>
      <span class="bs-name">${escapeHtml(b.name)}</span>
      <span class="bs-count">${b.campaign_count || 0}</span>
    </button>`;
  }).join("");
}

function populateCampaignBrandSelect() {
  const sel = $("#campBrandSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">(선택)</option>' +
    state.brands.map(b => `<option value="${escapeHtml(b.id)}">${b.emoji || ""} ${escapeHtml(b.name)}</option>`).join("");
  if (prev) sel.value = prev;
}

async function switchBrand(brandId) {
  state.activeBrandId = brandId;
  renderBrandSwitcher();
  // 모든 뷰 새로고침
  if ($("#tab-home").classList.contains("active")) { renderCalendar(); loadToday(); }
  if ($("#tab-campaigns").classList.contains("active")) renderCampaigns();
  if ($("#tab-dashboard").classList.contains("active")) loadDashboard();
  if ($("#tab-meetings").classList.contains("active")) renderMeetings();
}

document.addEventListener("click", (e) => {
  const bs = e.target.closest(".bs-item[data-brand-id]");
  if (bs) {
    switchBrand(bs.dataset.brandId);
  }
});

// ─── ARCHIVE: SELLER TABLE ───
function renderSellerRow(seller) {
  const stats = state.stats[seller.id] || { profile: {}, stats: { total_items: 0 } };
  const profile = stats.profile || {};
  const itemCount = stats.stats?.total_items || 0;
  const followers = profile.stats?.followers;
  const posts = profile.stats?.posts;
  const lastUpdated = profile.last_scraped_at;
  const job = state.jobs[seller.id];
  const inProgress = job && (job.status === "running" || job.status === "queued");

  return `
    <tr data-id="${seller.id}">
      <td class="col-id">${escapeHtml(seller.id)}</td>
      <td class="col-name">${escapeHtml(seller.name)}<br><span style="font-weight:400;color:#888;font-size:11px">${escapeHtml(seller.display_name || "")}</span></td>
      <td class="col-handle">
        <a href="https://www.instagram.com/${encodeURIComponent(seller.instagram)}/" target="_blank" rel="noopener">@${escapeHtml(seller.instagram)} ↗</a>
      </td>
      <td class="col-followers">${formatNumber(followers)}</td>
      <td class="col-posts">${formatNumber(posts)}</td>
      <td class="col-items">${itemCount > 0 ? `<b>${itemCount}</b>` : "—"}</td>
      <td class="col-last">${lastUpdated ? formatDate(lastUpdated) : "<i>미수집</i>"}</td>
      <td class="col-notes"><div class="col-notes-text">${escapeHtml(seller.notes || "")}</div></td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="btn-update btn-icon" data-action="update" data-id="${seller.id}" ${inProgress ? "disabled" : ""} title="업데이트">${inProgress ? "⏳" : "↻"}</button>
          <button class="btn-secondary" data-action="detail" data-id="${seller.id}">상세</button>
          <button class="btn-secondary" data-action="open-folder" data-id="${seller.id}" title="폴더 열기">📁</button>
          <button class="btn-text" data-action="edit" data-id="${seller.id}" title="수정">✎</button>
        </div>
        ${inProgress ? `
          <div class="progress-cell">
            <div class="progress-text">${escapeHtml(job.message || "")}</div>
            <div class="progress-bar"><span style="width:${job.total > 0 ? Math.round(job.progress / job.total * 100) : 0}%"></span></div>
          </div>` : ""}
      </td>
    </tr>
  `;
}

function renderTable() {
  const body = $("#sellerTableBody");
  if (!state.sellers.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">셀러가 없습니다. [+ 셀러 추가] 버튼을 누르세요.</td></tr>`;
    return;
  }
  body.innerHTML = state.sellers.map(renderSellerRow).join("");
}

async function loadSellers() {
  try {
    const { sellers } = await api("/api/sellers");
    state.sellers = sellers;
    await Promise.all(sellers.map(async (s) => {
      try { state.stats[s.id] = await api(`/api/sellers/${s.id}/stats`); }
      catch { state.stats[s.id] = { profile: {}, stats: { total_items: 0 } }; }
    }));
    renderTable();
    renderRefSellers(); // refresh schedule page selectors too
  } catch (e) {
    $("#sellerTableBody").innerHTML = `<tr><td colspan="9" class="empty">에러: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function startUpdate(sellerId) {
  try {
    const { job_id } = await api(`/api/sellers/${sellerId}/update`, { method: "POST" });
    state.jobs[sellerId] = { job_id, status: "queued", message: "큐 등록…", progress: 0, total: 0 };
    renderTable();
    pollJob(sellerId, job_id);
  } catch (e) { appendLog(`[${sellerId}] 시작 실패: ${e.message}`); }
}
async function pollJob(sellerId, jobId) {
  while (true) {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      state.jobs[sellerId] = job;
      renderTable();
      if (job.status === "done" || job.status === "error") {
        appendLog(`[${sellerId}] ${job.status}: ${job.message}`);
        try { state.stats[sellerId] = await api(`/api/sellers/${sellerId}/stats`); } catch {}
        delete state.jobs[sellerId];
        renderTable();
        return;
      }
    } catch { return; }
    await new Promise(r => setTimeout(r, 1500));
  }
}
function appendLog(line) {
  const panel = $("#logPanel");
  const box = $("#logBox");
  panel.hidden = false;
  const time = new Date().toLocaleTimeString();
  box.textContent += `[${time}] ${line}\n`;
  box.scrollTop = box.scrollHeight;
}

// ─── SELLER DETAIL DIALOG ───
async function showDetail(sellerId) {
  const seller = state.sellers.find(s => s.id === sellerId);
  if (!seller) return;
  let stats;
  try { stats = await api(`/api/sellers/${sellerId}/stats`); }
  catch (e) { alert("불러오기 실패: " + e.message); return; }

  const profile = stats.profile || {};
  const total = stats.stats?.total_items || 0;
  const byHl = stats.stats?.by_highlight || {};
  const size = stats.stats?.total_size_bytes || 0;
  const path = stats.local_path || "";

  $("#detailTitle").textContent = `${seller.name} (@${seller.instagram})`;
  $("#detailBody").innerHTML = `
    <div class="detail-grid">
      <div class="detail-stat"><div class="stat-label">팔로워</div><div class="stat-value">${formatNumber(profile.stats?.followers)}</div></div>
      <div class="detail-stat"><div class="stat-label">게시물</div><div class="stat-value">${formatNumber(profile.stats?.posts)}</div></div>
      <div class="detail-stat"><div class="stat-label">팔로잉</div><div class="stat-value">${formatNumber(profile.stats?.following)}</div></div>
      <div class="detail-stat"><div class="stat-label">아카이브 항목</div><div class="stat-value">${total}</div></div>
      <div class="detail-stat"><div class="stat-label">총 용량</div><div class="stat-value">${formatBytes(size)}</div></div>
      <div class="detail-stat"><div class="stat-label">마지막 업데이트</div><div class="stat-value" style="font-size:13px">${profile.last_scraped_at ? formatDate(profile.last_scraped_at) : "—"}</div></div>
    </div>
    <div class="detail-section">
      <h4>바이오</h4>
      <div style="font-size:13px;white-space:pre-wrap;color:#444">${escapeHtml(profile.header_text || "(미수집)")}</div>
    </div>
    <div class="detail-section">
      <h4>하이라이트별 수집 현황</h4>
      <ul class="highlight-list">
        ${Object.keys(byHl).length === 0 ? '<li style="color:#888"><i>아직 없음</i></li>' :
          Object.entries(byHl).map(([k, v]) => `<li><span>${escapeHtml(k)}</span><span class="count">${v}장</span></li>`).join("")}
      </ul>
    </div>
    <div class="detail-section">
      <h4>저장 위치 (PC 로컬)</h4>
      <div class="path-row">${escapeHtml(path)}</div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn-secondary" data-action="open-folder" data-id="${sellerId}">📁 탐색기로 열기</button>
        <button class="btn-text" data-action="copy-path" data-path="${escapeHtml(path)}">경로 복사</button>
      </div>
    </div>
  `;
  $("#detailDialog").showModal();
}

function showEdit(sellerId) {
  const seller = state.sellers.find(s => s.id === sellerId);
  if (!seller) return;
  const f = $("#editSellerForm");
  f.elements.id.value = seller.id;
  f.elements.name.value = seller.name || "";
  f.elements.instagram.value = seller.instagram || "";
  f.elements.display_name.value = seller.display_name || "";
  f.elements.notes.value = seller.notes || "";
  $("#editSellerDialog").showModal();
}

// ─── SCHEDULE PAGE ───
function renderRefSellers() {
  const root = $("#schRefSellers");
  if (!root) return;
  if (!state.sellers.length) {
    root.innerHTML = '<div class="empty">셀러가 없습니다. 셀러 아카이브 탭에서 추가하세요.</div>';
    return;
  }
  root.innerHTML = state.sellers.map(s => {
    const stats = state.stats[s.id] || {};
    const cnt = stats.stats?.total_items || 0;
    const checked = state.refSelected.has(s.id);
    return `
      <label class="ref-card ${checked ? "checked" : ""} ${cnt === 0 ? "disabled" : ""}" data-ref-id="${s.id}">
        <input type="checkbox" ${checked ? "checked" : ""} ${cnt === 0 ? "disabled" : ""} />
        <div class="ref-meta">
          <div class="ref-name">${escapeHtml(s.name)}</div>
          <div class="ref-handle">@${escapeHtml(s.instagram)}</div>
          <div class="ref-count">${cnt > 0 ? `${cnt}개 보유` : "<i>미수집</i>"}</div>
        </div>
      </label>
    `;
  }).join("");
}

document.addEventListener("change", (e) => {
  const card = e.target.closest(".ref-card");
  if (card && e.target.matches('input[type="checkbox"]')) {
    const id = card.dataset.refId;
    if (e.target.checked) state.refSelected.add(id);
    else state.refSelected.delete(id);
    card.classList.toggle("checked", e.target.checked);
  }
});

async function generateSheet() {
  const btn = $("#btnGenerateSheet");
  const status = $("#schStatus");
  const progressBox = $("#schProgressBox");
  const link = $("#schResultLink");
  link.hidden = true;
  progressBox.hidden = false;
  progressBox.textContent = "";

  const payload = {
    target: {
      name: $("#sch_target_name").value.trim(),
      instagram: $("#sch_target_handle").value.trim().replace(/^@/, ""),
    },
    product: {
      name: $("#sch_product_name").value.trim(),
      usp: $("#sch_usp").value.trim(),
      detail: $("#sch_product_detail").value.trim(),
      price: $("#sch_price").value.trim(),
      avoid: $("#sch_avoid").value.trim(),
    },
    schedule: {
      round: parseInt($("#sch_round").value) || 1,
      start: $("#sch_start").value,
      end: $("#sch_end").value,
    },
    reference_sellers: Array.from(state.refSelected),
  };

  if (!payload.target.name || !payload.target.instagram) {
    alert("대상 셀러 이름 / 핸들 입력 필요");
    return;
  }
  if (!payload.product.name) {
    alert("제품명 입력 필요");
    return;
  }

  btn.disabled = true;
  btn.textContent = "생성 중…";
  status.textContent = "준비…";

  try {
    const { job_id } = await api("/api/schedule/generate", { method: "POST", body: JSON.stringify(payload) });
    while (true) {
      const job = await api(`/api/jobs/${job_id}`);
      const pct = job.total > 0 ? (job.progress / job.total) * 100 : 0;
      renderProgressBox(progressBox, {
        title: "📊 스케줄링 시트 생성",
        sub: job.message,
        pct,
      });
      status.textContent = job.message || "";
      if (job.status === "done") {
        renderProgressBox(progressBox, { title: "✅ 시트 생성 완료!", sub: job.message, pct: 100, state: "done" });
        if (job.result_url) {
          link.href = job.result_url;
          link.textContent = "✅ 시트 열기 ↗";
          link.hidden = false;
        }
        break;
      }
      if (job.status === "error") {
        renderProgressBox(progressBox, { title: "❌ 시트 생성 실패", sub: job.message, pct: 100, state: "error" });
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) {
    renderProgressBox(progressBox, { title: "❌ 에러", sub: e.message, pct: 100, state: "error" });
  } finally {
    btn.disabled = false;
    btn.textContent = "📊 스케줄링 시트 생성";
  }
}

// ─── PRODUCTS ───
async function loadProducts() {
  try {
    const { products } = await api("/api/products");
    state.products = products;
    renderProducts();
  } catch (e) {
    $("#productList").innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}
function renderProducts() {
  const root = $("#productList");
  if (!state.products.length) {
    root.innerHTML = '<div class="empty">저장된 제품 없음. [+ 제품 추가] 누르세요.</div>';
    return;
  }
  root.innerHTML = state.products.map(p => `
    <div class="product-card" data-action="edit-product" data-id="${escapeHtml(p.id)}">
      <div class="product-name">${escapeHtml(p.name)}</div>
      <div class="product-usp">${escapeHtml(p.usp || p.detail || "")}</div>
    </div>
  `).join("");
}

function showProductDialog(product) {
  const f = $("#productForm");
  f.elements.id.value = product?.id || "";
  f.elements.name.value = product?.name || "";
  f.elements.usp.value = product?.usp || "";
  f.elements.detail.value = product?.detail || "";
  f.elements.price.value = product?.price || "";
  f.elements.avoid.value = product?.avoid || "";
  $("#productDialogTitle").textContent = product ? "제품 수정" : "제품 추가";
  $("#productDialog").showModal();
}

async function loadProductIntoSchedule() {
  if (!state.products.length) {
    await loadProducts();
  }
  if (!state.products.length) {
    alert("저장된 제품이 없습니다. '제품 정보' 탭에서 먼저 추가하세요.");
    return;
  }
  // 첫 번째 제품 자동 채우기 (단순 v1) — 추후 선택 다이얼로그
  const p = state.products[0];
  $("#sch_product_name").value = p.name || "";
  $("#sch_usp").value = p.usp || "";
  $("#sch_product_detail").value = p.detail || "";
  $("#sch_price").value = p.price || "";
  $("#sch_avoid").value = p.avoid || "";
}

// ─── SETTINGS ───
async function loadSettings() {
  try {
    const cfg = await api("/api/config");
    $("#settingsStatus").innerHTML = `
      <div>설정 파일: <b>${cfg.config_exists ? "✓ 있음" : "✗ 없음"}</b></div>
      <div>Drive 인증: <b>${cfg.drive_credentials_present ? "✓ 연결됨" : "✗ 미연결 (PC 로컬에 저장됨)"}</b></div>
      <div>Gemini API: <b>${cfg.gemini_set ? "✓ 키 설정됨" : "✗ 키 없음"}</b></div>
    `;
  } catch (e) { $("#settingsStatus").textContent = `에러: ${e.message}`; }
}

// ─── EVENT DELEGATION ───
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === "update") startUpdate(id);
  else if (action === "detail") showDetail(id);
  else if (action === "edit") showEdit(id);
  else if (action === "open-folder") {
    try {
      const r = await api(`/api/sellers/${id}/open`, { method: "POST" });
      appendLog(`[${id}] 폴더 열림: ${r.path}`);
    } catch (e) { alert("폴더 열기 실패: " + e.message); }
  } else if (action === "copy-path") {
    navigator.clipboard.writeText(btn.dataset.path);
    btn.textContent = "복사됨 ✓";
    setTimeout(() => btn.textContent = "경로 복사", 1500);
  } else if (action === "cancel-add") forceCloseDialog("addSellerDialog");
  else if (action === "cancel-edit") forceCloseDialog("editSellerDialog");
  else if (action === "close-detail") forceCloseDialog("detailDialog");
  else if (action === "delete-seller") {
    const sid = $("#editSellerForm").elements.id.value;
    if (!confirm("정말 삭제할까요? (저장된 파일은 그대로 두고 명단에서만 제거)")) return;
    try { await api(`/api/sellers/${sid}`, { method: "DELETE" }); forceCloseDialog("editSellerDialog"); await loadSellers(); }
    catch (e) { alert("삭제 실패: " + e.message); }
  } else if (action === "edit-product") {
    const p = state.products.find(x => x.id === id);
    showProductDialog(p);
  } else if (action === "cancel-product") forceCloseDialog("productDialog");
  else if (action === "delete-product") {
    const pid = $("#productForm").elements.id.value;
    if (!pid) { forceCloseDialog("productDialog"); return; }
    if (!confirm("정말 삭제할까요?")) return;
    try { await api(`/api/products/${pid}`, { method: "DELETE" }); forceCloseDialog("productDialog"); await loadProducts(); }
    catch (e) { alert("삭제 실패: " + e.message); }
  }
});

// ─── FORMS ───
$("#btnAddSeller").addEventListener("click", () => $("#addSellerDialog").showModal());
$("#btnRefresh").addEventListener("click", () => loadSellers());
$("#btnCloseLog").addEventListener("click", () => { $("#logPanel").hidden = true; });
$("#btnGenerateSheet")?.addEventListener("click", generateSheet);
$("#btnLoadProduct")?.addEventListener("click", loadProductIntoSchedule);
$("#btnAddProduct")?.addEventListener("click", () => showProductDialog());

$("#addSellerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  try {
    await api("/api/sellers", { method: "POST", body: JSON.stringify(payload) });
    forceCloseDialog("addSellerDialog");
    e.target.reset();
    await loadSellers();
  } catch (err) { alert("추가 실패: " + err.message); }
});

$("#editSellerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const id = payload.id; delete payload.id;
  try {
    await api(`/api/sellers/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    forceCloseDialog("editSellerDialog");
    await loadSellers();
  } catch (err) { alert("수정 실패: " + err.message); }
});

$("#productForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const id = payload.id; delete payload.id;
  try {
    if (id) await api(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    else await api("/api/products", { method: "POST", body: JSON.stringify(payload) });
    forceCloseDialog("productDialog");
    await loadProducts();
  } catch (err) { alert("저장 실패: " + err.message); }
});

// ─── IG LOGIN ───
$("#btnIgLogin").addEventListener("click", async () => {
  const btn = $("#btnIgLogin");
  btn.disabled = true;
  btn.textContent = "Chrome 창 띄우는 중…";
  try {
    const { job_id } = await api("/api/instagram/login", { method: "POST" });
    appendLog("[IG 로그인] Chrome 창이 열립니다. 인스타그램에 로그인해주세요.");
    while (true) {
      const job = await api(`/api/jobs/${job_id}`);
      btn.textContent = job.message.length > 25 ? job.message.slice(0, 25) + "…" : job.message;
      if (job.status === "done") {
        btn.textContent = "✅ 로그인 완료";
        setTimeout(() => { btn.disabled = false; btn.textContent = "📷 인스타 로그인"; }, 3000);
        return;
      }
      if (job.status === "error") {
        btn.disabled = false;
        btn.textContent = "📷 인스타 로그인";
        return;
      }
      await new Promise(r => setTimeout(r, 2500));
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "📷 인스타 로그인";
    alert("에러: " + e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════════
function ymdLocal(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function loadCalendar() {
  if (!state.calMonth) {
    const now = new Date();
    state.calMonth = { year: now.getFullYear(), month: now.getMonth() };
  }
  try {
    const { events } = await api("/api/calendar");
    state.calEvents = events || [];
  } catch (e) {
    state.calEvents = [];
  }
  renderCalendar();
}

function parseYmd(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function renderCalendar() {
  const root = $("#calendar");
  if (!root) return;
  const { year, month } = state.calMonth;
  const titleEl = $("#calTitle");
  if (titleEl) titleEl.textContent = `${year}년 ${month + 1}월`;

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startDow = first.getDay(); // 0=일 (목업: 일요일 시작)
  const daysInMonth = last.getDate();
  const prevLast = new Date(year, month, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  const totalWeeks = totalCells / 7;
  const todayStr = ymdLocal(new Date());

  // 셀 날짜 미리 계산 (인덱스 0..totalCells-1)
  const cellInfo = []; // {dateStr, off, isToday, holiday, dowMon, day}
  for (let i = 0; i < totalCells; i++) {
    const dayOffset = i - startDow;
    let cellY, cellM, cellD, off = false;
    if (dayOffset < 0) {
      cellD = prevLast + dayOffset + 1;
      cellM = month - 1; cellY = year;
      if (cellM < 0) { cellM = 11; cellY--; }
      off = true;
    } else if (dayOffset >= daysInMonth) {
      cellD = dayOffset - daysInMonth + 1;
      cellM = month + 1; cellY = year;
      if (cellM > 11) { cellM = 0; cellY++; }
      off = true;
    } else {
      cellD = dayOffset + 1; cellM = month; cellY = year;
    }
    const dateStr = `${cellY}-${String(cellM+1).padStart(2,"0")}-${String(cellD).padStart(2,"0")}`;
    cellInfo.push({
      dateStr,
      day: cellD,
      off,
      dow: i % 7, // 0=일 … 6=토
      isToday: dateStr === todayStr,
      holiday: HOLIDAYS[dateStr] || "",
    });
  }

  // 캠페인 필터 + 정렬
  let campaigns = (state.campaigns || []).filter(c => c.live_start && c.live_end);
  campaigns = filterByBrand(campaigns, campaignBrandId);
  campaigns.sort((a, b) => (a.live_start || "").localeCompare(b.live_start || ""));

  // 점 이벤트 grouping (Apple 목업: 작은 점만)
  //  - calEvents (미팅/발송/마감 등) + 캠페인 라이브 기간 = 날짜별 라이브 점
  const dotByDate = {};
  const pushDot = (date, obj) => { (dotByDate[date] = dotByDate[date] || []).push(obj); };
  for (const ev of state.calEvents || []) {
    if (!ev.date) continue;
    if (ev.kind === "live_start" || ev.kind === "live_end") continue;
    pushDot(ev.date, { type: "event", ev, kind: ev.kind || "other", title: ev.title });
  }
  for (const c of campaigns) {
    const cs = parseYmd(c.live_start), ce = parseYmd(c.live_end);
    if (!cs || !ce) continue;
    const label = `[${c.brand || ""}] ${c.seller_name} ${c.round}차 공구`;
    for (let t = +cs; t <= +ce; t += 86400000) {
      pushDot(ymdLocal(new Date(t)), { type: "camp", camp: c, kind: "live", title: `${label} (${c.live_start}~${c.live_end})` });
    }
  }

  // 헤더 (일요일 시작)
  const dows = ["일", "월", "화", "수", "목", "금", "토"];
  let html = '<div class="cal-grid-head">';
  for (let i = 0; i < 7; i++) {
    const cls = i === 0 ? "sun" : i === 6 ? "sat" : "";
    html += `<div class="cal-dow ${cls}">${dows[i]}</div>`;
  }
  html += "</div>";

  // 월 전체 단일 그리드 — 일정은 글자(이벤트 이름) 칩으로 표시
  const MAX_CHIPS = 3;
  html += '<div class="cal-grid">';
  for (const ci of cellInfo) {
    const dowCls = ci.dow === 0 ? "sun" : ci.dow === 6 ? "sat" : "";
    const holidayCls = ci.holiday ? (ci.off ? "holiday-soft" : "holiday") : "";
    const classes = [
      "cal-cell",
      ci.off ? "off" : "",
      ci.isToday ? "today" : "",
      dowCls,
      holidayCls,
    ].filter(Boolean).join(" ");
    const evList = dotByDate[ci.dateStr] || [];
    const chips = evList.slice(0, MAX_CHIPS).map(d => {
      if (d.type === "event") {
        const ev = d.ev;
        return `<span class="cal-ev k-${d.kind}" data-event-id="${escapeHtml(ev.id)}" data-ref-kind="${escapeHtml(ev.ref_kind || "")}" data-ref-id="${escapeHtml(ev.ref_id || "")}" data-auto="${ev.auto ? "1" : "0"}" title="${escapeHtml(d.title)}"><i class="cal-ev-dot"></i><span class="cal-ev-txt">${escapeHtml(ev.title || "일정")}</span></span>`;
      }
      const c = d.camp;
      const txt = `${c.seller_name || ""} ${c.round ? c.round + "차" : ""} 라이브`.trim();
      return `<span class="cal-ev k-live" data-campaign-id="${escapeHtml(c.id)}" title="${escapeHtml(d.title)}"><i class="cal-ev-dot"></i><span class="cal-ev-txt">${escapeHtml(txt)}</span></span>`;
    }).join("");
    const more = evList.length > MAX_CHIPS ? `<span class="cal-ev-more">+${evList.length - MAX_CHIPS}</span>` : "";
    html += `
      <div class="${classes}" data-date="${ci.dateStr}">
        <span class="cal-day">${ci.day}</span>
        ${ci.holiday ? `<span class="cal-holiday-label">${escapeHtml(ci.holiday)}</span>` : ""}
        <div class="cal-evs">${chips}${more}</div>
      </div>`;
  }
  html += "</div>";

  root.innerHTML = html;
}

function calNav(action) {
  if (!state.calMonth) state.calMonth = { year: new Date().getFullYear(), month: new Date().getMonth() };
  if (action === "prev") {
    state.calMonth.month--;
    if (state.calMonth.month < 0) { state.calMonth.month = 11; state.calMonth.year--; }
  } else if (action === "next") {
    state.calMonth.month++;
    if (state.calMonth.month > 11) { state.calMonth.month = 0; state.calMonth.year++; }
  } else if (action === "today") {
    const now = new Date();
    state.calMonth = { year: now.getFullYear(), month: now.getMonth() };
  }
  renderCalendar();
}

// ═══════════════════════════════════════════════════════════
// TODAY WIDGET
// ═══════════════════════════════════════════════════════════
async function loadToday() {
  try {
    const data = await api("/api/today");
    state.today = data;
    renderToday();
  } catch (e) {
    console.error("today load failed", e);
  }
}

function renderToday() {
  const t = state.today || {};
  fillTodayList("#todayUrgent", t.urgent || [], "urgent", true);
  fillTodayList("#todayOverdue", t.overdue || [], "overdue", true);
  fillTodayList("#todayWeek", t.this_week || [], "", true);
  fillTodayList("#todayUndated", t.undated || [], "", false);
}

function fillTodayList(sel, items, extraCls, showDays) {
  const root = $(sel);
  if (!root) return;
  if (!items.length) { root.innerHTML = '<div class="empty">없음</div>'; return; }
  root.innerHTML = items.map(it => {
    const days = it.days;
    let dLabel = "";
    if (showDays && days != null) {
      if (days < 0) dLabel = `<span class="dminus">${Math.abs(days)}일 지남</span>`;
      else if (days === 0) dLabel = `<span class="dminus">오늘</span>`;
      else dLabel = `<span class="dminus">D-${days}</span>`;
    }
    return `
      <div class="today-item ${extraCls}" data-action="open-campaign" data-id="${escapeHtml(it.campaign_id)}">
        <div class="ti-title">${escapeHtml(it.title)}</div>
        <div class="ti-meta">
          <span>${escapeHtml(it.stage || "")} · ${escapeHtml(it.status || "")}</span>
          ${dLabel}
        </div>
      </div>
    `;
  }).join("");
}

// ═══════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════
async function loadCampaigns() {
  try {
    const { campaigns } = await api("/api/campaigns");
    state.campaigns = campaigns || [];
    renderCampaigns();
    populateCampaignSelectInMeetingDialog();
  } catch (e) {
    $("#campaignTableBody").innerHTML = `<tr><td colspan="10" class="empty">에러: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderCampaigns() {
  const body = $("#campaignTableBody");
  if (!body) return;
  const filter = $("#campFilter")?.value || "";
  let list = filterByBrand(state.campaigns, campaignBrandId);
  list = list.filter(c => !filter || c.status === filter);
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="10" class="empty">캠페인이 없습니다. [+ 캠페인 추가] 누르세요.</td></tr>`;
    return;
  }
  body.innerHTML = list.map(c => {
    const stageCls = `s-${c.stage || "contact"}`;
    const stageLabel = STAGE_LABEL[c.stage] || c.stage || "—";
    const ctChip = c.contact_type === "inbound"
      ? `<span class="contact-chip inbound">🔵 외부</span>`
      : `<span class="contact-chip direct">🟠 직영</span>`;
    const period = c.live_start || c.live_end
      ? `${c.live_start || "—"} ~ ${c.live_end || "—"}`
      : "<i style='color:#aaa'>미정</i>";
    const sh = c.shipment || {};
    const shText = sh.date
      ? `${sh.qty || 0}개 (${sh.date})`
      : "<i style='color:#aaa'>—</i>";
    const sheet = c.sheet_url
      ? `<a class="sheet-btn" href="${escapeHtml(c.sheet_url)}" target="_blank" rel="noopener">시트 ↗</a>`
      : "<i style='color:#aaa'>—</i>";
    return `
      <tr data-cid="${escapeHtml(c.id)}">
        <td><b>${escapeHtml(c.seller_name)}</b>${c.seller_handle ? `<br><span style='font-size:11px;color:#888'>@${escapeHtml(c.seller_handle)}</span>` : ""}</td>
        <td>${escapeHtml(c.brand || "")}<br><span style='font-size:11px;color:#888'>${escapeHtml(c.product || "")}</span></td>
        <td>${c.round}차</td>
        <td class="col-contact">${ctChip}</td>
        <td class="col-stage"><span class="stage-chip ${stageCls}">${escapeHtml(stageLabel)}</span></td>
        <td style="font-size:11px;white-space:nowrap">${escapeHtml(period)}</td>
        <td style="font-size:11px">${shText}</td>
        <td>${sheet}</td>
        <td><span class="status-chip st-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
        <td><button class="btn-text" data-action="edit-campaign" data-id="${escapeHtml(c.id)}">✎</button></td>
      </tr>
    `;
  }).join("");
}

// 셀러 페이지 데이터 — 편집 중인 캠페인 임시 저장
const _se = { campaignId: null, schedule: [], faq: [] };
// Cloudflare Tunnel 상태 cache
const _tunnel = { running: false, url: null };

async function refreshTunnelStatus() {
  try {
    const s = await api("/api/tunnel/status");
    _tunnel.running = !!s.running;
    _tunnel.url = s.url || null;
    updateSellerLinkBox();
  } catch {}
}

function updateSellerLinkBox() {
  const box = $("#sellerLinkBox");
  if (box.hidden) return;
  const token = box.dataset.token;
  if (!token) return;
  const origin = _tunnel.url || window.location.origin;
  $("#sellerLinkUrl").textContent = `${origin}/s/${token}`;
  const statusEl = $("#slbTunnelStatus");
  const toggleBtn = box.querySelector('[data-action="toggle-tunnel"]');
  if (_tunnel.running && _tunnel.url) {
    statusEl.className = "slb-tunnel-on";
    statusEl.innerHTML = `🌐 <b>셀러 공개 ON</b> · 누구나 접속 가능`;
    toggleBtn.textContent = "공개 끄기";
  } else {
    statusEl.className = "slb-tunnel-off";
    statusEl.textContent = "🔒 비공개 (너 PC에서만 접속)";
    toggleBtn.textContent = "셀러 공개 켜기";
  }
}

function showCampaignDialog(campaign) {
  const f = $("#campaignForm");
  f.reset();
  f.elements.id.value = campaign?.id || "";
  populateCampaignBrandSelect();

  // 셀러 링크 박스
  const box = $("#sellerLinkBox");
  if (campaign && campaign.seller_token) {
    box.hidden = false;
    // 예쁜 slug 우선, fallback token
    const linkKey = campaign.seller_slug || campaign.seller_token;
    box.dataset.token = linkKey;
    box.dataset.cid = campaign.id;
    $("#sellerSlugInput").value = campaign.seller_slug || "";
    _se.campaignId = campaign.id;
    _se.schedule = JSON.parse(JSON.stringify(campaign.daily_schedule || []));
    _se.faq = JSON.parse(JSON.stringify(campaign.faq || []));
    refreshTunnelStatus();
  } else {
    box.hidden = true;
  }

  if (campaign) {
    $("#campaignDialogTitle").textContent = `캠페인 수정 — ${campaign.seller_name}`;
    f.elements.seller_name.value = campaign.seller_name || "";
    f.elements.seller_handle.value = campaign.seller_handle || "";
    f.elements.brand_id.value = campaign.brand_id || _brandIdFromName(campaign.brand) || "";
    f.elements.product.value = campaign.product || "";
    f.elements.round.value = campaign.round || 1;
    f.elements.contact_type.value = campaign.contact_type || "direct";
    f.elements.stage.value = campaign.stage || "contact";
    f.elements.status.value = campaign.status || "예정";
    f.elements.live_start.value = campaign.live_start || "";
    f.elements.live_end.value = campaign.live_end || "";
    f.elements.shipment_qty.value = campaign.shipment?.qty || "";
    f.elements.shipment_date.value = campaign.shipment?.date || "";
    f.elements.sheet_url.value = campaign.sheet_url || "";
    f.elements.notes.value = campaign.notes || "";
  } else {
    $("#campaignDialogTitle").textContent = "캠페인 추가";
  }
  $("#campaignDialog").showModal();
}

// ═══════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════
function fmtKRW(n) {
  if (!n || n === 0) return "";
  return Number(n).toLocaleString("ko-KR");
}

function _brandIdFromName(name) {
  if (!name) return "";
  const b = state.brands.find(x => x.name === name || x.id === name);
  return b ? b.id : "";
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    renderDashboard(data);
  } catch (e) {
    $("#dashTable").innerHTML = `<tbody><tr><td class="empty">에러: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

// 대시보드에서 편집 가능한 메트릭 row 정의
// settlement/financials 키 + 라벨 + 타입(text/number/date/select)
const DASH_ROWS = [
  { section: "정산 메타", key: "settlement.completed_date", label: "정산완료날짜", type: "date" },
  { key: "settlement.base_date", label: "기본 정산일", type: "date" },
  { section: "캠페인", key: "_label", label: "셀러명 RAW", readonly: true },
  { key: "owner", label: "담당자", type: "text" },
  { key: "seller_real_name", label: "셀러", type: "text" },
  { key: "brand", label: "브랜드", type: "text" },
  { key: "product", label: "제품명", type: "text" },
  { key: "live_start", label: "공동구매 시작일", type: "date" },
  { key: "live_end", label: "공동구매 마감일", type: "date" },
  { key: "open_kind", label: "본사 오픈", type: "select", options: ["", "본사오픈", "타사오픈"] },
  { section: "비율 / 조건", key: "settlement.rs_percent", label: "RS%", type: "number", suffix: "%" },
  { key: "settlement.type", label: "사업자/프리랜서", type: "select", options: ["", "사업자", "프리랜서"] },
  { key: "settlement.pg_logistics", label: "PG/배송비", type: "text" },
  { section: "매출 / 비용 (원)", key: "financials.revenue", label: "매출", type: "money" },
  { key: "financials.seller_fee", label: "셀러수수료", type: "money" },
  { key: "financials.pg_fee", label: "PG사 수수료", type: "money" },
  { key: "financials.event_cost", label: "이벤트 비용", type: "money" },
  { key: "financials.cost", label: "원가", type: "money" },
  { key: "financials.shipping", label: "배송비", type: "money" },
  { key: "financials.vat", label: "부가세", type: "money" },
  { section: "자동 계산", key: "_total_cost", label: "총 비용", calc: true },
  { key: "_profit", label: "공헌이익", calc: true, highlight: true },
  { key: "_rate", label: "공헌이익률 (%)", calc: true, highlight: true },
];

function getValueAtPath(camp, path) {
  if (path === "_label") return `${camp.seller_name} (${camp.round}차)`;
  if (path === "_total_cost") return camp.calc?.total_cost;
  if (path === "_profit") return camp.calc?.contribution_profit;
  if (path === "_rate") return camp.calc?.contribution_rate;
  const parts = path.split(".");
  let cur = camp;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

function renderDashboard(data) {
  // 총합 카드들
  const t = data.totals || {};
  $("#dashTotals").innerHTML = `
    <div class="dash-stat">
      <div class="ds-label">완료 캠페인</div>
      <div class="ds-value">${t.completed_count || 0}건</div>
    </div>
    <div class="dash-stat">
      <div class="ds-label">총 매출</div>
      <div class="ds-value">${fmtKRW(t.total_revenue) || "0"}원</div>
    </div>
    <div class="dash-stat">
      <div class="ds-label">총 공헌이익</div>
      <div class="ds-value gold">${fmtKRW(t.total_profit) || "0"}원</div>
    </div>
    <div class="dash-stat">
      <div class="ds-label">평균 이익률</div>
      <div class="ds-value gold">${t.avg_rate || 0}%</div>
    </div>
  `;

  // 표: 행 = 메트릭, 열 = 캠페인 (브랜드 필터 적용)
  const camps = filterByBrand(data.campaigns || [], c => c.brand_id || _brandIdFromName(c.brand));
  if (!camps.length) {
    $("#dashTable").innerHTML = `<tbody><tr><td class="empty">캠페인 없음</td></tr></tbody>`;
    return;
  }

  let html = "<thead><tr><th class='dt-label-col'></th>";
  for (const c of camps) {
    const st = c.status || "";
    html += `<th class='dt-camp-head' data-cid='${escapeHtml(c.id)}'>
      <div class='dt-camp-title'>${escapeHtml(c.label)}</div>
      <div class='dt-camp-sub'><span class='status-chip st-${escapeHtml(st)}'>${escapeHtml(st)}</span></div>
    </th>`;
  }
  html += "</tr></thead><tbody>";

  for (const row of DASH_ROWS) {
    if (row.section) {
      html += `<tr class='dt-section-row'><td colspan='${camps.length + 1}'>${escapeHtml(row.section)}</td></tr>`;
    }
    html += `<tr><td class='dt-label'>${escapeHtml(row.label)}</td>`;
    for (const c of camps) {
      const v = getValueAtPath(c, row.key);
      const cls = [
        "dt-cell",
        row.calc ? "calc" : "",
        row.highlight ? "highlight" : "",
        row.readonly ? "readonly" : "",
      ].filter(Boolean).join(" ");
      let display = "";
      if (v != null && v !== "") {
        if (row.type === "money") display = fmtKRW(v);
        else if (row.key === "_rate") display = `${v}%`;
        else if (row.type === "number" && row.suffix) display = `${v}${row.suffix}`;
        else display = String(v);
      }
      const editable = !row.readonly && !row.calc;
      html += `<td class='${cls}' data-cid='${escapeHtml(c.id)}' data-key='${escapeHtml(row.key)}' data-type='${escapeHtml(row.type || "text")}' ${editable ? "data-editable='1'" : ""}${row.options ? ` data-options='${escapeHtml(JSON.stringify(row.options))}'` : ""}>${escapeHtml(display)}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  $("#dashTable").innerHTML = html;
}

// 셀 인라인 편집
document.addEventListener("dblclick", (e) => {
  const cell = e.target.closest('.dt-cell[data-editable="1"]');
  if (cell) startEditCell(cell);
});
document.addEventListener("click", (e) => {
  const cell = e.target.closest('.dt-cell[data-editable="1"]');
  if (cell && !cell.classList.contains("editing")) {
    startEditCell(cell);
  }
});

function startEditCell(cell) {
  if (cell.classList.contains("editing")) return;
  const type = cell.dataset.type || "text";
  const oldVal = cell.textContent.replace(/[,원% ]/g, "").trim();
  cell.classList.add("editing");
  let input;
  if (type === "select" && cell.dataset.options) {
    const opts = JSON.parse(cell.dataset.options);
    input = document.createElement("select");
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o || "(선택 안 함)";
      if (o === oldVal) opt.selected = true;
      input.appendChild(opt);
    }
  } else {
    input = document.createElement("input");
    input.type = (type === "money" || type === "number") ? "number" : (type === "date" ? "date" : "text");
    if (type === "money" || type === "number") input.step = "any";
    input.value = oldVal;
  }
  input.className = "dt-input";
  cell.innerHTML = "";
  cell.appendChild(input);
  input.focus();
  if (input.select) input.select();

  const commit = async () => {
    const newVal = input.value;
    cell.classList.remove("editing");
    await saveDashCell(cell, newVal);
  };
  const cancel = () => {
    cell.classList.remove("editing");
    loadDashboard(); // 원상복구
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

async function saveDashCell(cell, newVal) {
  const cid = cell.dataset.cid;
  const key = cell.dataset.key;
  const type = cell.dataset.type;
  // path 파싱: settlement.rs_percent / financials.revenue / live_start
  const parts = key.split(".");
  let payload;
  if (parts.length === 2) {
    payload = { [parts[0]]: { [parts[1]]: newVal } };
    // 기존 값 보존 위해 GET 후 머지
    const camp = state.campaigns.find(c => c.id === cid);
    if (camp) {
      payload[parts[0]] = { ...(camp[parts[0]] || {}), [parts[1]]: newVal };
    }
  } else {
    payload = { [key]: newVal };
  }
  // 숫자 타입은 변환
  if (type === "money" || type === "number") {
    const num = parseFloat(newVal) || 0;
    if (parts.length === 2) payload[parts[0]][parts[1]] = num;
    else payload[key] = num;
  }
  try {
    await api(`/api/campaigns/${cid}`, { method: "PATCH", body: JSON.stringify(payload) });
    await loadCampaigns();
    await loadDashboard();
  } catch (e) {
    alert("저장 실패: " + e.message);
    loadDashboard();
  }
}

// ═══════════════════════════════════════════════════════════
// EVENTS (calendar direct add)
// ═══════════════════════════════════════════════════════════
function showEventDialog(opts) {
  const f = $("#eventForm");
  f.reset();
  const { date, event } = opts || {};
  if (event) {
    $("#eventDialogTitle").textContent = "이벤트 수정";
    f.elements.id.value = event.id || "";
    f.elements.date.value = event.date || "";
    f.elements.time.value = event.time || "";
    f.elements.kind.value = event.kind || "other";
    f.elements.title.value = event.title || "";
    f.elements.notes.value = event.notes || "";
  } else {
    $("#eventDialogTitle").textContent = "이벤트 추가";
    f.elements.id.value = "";
    f.elements.date.value = date || ymdLocal(new Date());
  }
  $("#eventDialog").showModal();
}

// ═══════════════════════════════════════════════════════════
// MEETINGS
// ═══════════════════════════════════════════════════════════
async function loadMeetings() {
  try {
    const { meetings } = await api("/api/meetings");
    state.meetings = meetings || [];
    renderMeetings();
  } catch (e) {
    $("#meetingList").innerHTML = `<div class="empty">에러: ${escapeHtml(e.message)}</div>`;
  }
}

function renderMeetings() {
  const root = $("#meetingList");
  if (!root) return;
  if (!state.meetings.length) {
    root.innerHTML = '<div class="empty">미팅 없음. [+ 미팅 추가]로 시작하세요.</div>';
    return;
  }
  // 최신순
  const sorted = [...state.meetings].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const MIC = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>';
  const STATUS_LABEL = { none: "녹취 미업로드", uploaded: "분석 대기", analyzing: "분석 중…", done: "분석 완료", error: "분석 에러" };
  root.innerHTML = sorted.map(m => {
    const camp = state.campaigns.find(c => c.id === m.campaign_id);
    const status = m.analysis_status || "none";
    const when = m.date ? `${m.date}${m.time ? " " + m.time : ""}` : "날짜 미정";
    const round = camp ? `${camp.round}차 미팅` : "";
    const note = m.summary || m.agenda || (Array.isArray(m.attendees) ? m.attendees.join(", ") : (m.attendees || ""));
    return `
      <div class="meeting-card" data-action="open-meeting" data-id="${escapeHtml(m.id)}">
        <div class="mc-icon">${MIC}</div>
        <div class="mc-body">
          <div class="mc-head">
            <span class="mc-title">${escapeHtml(m.title)}</span>
            ${round ? `<span class="mc-round">${escapeHtml(round)}</span>` : ""}
            <span class="analysis-pill ${status}">${STATUS_LABEL[status] || status}</span>
          </div>
          ${note ? `<div class="mc-note">${escapeHtml(note)}</div>` : ""}
          <div class="mc-date">${escapeHtml(when)}</div>
        </div>
        <button class="btn-outline mc-upload" data-action="open-meeting" data-id="${escapeHtml(m.id)}">🎙 녹취 업로드</button>
      </div>
    `;
  }).join("");
}

function showMeetingDialog(meeting) {
  const f = $("#meetingForm");
  f.reset();
  populateCampaignSelectInMeetingDialog();
  if (meeting) {
    $("#meetingDialogTitle").textContent = "미팅 수정";
    f.elements.id.value = meeting.id;
    f.elements.title.value = meeting.title || "";
    f.elements.campaign_id.value = meeting.campaign_id || "";
    f.elements.date.value = meeting.date || "";
    f.elements.time.value = meeting.time || "";
    f.elements.attendees.value = Array.isArray(meeting.attendees) ? meeting.attendees.join(", ") : "";
    f.elements.agenda.value = meeting.agenda || "";
  } else {
    $("#meetingDialogTitle").textContent = "미팅 추가";
    f.elements.id.value = "";
  }
  $("#meetingDialog").showModal();
}

function populateCampaignSelectInMeetingDialog() {
  const sel = $("#meetingForm")?.elements?.campaign_id;
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">(없음)</option>' +
    state.campaigns.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.seller_name)} ${c.round}차 — ${escapeHtml(c.product || "")}</option>`).join("");
  sel.value = prev;
}

function showMeetingDetail(mid) {
  const m = state.meetings.find(x => x.id === mid);
  if (!m) return;
  state.currentMeetingId = mid;
  const camp = state.campaigns.find(c => c.id === m.campaign_id);
  const status = m.analysis_status || "none";
  const hasAudio = !!m.audio_file;
  const attendees = Array.isArray(m.attendees) ? m.attendees.join(", ") : (m.attendees || "");

  $("#mdTitle").textContent = m.title;
  $("#mdBody").innerHTML = `
    <div class="md-section">
      <div class="md-meta-grid">
        <div class="k">날짜/시간</div><div class="v">${escapeHtml(m.date || "—")} ${escapeHtml(m.time || "")}</div>
        <div class="k">연관 캠페인</div><div class="v">${camp ? escapeHtml(camp.seller_name) + " " + camp.round + "차 — " + escapeHtml(camp.product || "") : "—"}</div>
        <div class="k">참석자</div><div class="v">${escapeHtml(attendees || "—")}</div>
        <div class="k">상태</div><div class="v"><span class="analysis-pill ${status}">${escapeHtml(status)}</span></div>
      </div>
      ${m.agenda ? `<h4>안건</h4><div style="font-size:13px;white-space:pre-wrap">${escapeHtml(m.agenda)}</div>` : ""}
    </div>

    <div class="md-section">
      <h4>녹음 파일 (드래그 OR 클릭 → 자동으로 Google Drive 저장)</h4>
      <div class="md-upload-box ${hasAudio ? "has-file" : ""}" id="dropZone">
        ${hasAudio
          ? `<div>
              <b>📁 업로드 완료${m.audio_location === "drive" ? " (Google Drive ☁)" : " (로컬)"}</b>
              <div class="file-info">${escapeHtml(m.audio_filename || m.audio_file)}</div>
              <div class="file-info" style="margin-top:2px">📂 ${escapeHtml(m.audio_folder || "")}</div>
            </div>`
          : `<div class="dz-empty">
              <div style="font-size:28px">🎵</div>
              <div><b>여기에 오디오 파일을 끌어다 놓거나</b></div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">m4a · mp3 · wav · aac · ogg · webm · mp4 · 자동으로 의미있는 이름으로 변경됨</div>
            </div>`}
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn-secondary" style="cursor:pointer">
            📤 ${hasAudio ? "다시 업로드" : "파일 선택"}
            <input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.aac" hidden id="audioInput" />
          </label>
          ${hasAudio ? `<button class="btn-primary" data-action="analyze-meeting" data-id="${escapeHtml(mid)}">${status === "done" ? "🔄 재분석" : "✨ Gemini 자동 분석"}</button>` : ""}
          <button class="btn-text" data-action="open-meeting-folder">📁 녹취 폴더 열기</button>
        </div>
        <div id="analyzeProgress" class="hint" style="margin-top:8px"></div>
      </div>
    </div>

    <div class="md-section">
      <h4>📝 받아쓰기 텍스트 직접 붙여넣기 (클로바노트 결과 등)</h4>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px">
        클로바노트로 화자 매치까지 끝낸 텍스트가 있으면 여기 붙여넣고 [텍스트로 분석] 누르세요.
        오디오 안 거치고 바로 요약/액션아이템 추출됩니다. (훨씬 빠르고 정확)
      </div>
      <textarea class="md-edit-area" id="mdTranscriptPaste" rows="6" placeholder="예:\n김동환: 윰니님 안녕하세요...\n윰니: 네 안녕하세요..."></textarea>
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-primary" data-action="analyze-text" data-id="${escapeHtml(mid)}">✨ 이 텍스트로 분석</button>
        <button class="btn-text" data-action="save-transcript-only" data-id="${escapeHtml(mid)}">텍스트만 저장 (분석 X)</button>
        <span id="textAnalyzeProgress" class="hint"></span>
      </div>
    </div>

    <div class="md-section">
      <h4>요약 (자동 + 수동 수정 가능)</h4>
      <textarea class="md-edit-area" id="mdSummary" rows="4" placeholder="Gemini가 분석 후 채워줍니다. 직접 작성도 가능.">${escapeHtml(m.summary || "")}</textarea>
    </div>

    ${m.action_items?.length ? `
      <div class="md-section">
        <h4>액션 아이템 (자동 추출)</h4>
        <ul class="md-list">
          ${m.action_items.map(a => `<li class="action-item"><span class="who">${escapeHtml(a.who || "미정")}</span><span>${escapeHtml(a.what || "")}</span><span class="when">${escapeHtml(a.when || "미정")}</span></li>`).join("")}
        </ul>
      </div>
    ` : ""}

    ${m.decisions?.length ? `
      <div class="md-section">
        <h4>결정 사항</h4>
        <ul class="md-list">${m.decisions.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
      </div>
    ` : ""}

    ${m.key_points?.length ? `
      <div class="md-section">
        <h4>주요 포인트</h4>
        <ul class="md-list">${m.key_points.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
      </div>
    ` : ""}

    ${m.follow_up_topics?.length ? `
      <div class="md-section">
        <h4>다음 논의 주제</h4>
        <ul class="md-list">${m.follow_up_topics.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
      </div>
    ` : ""}

    <div class="md-section">
      <h4>수동 메모 (자유 기록)</h4>
      <textarea class="md-edit-area" id="mdManualNotes" rows="3" placeholder="수동으로 추가하고 싶은 내용...">${escapeHtml(m.manual_notes || "")}</textarea>
    </div>

    ${m.transcript ? `
      <div class="md-section">
        <h4>전체 받아쓰기 (트랜스크립트)</h4>
        <div class="md-transcript">${escapeHtml(m.transcript)}</div>
      </div>
    ` : ""}

    <div class="dialog-actions" style="margin-top:14px">
      <span class="spacer"></span>
      <button type="button" class="btn-primary" data-action="save-meeting-edits">📝 메모/요약 저장</button>
    </div>
  `;
  $("#meetingDetailDialog").showModal();

  // 드래그앤드롭 셋업
  const dz = $("#dropZone");
  if (dz) {
    ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove("dragover");
    }));
    dz.addEventListener("drop", async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const progressEl = $("#analyzeProgress");
      if (progressEl) progressEl.textContent = `📤 업로드 중: ${file.name}...`;
      try {
        await uploadMeetingAudio(state.currentMeetingId, file);
        await loadMeetings();
        forceCloseDialog("meetingDetailDialog");
        showMeetingDetail(state.currentMeetingId);
      } catch (err) {
        alert("업로드 실패: " + err.message);
      }
    });
  }
}

async function analyzeTextForMeeting(mid) {
  const ta = $("#mdTranscriptPaste");
  const transcript = (ta?.value || "").trim();
  if (!transcript) { alert("붙여넣을 텍스트가 비어있어요."); return; }
  const progressEl = $("#textAnalyzeProgress");
  renderProgressBox(progressEl, { title: "분석 시작...", pct: 5 });
  try {
    const { job_id } = await api(`/api/meetings/${mid}/analyze_text`, {
      method: "POST",
      body: JSON.stringify({ transcript }),
    });
    while (true) {
      const job = await api(`/api/jobs/${job_id}`);
      const pct = job.total > 0 ? (job.progress / job.total) * 100 : 0;
      renderProgressBox(progressEl, { title: "✨ 텍스트 분석 중", sub: job.message, pct });
      if (job.status === "done") {
        renderProgressBox(progressEl, { title: "✅ 분석 완료!", pct: 100, state: "done" });
        await loadMeetings();
        setTimeout(() => {
          forceCloseDialog("meetingDetailDialog");
          showMeetingDetail(mid);
        }, 600);
        return;
      }
      if (job.status === "error") {
        renderProgressBox(progressEl, { title: "❌ 분석 실패", sub: job.message, pct: 100, state: "error" });
        return;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) {
    renderProgressBox(progressEl, { title: "❌ 에러", sub: e.message, pct: 100, state: "error" });
  }
}

async function uploadMeetingAudio(mid, file) {
  const fd = new FormData();
  fd.append("audio", file);
  const res = await fetch(`/api/meetings/${mid}/upload`, { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderProgressBox(target, { title, sub, pct, state }) {
  const cls = state === "done" ? "done" : state === "error" ? "error" : "";
  target.innerHTML = `
    <div class="progress-box ${cls}">
      <div class="spinner"></div>
      <div class="pb-body">
        <div class="pb-title">${escapeHtml(title || "")}</div>
        ${sub ? `<div class="pb-sub">${escapeHtml(sub)}</div>` : ""}
        <div class="pb-bar"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></div>
      </div>
      <div class="pb-percent">${Math.round(pct || 0)}%</div>
    </div>
  `;
}

async function analyzeMeeting(mid) {
  const progressEl = $("#analyzeProgress");
  renderProgressBox(progressEl, { title: "분석 시작...", pct: 5 });
  try {
    const { job_id } = await api(`/api/meetings/${mid}/analyze`, { method: "POST" });
    while (true) {
      const job = await api(`/api/jobs/${job_id}`);
      const pct = job.total > 0 ? (job.progress / job.total) * 100 : 0;
      renderProgressBox(progressEl, {
        title: "✨ Gemini 미팅 분석",
        sub: job.message || "",
        pct,
      });
      if (job.status === "done") {
        renderProgressBox(progressEl, { title: "✅ 분석 완료!", sub: "결과 적용 중...", pct: 100, state: "done" });
        await loadMeetings();
        setTimeout(() => {
          forceCloseDialog("meetingDetailDialog");
          showMeetingDetail(mid);
        }, 800);
        return;
      }
      if (job.status === "error") {
        renderProgressBox(progressEl, { title: "❌ 분석 실패", sub: job.message, pct: 100, state: "error" });
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    renderProgressBox(progressEl, { title: "❌ 에러", sub: e.message, pct: 100, state: "error" });
  }
}

// ═══════════════════════════════════════════════════════════
// EVENT DELEGATION (for new tabs)
// ═══════════════════════════════════════════════════════════
document.addEventListener("click", async (e) => {
  // 캘린더 nav
  const navBtn = e.target.closest("[data-cal-nav]");
  if (navBtn) { calNav(navBtn.dataset.calNav); return; }

  // 캠페인 막대바 클릭
  const barEl = e.target.closest(".cal-bar");
  if (barEl) {
    e.stopPropagation();
    const cid = barEl.dataset.campaignId;
    const c = state.campaigns.find(x => x.id === cid);
    if (c) showCampaignDialog(c);
    return;
  }
  // 일정 칩 클릭
  const dotEl = e.target.closest(".cal-ev");
  if (dotEl) {
    e.stopPropagation();
    // 캠페인 라이브 점 → 캠페인 다이얼로그
    if (dotEl.dataset.campaignId) {
      const c = state.campaigns.find(x => x.id === dotEl.dataset.campaignId);
      if (c) showCampaignDialog(c);
      return;
    }
    const isAuto = dotEl.dataset.auto === "1";
    const refKind = dotEl.dataset.refKind;
    const refId = dotEl.dataset.refId;
    if (isAuto) {
      if (refKind === "meeting") {
        switchTab("meetings");
        showMeetingDetail(refId);
      } else if (refKind === "campaign") {
        const c = state.campaigns.find(x => x.id === refId);
        if (c) showCampaignDialog(c);
      }
    } else {
      const event = state.calEvents.find(x => x.id === dotEl.dataset.eventId);
      if (event) showEventDialog({ event });
    }
    return;
  }

  // 상단 [+ 새 이벤트] 버튼
  if (e.target.closest("#btnAddEventTop")) {
    showEventDialog({ date: ymdLocal(new Date()) });
    return;
  }

  // 캘린더 빈 셀 클릭 = 새 이벤트
  const cell = e.target.closest(".cal-cell");
  if (cell && !cell.classList.contains("off")) {
    showEventDialog({ date: cell.dataset.date });
    return;
  }

  // 캠페인 행 작업 — ✎ 버튼 = 다이얼로그, 행 = 컨트롤 타워
  const camBtn = e.target.closest('[data-action="edit-campaign"]');
  if (camBtn) {
    const c = state.campaigns.find(x => x.id === camBtn.dataset.id);
    if (c) showCampaignDialog(c);
    return;
  }
  const camRow = e.target.closest('tr[data-cid]');
  if (camRow && !camBtn) {
    try { Tower.open(camRow.dataset.cid); } catch (err) { console.error("[Tower]", err); }
    return;
  }

  // 미팅 카드
  const mtBtn = e.target.closest('[data-action="open-meeting"]');
  if (mtBtn) { showMeetingDetail(mtBtn.dataset.id); return; }

  // 캠페인 다이얼로그 액션
  if (e.target.closest('[data-action="cancel-campaign"]')) { forceCloseDialog("campaignDialog"); return; }
  if (e.target.closest('[data-action="delete-campaign"]')) {
    const cid = $("#campaignForm").elements.id.value;
    if (!cid) { forceCloseDialog("campaignDialog"); return; }
    if (!confirm("이 캠페인을 삭제할까요?")) return;
    try { await api(`/api/campaigns/${cid}`, { method: "DELETE" }); forceCloseDialog("campaignDialog"); await loadCampaigns(); await loadCalendar(); await loadToday(); }
    catch (err) { alert("삭제 실패: " + err.message); }
    return;
  }

  // 이벤트 다이얼로그 액션
  if (e.target.closest('[data-action="cancel-event"]')) { forceCloseDialog("eventDialog"); return; }
  if (e.target.closest('[data-action="delete-event"]')) {
    const eid = $("#eventForm").elements.id.value;
    if (!eid) { forceCloseDialog("eventDialog"); return; }
    if (!confirm("이 이벤트를 삭제할까요?")) return;
    try { await api(`/api/events/${eid}`, { method: "DELETE" }); forceCloseDialog("eventDialog"); await loadCalendar(); }
    catch (err) { alert("삭제 실패: " + err.message); }
    return;
  }

  // 미팅 다이얼로그
  if (e.target.closest('[data-action="cancel-meeting"]')) { forceCloseDialog("meetingDialog"); return; }
  if (e.target.closest('[data-action="close-meeting-detail"]')) { forceCloseDialog("meetingDetailDialog"); return; }
  if (e.target.closest('[data-action="edit-meeting-meta"]')) {
    const m = state.meetings.find(x => x.id === state.currentMeetingId);
    if (m) { forceCloseDialog("meetingDetailDialog"); showMeetingDialog(m); }
    return;
  }
  if (e.target.closest('[data-action="delete-meeting-from-detail"]')) {
    if (!state.currentMeetingId) return;
    if (!confirm("이 미팅과 녹취 파일을 삭제할까요?")) return;
    try { await api(`/api/meetings/${state.currentMeetingId}`, { method: "DELETE" }); forceCloseDialog("meetingDetailDialog"); await loadMeetings(); await loadCalendar(); }
    catch (err) { alert("삭제 실패: " + err.message); }
    return;
  }
  if (e.target.closest('[data-action="analyze-meeting"]')) {
    const mid = e.target.closest('[data-action="analyze-meeting"]').dataset.id;
    analyzeMeeting(mid);
    return;
  }
  if (e.target.closest('[data-action="analyze-text"]')) {
    const mid = e.target.closest('[data-action="analyze-text"]').dataset.id;
    analyzeTextForMeeting(mid);
    return;
  }
  if (e.target.closest('[data-action="open-meeting-folder"]')) {
    try {
      const r = await api("/api/meetings/open_folder", { method: "POST" });
      const pe = $("#analyzeProgress");
      if (pe) pe.textContent = `📁 폴더 열림: ${r.path}${r.is_drive ? " (Google Drive ☁)" : ""}`;
    } catch (err) { alert("폴더 열기 실패: " + err.message); }
    return;
  }
  if (e.target.closest('[data-action="save-transcript-only"]')) {
    const mid = e.target.closest('[data-action="save-transcript-only"]').dataset.id;
    const ta = $("#mdTranscriptPaste");
    const transcript = (ta?.value || "").trim();
    if (!transcript) { alert("텍스트가 비어있어요."); return; }
    try {
      await api(`/api/meetings/${mid}`, { method: "PATCH", body: JSON.stringify({ transcript }) });
      await loadMeetings();
      forceCloseDialog("meetingDetailDialog");
      showMeetingDetail(mid);
    } catch (err) { alert("저장 실패: " + err.message); }
    return;
  }
  if (e.target.closest('[data-action="save-meeting-edits"]')) {
    const mid = state.currentMeetingId;
    if (!mid) return;
    const payload = {
      summary: $("#mdSummary")?.value || "",
      manual_notes: $("#mdManualNotes")?.value || "",
    };
    try {
      await api(`/api/meetings/${mid}`, { method: "PATCH", body: JSON.stringify(payload) });
      const btn = e.target.closest('[data-action="save-meeting-edits"]');
      btn.textContent = "✓ 저장됨";
      setTimeout(() => { btn.textContent = "📝 메모/요약 저장"; }, 1500);
      await loadMeetings();
    } catch (err) { alert("저장 실패: " + err.message); }
    return;
  }

  // today widget click → 캠페인 열기
  const tiBtn = e.target.closest('[data-action="open-campaign"]');
  if (tiBtn) {
    const c = state.campaigns.find(x => x.id === tiBtn.dataset.id);
    if (c) { switchTab("campaigns"); showCampaignDialog(c); }
    return;
  }

  // 백업 폴더 열기
  if (e.target.closest('[data-action="open-backup"]')) {
    try {
      const r = await api("/api/backup_status/open", { method: "POST" });
      // 별도 알림 없이 폴더 열림
    } catch (err) { alert("폴더 열기 실패: " + err.message); }
    return;
  }
  // 지금 백업
  if (e.target.closest('[data-action="run-backup"]')) {
    const btn = e.target.closest('[data-action="run-backup"]');
    const orig = btn.textContent;
    btn.textContent = "백업 중...";
    btn.disabled = true;
    try {
      await api("/api/backup/run", { method: "POST" });
      btn.textContent = "✓ 완료";
      await refreshBackupStatus();
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    } catch (err) {
      btn.textContent = "❌ 실패";
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
    return;
  }
});

// 오디오 파일 input change
document.addEventListener("change", async (e) => {
  if (e.target.id === "audioInput") {
    const file = e.target.files[0];
    if (!file || !state.currentMeetingId) return;
    const progressEl = $("#analyzeProgress");
    if (progressEl) progressEl.textContent = `📤 업로드 중: ${file.name}...`;
    try {
      await uploadMeetingAudio(state.currentMeetingId, file);
      await loadMeetings();
      forceCloseDialog("meetingDetailDialog");
      showMeetingDetail(state.currentMeetingId);
    } catch (err) {
      alert("업로드 실패: " + err.message);
    }
  }
  if (e.target.id === "campFilter") renderCampaigns();
});

// 캠페인 폼 submit
$("#campaignForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const obj = Object.fromEntries(fd.entries());
  const brand_id = obj.brand_id || "";
  const brandObj = state.brands.find(b => b.id === brand_id);
  const payload = {
    seller_name: obj.seller_name,
    seller_handle: obj.seller_handle,
    brand_id: brand_id,
    brand: brandObj ? brandObj.name : "",
    product: obj.product,
    round: parseInt(obj.round) || 1,
    contact_type: obj.contact_type,
    stage: obj.stage,
    status: obj.status,
    live_start: obj.live_start,
    live_end: obj.live_end,
    shipment: { qty: parseInt(obj.shipment_qty) || 0, date: obj.shipment_date || "" },
    sheet_url: obj.sheet_url,
    notes: obj.notes,
  };
  const id = obj.id;
  try {
    if (id) await api(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    else await api("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
    forceCloseDialog("campaignDialog");
    await loadBrands();
    await loadCampaigns();
    await loadCalendar();
    await loadToday();
  } catch (err) { alert("저장 실패: " + err.message); }
});

// 이벤트 폼 submit
$("#eventForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const obj = Object.fromEntries(fd.entries());
  const id = obj.id; delete obj.id;
  try {
    if (id) await api(`/api/events/${id}`, { method: "PATCH", body: JSON.stringify(obj) });
    else await api("/api/events", { method: "POST", body: JSON.stringify(obj) });
    forceCloseDialog("eventDialog");
    await loadCalendar();
  } catch (err) { alert("저장 실패: " + err.message); }
});

// 미팅 폼 submit
$("#meetingForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const obj = Object.fromEntries(fd.entries());
  const id = obj.id;
  const payload = {
    title: obj.title,
    campaign_id: obj.campaign_id,
    date: obj.date,
    time: obj.time,
    attendees: (obj.attendees || "").split(",").map(s => s.trim()).filter(Boolean),
    agenda: obj.agenda,
  };
  try {
    if (id) {
      await api(`/api/meetings/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api("/api/meetings", { method: "POST", body: JSON.stringify(payload) });
    }
    forceCloseDialog("meetingDialog");
    await loadMeetings();
    await loadCalendar();
  } catch (err) { alert("저장 실패: " + err.message); }
});

// 사이드 버튼
$("#btnAddCampaign")?.addEventListener("click", () => showCampaignDialog(null));
$("#btnAddMeeting")?.addEventListener("click", () => showMeetingDialog(null));

// ═══════════════════════════════════════════════════════════
// 셀러 페이지 — 스케줄 / FAQ 편집기 + 미리보기
// ═══════════════════════════════════════════════════════════
// 다이얼로그 강제 종료 헬퍼 (안전망)
function forceCloseDialog(id) {
  const d = typeof id === "string" ? document.getElementById(id) : id;
  if (!d) return;
  try { d.close(); } catch {}
  try { d.removeAttribute("open"); } catch {}
}

// 모든 dialog 백드롭 클릭 시 닫기 (dialog element 자체가 클릭 타깃이면 backdrop)
document.addEventListener("click", (e) => {
  if (e.target.tagName === "DIALOG" && e.target.open) {
    const rect = e.target.getBoundingClientRect();
    const inside = e.clientY >= rect.top && e.clientY <= rect.bottom &&
                   e.clientX >= rect.left && e.clientX <= rect.right;
    if (!inside) forceCloseDialog(e.target);
  }
});

// ESC 처리 — 가장 위 모달만 닫기 (브라우저 기본 + 안전망)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const openDialogs = Array.from(document.querySelectorAll("dialog[open]"));
    if (openDialogs.length) {
      const top = openDialogs[openDialogs.length - 1];
      forceCloseDialog(top);
    }
  }
});

const KIND_OPTIONS = [
  { v: "pre", label: "사전" },
  { v: "shipment", label: "발송" },
  { v: "content", label: "콘텐츠" },
  { v: "live", label: "라이브" },
  { v: "post", label: "사후" },
  { v: "other", label: "기타" },
];

// 기본 STORY 슬롯 라벨 (시트 양식 따라)
const DEFAULT_STORY_LABELS = [
  "STORY 1 — 일상 노출",
  "STORY 2 — 고객 반응",
  "STORY 3 — 비포애프터",
  "STORY 4 — 효능 증명",
  "STORY 5 — 공유 어필",
];

function ensureStories(d) {
  // 기존 데이터 호환 — stories 없으면 빈 5개로 초기화
  if (!d.stories || !Array.isArray(d.stories)) {
    d.stories = DEFAULT_STORY_LABELS.map((label, i) => ({
      slot: i + 1, label: label, caption: "", image_url: "",
    }));
  }
  // 5개 미만이면 채움
  while (d.stories.length < 5) {
    const i = d.stories.length;
    d.stories.push({ slot: i + 1, label: DEFAULT_STORY_LABELS[i] || `STORY ${i+1}`, caption: "", image_url: "" });
  }
  if (!d.feed_post) d.feed_post = { label: "게시물 (피드)", caption: "", image_url: "" };
  return d;
}

function renderScheduleEditor() {
  const list = $("#seList");
  if (!_se.schedule.length) {
    list.innerHTML = `<div class="empty">⚡ 위의 자동 생성 또는 [+ 빈 날짜 추가] 로 시작하세요.</div>`;
    return;
  }
  // 모든 일자에 stories 보장
  _se.schedule.forEach(ensureStories);

  // 일자 카운트 표시
  const summary = `<div class="se-summary">📅 총 ${_se.schedule.length}개 일자
    <button type="button" class="btn-primary" data-action="generate-all-captions" style="margin-left:10px">✨ 전체 멘트 자동 생성</button>
    <button type="button" class="btn-secondary" data-action="recommend-images" style="margin-left:6px">🖼 이미지 자동 추천</button>
  </div>`;

  list.innerHTML = summary + _se.schedule.map((d, i) => `
    <div class="se-card slot-card" data-idx="${i}">
      <div class="se-card-head">
        <span class="se-idx">#${i + 1}</span>
        <input type="date" data-f="date" value="${escapeHtml(d.date || "")}" />
        <input type="text" data-f="day_label" placeholder="D-3 / D-Day" value="${escapeHtml(d.day_label || "")}" style="width: 90px" />
        <select data-f="kind">
          ${KIND_OPTIONS.map(o => `<option value="${o.v}" ${d.kind === o.v ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
        <label style="font-size:11px;white-space:nowrap"><input type="checkbox" data-f="is_new" ${d.is_new ? "checked" : ""} /> NEW</label>
        <button type="button" class="btn-secondary" data-action="generate-captions" data-idx="${i}" style="font-size:11px;padding:4px 10px">✨ 멘트 생성</button>
        <button type="button" class="btn-text" data-action="del-schedule-day" data-idx="${i}">✕</button>
      </div>

      <div class="slot-grid">
        ${d.stories.map((s, si) => `
          <div class="slot-cell" data-slot-idx="${si}">
            <input type="text" class="slot-label" data-sf="label" placeholder="라벨 예: [아침 한 포 루틴]" value="${escapeHtml(s.label || "")}" />
            <input type="text" class="slot-image" data-sf="image_url" placeholder="이미지 URL (선택)" value="${escapeHtml(s.image_url || "")}" />
            <textarea class="slot-caption" data-sf="caption" rows="4" placeholder="멘트 — 셀러가 카피해서 인스타에 올림">${escapeHtml(s.caption || "")}</textarea>
          </div>
        `).join("")}
        <div class="slot-cell feed-cell" data-slot-idx="feed">
          <div class="slot-feed-tag">📷 게시물 (피드)</div>
          <input type="text" class="slot-label" data-ff="label" placeholder="게시물 라벨" value="${escapeHtml(d.feed_post.label || "")}" />
          <input type="text" class="slot-image" data-ff="image_url" placeholder="이미지 URL" value="${escapeHtml(d.feed_post.image_url || "")}" />
          <textarea class="slot-caption" data-ff="caption" rows="4" placeholder="게시물 멘트">${escapeHtml(d.feed_post.caption || "")}</textarea>
        </div>
      </div>

      <textarea class="slot-notes" data-f="notes" rows="2" placeholder="비고 / 참고 셀럽">${escapeHtml(d.notes || "")}</textarea>
    </div>
  `).join("");
}

// ⚡ 일자 자동 생성
function autoGenerateSchedule() {
  const preStart = $("#seAutoPreStart").value;
  const preEnd = $("#seAutoPreEnd").value;
  const preSlots = parseInt($("#seAutoPreSlots").value) || 5;
  const liveStart = $("#seAutoLiveStart").value;
  const liveEnd = $("#seAutoLiveEnd").value;
  const liveSlots = parseInt($("#seAutoLiveSlots").value) || 7;
  const postStart = $("#seAutoPostStart").value;
  const postEnd = $("#seAutoPostEnd").value;
  const postSlots = parseInt($("#seAutoPostSlots").value) || 3;

  if (!liveStart) { alert("최소한 본 스케줄링 시작일(마켓 D-day)은 입력해야 함"); return; }

  const liveStartDate = new Date(liveStart);
  const existing = new Set(_se.schedule.map(d => d.date));
  const added = [];

  function addRange(start, end, kind, slotCount, stagePrefix) {
    if (!start) return;
    const s = new Date(start);
    const e = end ? new Date(end) : s;
    if (s > e) return;
    const cur = new Date(s);
    while (cur <= e) {
      const dateStr = ymdLocal(cur);
      if (!existing.has(dateStr)) {
        // D-N 계산 (마켓일 기준)
        const diff = Math.round((cur - liveStartDate) / (1000 * 60 * 60 * 24));
        let dayLabel = "";
        if (diff === 0) dayLabel = "D-Day";
        else if (diff < 0) dayLabel = `D-${Math.abs(diff)}`;
        else dayLabel = `D+${diff}`;

        const stories = [];
        for (let i = 0; i < slotCount; i++) {
          stories.push({
            slot: i + 1,
            label: DEFAULT_STORY_LABELS[i] || `STORY ${i + 1}`,
            caption: "",
            image_url: "",
          });
        }
        added.push(ensureStories({
          date: dateStr,
          day_label: dayLabel,
          kind: kind,
          is_new: false,
          stories: stories,
          feed_post: { label: "게시물 (피드)", caption: "", image_url: "" },
          notes: "",
        }));
        existing.add(dateStr);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  addRange(preStart, preEnd, "pre", preSlots, "사전");
  addRange(liveStart, liveEnd, "live", liveSlots, "라이브");
  if (postSlots > 0) addRange(postStart, postEnd, "post", postSlots, "사후");

  _se.schedule = [..._se.schedule, ...added];
  // 날짜순 정렬
  _se.schedule.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  renderScheduleEditor();
  alert(`${added.length}개 일자 추가됨. 슬롯 멘트는 "✨ 멘트 자동 생성" 으로 채워도 OK.`);
}

// ✨ Gemini 멘트 자동 생성 (한 일자)
async function generateCaptionsForDay(idx) {
  const day = _se.schedule[idx];
  if (!day) return;
  const cid = _se.campaignId;
  if (!cid) return;
  readScheduleEditor();
  const btn = document.querySelector(`[data-action="generate-captions"][data-idx="${idx}"]`);
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "✨ 생성 중…"; }
  try {
    const r = await api(`/api/campaigns/${cid}/generate_captions`, {
      method: "POST",
      body: JSON.stringify({ day_index: idx, day: day }),
    });
    if (r.day) {
      _se.schedule[idx] = r.day;
      renderScheduleEditor();
    }
    if (btn) btn.textContent = "✓ 완료";
  } catch (e) {
    alert("생성 실패: " + e.message);
    if (btn) btn.textContent = "❌ 실패";
  } finally {
    setTimeout(() => { if (btn) { btn.textContent = orig; btn.disabled = false; } }, 1500);
  }
}

// ✨ Gemini 전체 일자 멘트 자동 생성
async function generateAllCaptions() {
  if (!_se.schedule.length) { alert("일자가 없어. 먼저 자동 생성 또는 추가."); return; }
  if (!confirm(`${_se.schedule.length}개 일자의 슬롯 멘트를 Gemini로 자동 생성. 시간 좀 걸림 (일자당 약 10~20초). 진행?`)) return;
  readScheduleEditor();
  const cid = _se.campaignId;
  const btn = document.querySelector('[data-action="generate-all-captions"]');
  const orig = btn ? btn.textContent : "";
  for (let i = 0; i < _se.schedule.length; i++) {
    if (btn) btn.textContent = `✨ ${i+1}/${_se.schedule.length} 생성 중…`;
    try {
      const r = await api(`/api/campaigns/${cid}/generate_captions`, {
        method: "POST",
        body: JSON.stringify({ day_index: i, day: _se.schedule[i] }),
      });
      if (r.day) _se.schedule[i] = r.day;
      renderScheduleEditor();
    } catch (e) {
      console.error("caption gen failed for day", i, e);
    }
  }
  if (btn) btn.textContent = "✓ 완료";
  setTimeout(() => { if (btn) btn.textContent = orig; }, 2000);
}

function readScheduleEditor() {
  $$(".se-card", $("#seList")).forEach(card => {
    const i = +card.dataset.idx;
    const d = _se.schedule[i];
    if (!d) return;
    // 일자 헤더 필드 (date, day_label, kind, is_new, notes)
    $$('.se-card-head [data-f], .slot-notes[data-f]', card).forEach(el => {
      const key = el.dataset.f;
      if (el.type === "checkbox") d[key] = el.checked;
      else d[key] = el.value;
    });
    // notes (별도 위치)
    const notesEl = card.querySelector('.slot-notes[data-f="notes"]');
    if (notesEl) d.notes = notesEl.value;
    // 슬롯들
    ensureStories(d);
    $$('.slot-cell:not(.feed-cell)', card).forEach((sc, si) => {
      if (!d.stories[si]) return;
      $$('[data-sf]', sc).forEach(el => {
        d.stories[si][el.dataset.sf] = el.value;
      });
    });
    // 게시물
    const feed = card.querySelector('.feed-cell');
    if (feed) {
      $$('[data-ff]', feed).forEach(el => {
        d.feed_post[el.dataset.ff] = el.value;
      });
    }

    // title/subtitle 자동 — 첫 슬롯 기반 (호환)
    if (d.stories[0]) {
      d.title = d.day_label || d.title || `${d.date} 콘텐츠`;
      d.subtitle = d.stories[0].label || d.subtitle || "";
    }
  });
}

function renderFaqEditor() {
  const list = $("#faqList");
  if (!_se.faq.length) {
    list.innerHTML = `<div class="empty">아직 없음. [+ 항목 추가] 누르세요.</div>`;
    return;
  }
  list.innerHTML = _se.faq.map((f, i) => `
    <div class="se-card" data-idx="${i}">
      <div class="se-card-head">
        <span style="font-size:12px;color:var(--muted);font-weight:600">Q&amp;A #${i+1}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn-text" data-action="del-faq-item" data-idx="${i}">✕</button>
      </div>
      <input type="text" data-f="q" placeholder="질문 (예: 환불 문의 오면?)" value="${escapeHtml(f.q || "")}" />
      <textarea data-f="a" rows="3" placeholder="답변">${escapeHtml(f.a || "")}</textarea>
    </div>
  `).join("");
}

function readFaqEditor() {
  $$(".se-card", $("#faqList")).forEach(card => {
    const i = +card.dataset.idx;
    const f = _se.faq[i];
    $$('[data-f]', card).forEach(el => {
      f[el.dataset.f] = el.value;
    });
  });
}

// 핸들러
document.addEventListener("click", async (e) => {
  // 터널 토글 (셀러 공개 ON/OFF)
  if (e.target.closest('[data-action="toggle-tunnel"]')) {
    e.preventDefault(); e.stopPropagation();
    const btn = e.target.closest('[data-action="toggle-tunnel"]');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "처리 중…";
    try {
      if (_tunnel.running) {
        await api("/api/tunnel/stop", { method: "POST" });
      } else {
        const r = await api("/api/tunnel/start", { method: "POST" });
        if (!r.url) alert("터널 시작했는데 URL 못 받음. 잠시 후 다시 시도.");
      }
      await refreshTunnelStatus();
    } catch (err) {
      alert("터널 토글 실패: " + err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  // 셀러 slug 저장
  if (e.target.closest('[data-action="save-slug"]')) {
    e.preventDefault(); e.stopPropagation();
    const cid = $("#sellerLinkBox").dataset.cid;
    const slug = $("#sellerSlugInput").value.trim().toLowerCase().replace(/[^a-z0-9가-힣_-]/g, "-");
    if (!slug) { alert("슬러그를 입력하세요"); return; }
    try {
      const r = await api(`/api/campaigns/${cid}`, {
        method: "PATCH",
        body: JSON.stringify({ seller_slug: slug }),
      });
      $("#sellerLinkBox").dataset.token = r.campaign.seller_slug || r.campaign.seller_token;
      updateSellerLinkBox();
      await loadCampaigns();
      const btn = e.target.closest('[data-action="save-slug"]');
      btn.textContent = "✓ 저장됨";
      setTimeout(() => btn.textContent = "저장", 1500);
    } catch (err) { alert("저장 실패: " + err.message); }
    return;
  }
  // 셀러 링크 복사
  if (e.target.closest('[data-action="copy-seller-link"]')) {
    const url = $("#sellerLinkUrl").textContent;
    try {
      await navigator.clipboard.writeText(url);
      const btn = e.target.closest('[data-action="copy-seller-link"]');
      const orig = btn.textContent;
      btn.textContent = "✓ 복사됨";
      setTimeout(() => btn.textContent = orig, 1500);
    } catch (err) { alert("복사 실패: " + err.message); }
    return;
  }
  // 모바일 미리보기
  if (e.target.closest('[data-action="preview-seller-page"]')) {
    e.preventDefault(); e.stopPropagation();
    const token = $("#sellerLinkBox").dataset.token;
    // 캐시 깨기 위해 timestamp 박음 (변경사항 즉시 반영)
    $("#mpFrame").src = `/s/${token}?t=${Date.now()}`;
    $("#mobilePreviewDialog").showModal();
    return;
  }
  if (e.target.closest('[data-action="close-mobile-preview"]')) {
    e.preventDefault(); e.stopPropagation();
    forceCloseDialog("mobilePreviewDialog");
    $("#mpFrame").src = "about:blank";
    return;
  }
  // 시트에서 자동 가져오기
  if (e.target.closest('[data-action="import-from-sheet"]')) {
    e.preventDefault(); e.stopPropagation();
    const cid = $("#sellerLinkBox").dataset.cid;
    const btn = e.target.closest('[data-action="import-from-sheet"]');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "📥 가져오는 중…";
    try {
      const r = await api(`/api/campaigns/${cid}/import_sheet`, { method: "POST", body: "{}" });
      btn.textContent = `✓ ${r.imported}개 가져옴`;
      await loadCampaigns();
      // 셀러 박스에 다시 표시되게
      const updated = state.campaigns.find(c => c.id === cid);
      if (updated) {
        _se.schedule = JSON.parse(JSON.stringify(updated.daily_schedule || []));
      }
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    } catch (err) {
      btn.textContent = "❌ 실패";
      alert("가져오기 실패: " + err.message + "\n\n시트 공유 설정 확인:\n파일 → 공유 → '링크가 있는 모든 사람'으로 변경");
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    }
    return;
  }
  // 스케줄 편집
  if (e.target.closest('[data-action="edit-seller-schedule"]')) {
    e.preventDefault(); e.stopPropagation();
    renderScheduleEditor();
    $("#scheduleEditDialog").showModal();
    return;
  }
  if (e.target.closest('[data-action="close-schedule-edit"]')) {
    e.preventDefault(); e.stopPropagation();
    forceCloseDialog("scheduleEditDialog");
    return;
  }
  if (e.target.closest('[data-action="add-schedule-day"]')) {
    readScheduleEditor();
    _se.schedule.push(ensureStories({
      date: "", day_label: "", kind: "content", is_new: false,
      title: "", subtitle: "", notes: "",
    }));
    renderScheduleEditor();
    setTimeout(() => {
      const cards = $$(".se-card", $("#seList"));
      const last = cards[cards.length - 1];
      if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    return;
  }
  if (e.target.closest('[data-action="auto-generate-schedule"]')) {
    e.preventDefault(); e.stopPropagation();
    readScheduleEditor();
    autoGenerateSchedule();
    return;
  }
  if (e.target.closest('[data-action="generate-captions"]')) {
    e.preventDefault(); e.stopPropagation();
    const cardIdx = +e.target.closest('[data-action="generate-captions"]').dataset.idx;
    await generateCaptionsForDay(cardIdx);
    return;
  }
  if (e.target.closest('[data-action="generate-all-captions"]')) {
    e.preventDefault(); e.stopPropagation();
    await generateAllCaptions();
    return;
  }
  if (e.target.closest('[data-action="recommend-images"]')) {
    e.preventDefault(); e.stopPropagation();
    const btn = e.target.closest('[data-action="recommend-images"]');
    const orig = btn.textContent;
    btn.textContent = "🖼 추천 중…";
    btn.disabled = true;
    try {
      readScheduleEditor();
      // 먼저 현재 schedule 저장 (백엔드가 그걸 기반으로 추천)
      await api(`/api/campaigns/${_se.campaignId}`, { method: "PATCH", body: JSON.stringify({ daily_schedule: _se.schedule }) });
      const r = await api(`/api/campaigns/${_se.campaignId}/recommend_images`, { method: "POST", body: "{}" });
      if (r.campaign?.daily_schedule) {
        _se.schedule = r.campaign.daily_schedule;
        renderScheduleEditor();
      }
      alert(r.message || `${r.matched}개 슬롯 추천됨`);
    } catch (err) {
      alert("추천 실패: " + err.message);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
    return;
  }
  if (e.target.closest('[data-action="del-schedule-day"]')) {
    readScheduleEditor();
    const idx = +e.target.closest("[data-idx]").dataset.idx;
    _se.schedule.splice(idx, 1);
    renderScheduleEditor();
    return;
  }
  if (e.target.closest('[data-action="save-schedule"]')) {
    readScheduleEditor();
    try {
      await api(`/api/campaigns/${_se.campaignId}`, {
        method: "PATCH",
        body: JSON.stringify({ daily_schedule: _se.schedule }),
      });
      forceCloseDialog("scheduleEditDialog");
      await loadCampaigns();
    } catch (err) { alert("저장 실패: " + err.message); }
    return;
  }
  // FAQ 편집
  if (e.target.closest('[data-action="edit-seller-faq"]')) {
    e.preventDefault(); e.stopPropagation();
    renderFaqEditor();
    $("#faqEditDialog").showModal();
    return;
  }
  if (e.target.closest('[data-action="close-faq-edit"]')) {
    e.preventDefault(); e.stopPropagation();
    forceCloseDialog("faqEditDialog");
    return;
  }
  if (e.target.closest('[data-action="add-faq-item"]')) {
    readFaqEditor();
    _se.faq.push({ q: "", a: "" });
    renderFaqEditor();
    return;
  }
  if (e.target.closest('[data-action="del-faq-item"]')) {
    readFaqEditor();
    const idx = +e.target.closest("[data-idx]").dataset.idx;
    _se.faq.splice(idx, 1);
    renderFaqEditor();
    return;
  }
  if (e.target.closest('[data-action="save-faq"]')) {
    readFaqEditor();
    try {
      await api(`/api/campaigns/${_se.campaignId}`, {
        method: "PATCH",
        body: JSON.stringify({ faq: _se.faq }),
      });
      forceCloseDialog("faqEditDialog");
      await loadCampaigns();
    } catch (err) { alert("저장 실패: " + err.message); }
    return;
  }
});

// AI 채팅 위젯에서 데이터 변경 알림 받으면 해당 뷰 자동 새로고침
window.addEventListener("workspace-refresh", async (e) => {
  const kinds = (e.detail && e.detail.kinds) || [];
  console.log("[workspace-refresh]", kinds);
  if (kinds.includes("brands")) await loadBrands();
  if (kinds.includes("campaigns")) await loadCampaigns();
  if (kinds.includes("calendar")) await loadCalendar();
  if (kinds.includes("today")) await loadToday();
  if (kinds.includes("meetings")) await loadMeetings();
  if (kinds.includes("dashboard") && $("#tab-dashboard").classList.contains("active")) await loadDashboard();
});

// ═══════════════════════════════════════════════════════════
// CAMPAIGN CONTROL TOWER — 캠페인 단독 상세 페이지
// 격리된 namespace, 외부 의존 최소화
// ═══════════════════════════════════════════════════════════
const Tower = (function () {
  let activeCid = null;

  function open(cid) {
    const c = state.campaigns.find(x => x.id === cid);
    if (!c) return;
    activeCid = cid;
    document.getElementById("campListView").hidden = true;
    document.getElementById("campDetailView").hidden = false;
    render();
  }
  function close() {
    activeCid = null;
    document.getElementById("campListView").hidden = false;
    document.getElementById("campDetailView").hidden = true;
  }
  function getActive() {
    return state.campaigns.find(x => x.id === activeCid);
  }
  function isOpen() { return !!activeCid; }

  // 필드 row HTML (편집 가능)
  function field(label, fieldPath, value, opts) {
    opts = opts || {};
    const display = (value === null || value === undefined || value === "") ? "—" : String(value);
    const safeOptions = opts.options ? JSON.stringify(opts.options).replace(/"/g, "&quot;") : "";
    const type = opts.type || "text";
    const suffix = opts.suffix || "";
    return `
      <div class="tw-row">
        <div class="tw-row-label">${escapeHtml(label)}</div>
        <div class="tw-edit" data-tower-field="${escapeHtml(fieldPath)}" data-tower-type="${type}"${safeOptions ? ` data-tower-options="${safeOptions}"` : ""}>
          <span class="tw-row-value">${escapeHtml(display)}${value && suffix ? escapeHtml(suffix) : ""}</span>
        </div>
      </div>
    `;
  }

  function render() {
    const c = getActive();
    if (!c) { close(); return; }
    const root = document.getElementById("campDetailView");
    const b = state.brands.find(x => x.id === c.brand_id);
    const st = c.settlement || {};
    const sh = c.shipment || {};
    const reels = c.reels || { stage: "", notes: "" };
    const banner = c.banner || { stage: "", notes: "" };
    const plan = c.plan || { stage: "", notes: "" };

    // N차
    const others = state.campaigns.filter(x =>
      x.seller_name === c.seller_name && x.brand_id === c.brand_id
    ).sort((a, b) => (a.round || 0) - (b.round || 0));

    // 미팅
    const meetings = (state.meetings || []).filter(m => m.campaign_id === c.id)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 3);

    // 카톡 로그
    const kakaoLogs = (c.kakao_logs || []).slice(-3).reverse();

    // 진행률
    const sched = c.daily_schedule || [];
    const totalSlots = sched.reduce((s, d) => s + ((d.stories || []).length), 0);
    const filledSlots = sched.reduce((s, d) => s + ((d.stories || []).filter(x => x.caption).length), 0);
    const progressPct = totalSlots ? Math.round(filledSlots / totalSlots * 100) : 0;

    const sellerUrl = (typeof _tunnel !== "undefined" && _tunnel.url ? _tunnel.url : window.location.origin) +
                      "/s/" + (c.seller_slug || c.seller_token || c.id);

    const roundOptions = others.length > 1
      ? `<select class="tw-round-switch" id="twRoundSel">
          ${others.map(o => `<option value="${escapeHtml(o.id)}" ${o.id === c.id ? "selected" : ""}>${o.round}차 (${escapeHtml(o.status || "")})</option>`).join("")}
        </select>` : "";

    const brandOpts = state.brands.map(b => ({ value: b.id, label: b.name }));
    const stageOpts = [
      { value: "contact", label: "컨택" },
      { value: "confirmed", label: "셀러 컨펌" },
      { value: "shipped", label: "제품 발송" },
      { value: "received", label: "수령 확인" },
      { value: "sheet_drafted", label: "시트 작성" },
      { value: "sheet_confirmed", label: "시트 컨펌" },
      { value: "live", label: "라이브" },
      { value: "complete", label: "완료" },
    ];

    root.innerHTML = `
      <div class="tw-topbar">
        <button type="button" class="btn-text" data-tower="back">← 캠페인 목록</button>
        <span style="flex:1"></span>
        <button type="button" class="btn-secondary" data-tower="full-edit">📝 전체 필드 편집</button>
      </div>

      <div class="tw-hero">
        <div class="tw-hero-row">
          <span class="tw-brand">${b ? (b.emoji || "🏷") + " " + escapeHtml(b.name) : escapeHtml(c.brand || "")}</span>
          <span class="status-chip st-${escapeHtml(c.status || "")}">${escapeHtml(c.status || "")}</span>
          ${roundOptions}
        </div>
        <h1 class="tw-title">${escapeHtml(c.seller_name || "")} ${c.round || 1}차 공구</h1>
        <div class="tw-sub">
          <span>📅 ${escapeHtml(c.live_start || "미정")} ~ ${escapeHtml(c.live_end || "미정")}</span>
          ${c.open_kind ? `<span>· ${escapeHtml(c.open_kind)}</span>` : ""}
          <span>· 단계: ${escapeHtml((STAGE_LABEL && STAGE_LABEL[c.stage]) || c.stage || "—")}</span>
        </div>
      </div>

      <div class="tw-grid">
        <div class="tw-col">
          <section class="panel">
            <div class="panel-head"><h2>👤 셀러 정보</h2></div>
            <div class="tw-fields">
              ${field("이름", "seller_name", c.seller_name)}
              ${field("인스타", "seller_handle", c.seller_handle)}
              ${field("실명", "seller_real_name", c.seller_real_name)}
              ${field("담당자", "owner", c.owner)}
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>💰 정산 조건</h2></div>
            <div class="tw-fields">
              ${field("RS %", "settlement.rs_percent", st.rs_percent, { suffix: "%", type: "number" })}
              ${field("유형", "settlement.type", st.type, { options: ["사업자", "프리랜서"] })}
              ${field("PG/배송비", "settlement.pg_logistics", st.pg_logistics)}
              ${field("발송 수량", "shipment.qty", sh.qty, { suffix: "개", type: "number" })}
              ${field("발송일", "shipment.date", sh.date, { type: "date" })}
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>🎤 미팅 / 녹취</h2>
              <span class="hint">${meetings.length}개</span>
            </div>
            <div class="tw-meetings">
              ${meetings.length === 0 ? `<div class="empty" style="padding:14px;font-size:12px">아직 미팅 없음</div>` :
                meetings.map(m => `
                  <div class="tw-meeting-row" data-tower="meeting" data-mid="${escapeHtml(m.id)}">
                    <div class="tw-meeting-date">${escapeHtml(m.date || "—")}</div>
                    <div class="tw-meeting-title">${escapeHtml(m.title || "")}</div>
                    ${m.summary ? `<div class="tw-meeting-summary">${escapeHtml(String(m.summary).slice(0, 80))}${m.summary.length > 80 ? "..." : ""}</div>` : ""}
                  </div>
                `).join("")
              }
              <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" class="btn-secondary" data-tower="add-meeting">+ 미팅 추가</button>
                <label class="btn-secondary" style="cursor:pointer">
                  📎 카톡 txt 업로드
                  <input type="file" id="twKakaoIn" accept=".txt" hidden />
                </label>
              </div>
            </div>
          </section>

          ${kakaoLogs.length ? `
          <section class="panel">
            <div class="panel-head"><h2>💬 카톡 분석 흐름</h2><span class="hint">${kakaoLogs.length}건</span></div>
            <div class="tw-kakao">
              ${kakaoLogs.map(k => `
                <div class="tw-kakao-row">
                  <div class="tw-kakao-meta">📎 ${escapeHtml(k.filename || "")} · ${escapeHtml((k.uploaded_at || "").slice(0, 16))}</div>
                  ${k.summary ? `<div class="tw-kakao-sum">${escapeHtml(k.summary)}</div>` : ""}
                  ${k.action_items && k.action_items.length ? `
                    <div class="tw-kakao-actions">
                      <b>액션:</b> ${k.action_items.map(a => escapeHtml(`${a.who || ""}: ${a.what || ""}`)).join(" · ")}
                    </div>` : ""}
                </div>
              `).join("")}
            </div>
          </section>
          ` : ""}
        </div>

        <div class="tw-col">
          <section class="panel">
            <div class="panel-head"><h2>🎛 마켓 준비 대시보드</h2></div>
            <div class="tw-cards">
              <div class="tw-card" data-tower="schedule">
                <div class="tw-card-icon">📅</div>
                <div class="tw-card-title">스케줄링</div>
                <div class="tw-card-stat">${sched.length}일 · ${filledSlots}/${totalSlots} 멘트</div>
                <div class="tw-card-prog"><span style="width:${progressPct}%"></span></div>
              </div>
              <div class="tw-card" data-tower="asset" data-asset="reels">
                <div class="tw-card-icon">🎬</div>
                <div class="tw-card-title">릴스 기획</div>
                <div class="tw-card-stat">${escapeHtml(reels.stage || "미정")}</div>
                <div class="tw-card-sub">${escapeHtml(String(reels.notes || "").slice(0, 40))}</div>
              </div>
              <div class="tw-card" data-tower="asset" data-asset="banner">
                <div class="tw-card-icon">🎨</div>
                <div class="tw-card-title">배너</div>
                <div class="tw-card-stat">${escapeHtml(banner.stage || "미정")}</div>
                <div class="tw-card-sub">${escapeHtml(String(banner.notes || "").slice(0, 40))}</div>
              </div>
              <div class="tw-card" data-tower="asset" data-asset="plan">
                <div class="tw-card-icon">📋</div>
                <div class="tw-card-title">기획안</div>
                <div class="tw-card-stat">${escapeHtml(plan.stage || "미정")}</div>
                <div class="tw-card-sub">${escapeHtml(String(plan.notes || "").slice(0, 40))}</div>
              </div>
              <div class="tw-card" data-tower="faq">
                <div class="tw-card-icon">💬</div>
                <div class="tw-card-title">무물 가이드</div>
                <div class="tw-card-stat">${(c.faq || []).length}개 Q&amp;A</div>
              </div>
              <div class="tw-card tw-card-seller" data-tower="preview">
                <div class="tw-card-icon">📱</div>
                <div class="tw-card-title">셀러 페이지</div>
                <div class="tw-card-stat">${(typeof _tunnel !== "undefined" && _tunnel.running) ? "🌐 공개 (외부 OK)" : "🔒 비공개 (내 PC만)"}</div>
                <div class="tw-card-sub" style="word-break:break-all;font-size:9.5px">${escapeHtml(sellerUrl)}</div>
                <div class="tw-card-actions" onclick="event.stopPropagation()">
                  <button type="button" class="tw-mini-btn" data-tower-mini="copy-url">🔗 복사</button>
                  <button type="button" class="tw-mini-btn" data-tower-mini="toggle-tunnel">${(typeof _tunnel !== "undefined" && _tunnel.running) ? "비공개로" : "외부 공개"}</button>
                  <button type="button" class="tw-mini-btn" data-tower-mini="open-new">↗ 새 창</button>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>📋 캠페인 정보</h2></div>
            <div class="tw-fields">
              ${field("브랜드", "brand_id", c.brand_id, { options: brandOpts })}
              ${field("제품", "product", c.product)}
              ${field("차수", "round", c.round, { suffix: "차", type: "number" })}
              ${field("라이브 시작", "live_start", c.live_start, { type: "date" })}
              ${field("라이브 종료", "live_end", c.live_end, { type: "date" })}
              ${field("오픈", "open_kind", c.open_kind, { options: ["본사오픈", "타사오픈"] })}
              ${field("단계", "stage", c.stage, { options: stageOpts })}
              ${field("상태", "status", c.status, { options: ["예정", "준비중", "진행중", "완료", "미정"] })}
              ${field("시트 URL", "sheet_url", c.sheet_url)}
              ${field("노트", "notes", c.notes, { type: "textarea" })}
            </div>
          </section>
        </div>
      </div>
    `;

    bindEvents(root);
  }

  function bindEvents(root) {
    // N차 스위치
    const sw = root.querySelector("#twRoundSel");
    if (sw) {
      sw.addEventListener("change", () => {
        if (sw.value !== activeCid) open(sw.value);
      });
    }
    // 카톡 업로드
    const kIn = root.querySelector("#twKakaoIn");
    if (kIn) {
      kIn.addEventListener("change", async () => {
        const f = kIn.files && kIn.files[0];
        if (!f) return;
        if (!confirm(`${f.name} 카톡 분석 (30초~1분). 진행?`)) return;
        await uploadKakao(f);
      });
    }
    // 클릭 이벤트
    root.addEventListener("click", onClick);
  }

  async function onClick(e) {
    // 미니 버튼 (URL 복사 / Tunnel 토글 / 새 창)
    const miniBtn = e.target.closest("[data-tower-mini]");
    if (miniBtn) {
      e.stopPropagation();
      const what = miniBtn.dataset.towerMini;
      const c = getActive();
      if (!c) return;
      const token = c.seller_slug || c.seller_token || c.id;
      const url = (typeof _tunnel !== "undefined" && _tunnel.url ? _tunnel.url : window.location.origin) + "/s/" + token;
      if (what === "copy-url") {
        try {
          await navigator.clipboard.writeText(url);
          miniBtn.textContent = "✓ 복사됨";
          setTimeout(() => { miniBtn.textContent = "🔗 복사"; }, 1500);
        } catch { alert("복사 실패"); }
        return;
      }
      if (what === "open-new") {
        window.open(url, "_blank");
        return;
      }
      if (what === "toggle-tunnel") {
        const orig = miniBtn.textContent;
        miniBtn.disabled = true;
        miniBtn.textContent = "처리 중…";
        try {
          if (_tunnel.running) await api("/api/tunnel/stop", { method: "POST" });
          else await api("/api/tunnel/start", { method: "POST" });
          await refreshTunnelStatus();
          render();
        } catch (err) { alert("실패: " + err.message); }
        miniBtn.disabled = false;
        return;
      }
    }

    const action = e.target.closest("[data-tower]");
    if (action) {
      const what = action.dataset.tower;
      if (what === "back") return close();
      if (what === "full-edit") {
        const c = getActive();
        if (c && typeof showCampaignDialog === "function") showCampaignDialog(c);
        return;
      }
      if (what === "schedule") return openScheduleEdit();
      if (what === "faq") return openFaqEdit();
      if (what === "preview") return openPreview();
      if (what === "asset") return openAssetPrompt(action.dataset.asset);
      if (what === "meeting") {
        if (typeof showMeetingDetail === "function") showMeetingDetail(action.dataset.mid);
        return;
      }
      if (what === "add-meeting") {
        const c = getActive();
        if (c && typeof showMeetingDialog === "function") {
          showMeetingDialog({ campaign_id: c.id, title: `${c.seller_name} ${c.round}차 미팅`, date: "", time: "" });
        }
        return;
      }
    }
    // 인라인 편집
    const cell = e.target.closest(".tw-edit[data-tower-field]");
    if (cell && !cell.classList.contains("editing")) {
      startEdit(cell);
    }
  }

  function openScheduleEdit() {
    const c = getActive();
    if (!c) return;
    if (typeof _se !== "undefined") {
      _se.campaignId = c.id;
      _se.schedule = JSON.parse(JSON.stringify(c.daily_schedule || []));
      _se.faq = JSON.parse(JSON.stringify(c.faq || []));
      const box = document.getElementById("sellerLinkBox");
      if (box) box.dataset.cid = c.id;
      if (typeof renderScheduleEditor === "function") renderScheduleEditor();
      const dlg = document.getElementById("scheduleEditDialog");
      if (dlg) dlg.showModal();
    }
  }
  function openFaqEdit() {
    const c = getActive();
    if (!c) return;
    if (typeof _se !== "undefined") {
      _se.campaignId = c.id;
      _se.faq = JSON.parse(JSON.stringify(c.faq || []));
      if (typeof renderFaqEditor === "function") renderFaqEditor();
      const dlg = document.getElementById("faqEditDialog");
      if (dlg) dlg.showModal();
    }
  }
  function openPreview() {
    const c = getActive();
    if (!c) return;
    const token = c.seller_slug || c.seller_token || c.id;
    const fr = document.getElementById("mpFrame");
    if (fr) fr.src = `/s/${token}?t=${Date.now()}`;
    const dlg = document.getElementById("mobilePreviewDialog");
    if (dlg) dlg.showModal();
  }
  function openAssetPrompt(asset) {
    const c = getActive();
    if (!c) return;
    const labels = { reels: "🎬 릴스 기획", banner: "🎨 배너", plan: "📋 기획안" };
    const cur = c[asset] || { stage: "", notes: "" };
    const stage = prompt(`${labels[asset] || asset} — 단계 (예: 기획중 / 촬영 / 편집 / 시안1 / 완료)`, cur.stage || "");
    if (stage === null) return;
    const notes = prompt(`${labels[asset] || asset} — 메모`, cur.notes || "");
    if (notes === null) return;
    api(`/api/campaigns/${c.id}`, {
      method: "PATCH",
      body: JSON.stringify({ [asset]: { stage, notes } }),
    }).then(() => loadCampaigns()).then(render)
      .catch(err => alert("저장 실패: " + err.message));
  }

  function startEdit(cell) {
    if (cell.classList.contains("editing")) return;
    const fieldPath = cell.dataset.towerField;
    const type = cell.dataset.towerType || "text";
    let optsRaw = cell.dataset.towerOptions;
    let opts = null;
    if (optsRaw) {
      try { opts = JSON.parse(optsRaw); } catch (e) { console.warn("[Tower] options parse", e); }
    }
    const c = getActive();
    if (!c) return;
    const parts = fieldPath.split(".");
    let val;
    if (parts.length === 2) val = (c[parts[0]] || {})[parts[1]];
    else val = c[fieldPath];

    cell.classList.add("editing");
    let input;
    if (opts) {
      input = document.createElement("select");
      input.innerHTML = `<option value="">(선택 안 함)</option>` + opts.map(o => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return `<option value="${escapeHtml(v)}" ${val === v ? "selected" : ""}>${escapeHtml(l)}</option>`;
      }).join("");
    } else if (type === "textarea") {
      input = document.createElement("textarea");
      input.rows = 3;
      input.value = val || "";
    } else {
      input = document.createElement("input");
      input.type = type === "number" ? "number" : (type === "date" ? "date" : "text");
      input.value = val || "";
    }
    input.className = "tw-input";
    cell.innerHTML = "";
    cell.appendChild(input);
    input.focus();
    if (input.select) try { input.select(); } catch {}

    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const newVal = input.value;
      cell.classList.remove("editing");
      let payload;
      if (parts.length === 2) {
        payload = { [parts[0]]: { ...(c[parts[0]] || {}), [parts[1]]: newVal } };
      } else {
        payload = { [fieldPath]: newVal };
      }
      try {
        await api(`/api/campaigns/${c.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        await loadCampaigns();
        render();
      } catch (err) {
        alert("저장 실패: " + err.message);
        render();
      }
    };
    const cancel = () => {
      if (done) return; done = true;
      cell.classList.remove("editing");
      render();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && input.tagName !== "TEXTAREA") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
  }

  async function uploadKakao(file) {
    const c = getActive();
    if (!c) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`/api/campaigns/${c.id}/kakao_log`, { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      alert("✓ 분석 완료: " + (data.summary || "").slice(0, 200));
      await loadCampaigns();
      render();
    } catch (e) {
      alert("실패: " + e.message);
    }
  }

  return { open, close, render, isOpen };
})();

// init
(async function init() {
  // 페이지 로드 시 모든 dialog 강제 닫기 (잔여 방지)
  try {
    document.querySelectorAll("dialog").forEach(d => {
      try { d.close(); } catch {}
      d.removeAttribute("open");
    });
  } catch (e) { console.warn("[init] dialog cleanup", e); }

  await loadHolidays();
  await loadBrands();
  refreshConfigStatus();
  refreshTunnelStatus();
  await loadCampaigns();
  await loadCalendar();
  loadSellers();
  loadToday();
})();
setInterval(refreshConfigStatus, 30000);
setInterval(loadSellers, 60000);
setInterval(loadToday, 120000);
