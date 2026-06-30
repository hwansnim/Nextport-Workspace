/*
 * 콘텐츠 스튜디오 — 레퍼런스 분석 + 기획안 생성 (AI Studio 원본 UX 이식, 서버사이드 Gemini).
 * 전체화면 드롭 · 진행률 · 분석|기획안 2-pane · 수동수정/노션복사/나레이션·자막 복사 · TIME seek · 제품정보 등록.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const state = { projects: [], active: 0, products: [], product: { name: "", features: "" }, edit: { analysis: false, plan: false } };

  function init() {
    // 워크스페이스 드롭다운
    const wb = $("wsBrand"), wd = $("wsDropdown");
    if (wb && wd) {
      wb.addEventListener("click", (e) => { if (e.target.closest(".ws-dd-item")) return; e.stopPropagation(); wd.hidden = !wd.hidden; });
      document.addEventListener("click", () => { wd.hidden = true; });
    }
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.addEventListener("click", () => switchPane(b.dataset.pane)));

    // 전체화면 드롭
    let depth = 0;
    const fs = $("fsDrop");
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; fs.classList.add("show"); } });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("dragleave", () => { depth--; if (depth <= 0) { depth = 0; fs.classList.remove("show"); } });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; fs.classList.remove("show");
      const vids = [...e.dataTransfer.files].filter((f) => f.type.startsWith("video/"));
      if (vids.length) { switchPane("studio"); handleVideos(vids); }
    });

    $("videoFile").addEventListener("change", (e) => { handleVideos([...e.target.files]); e.target.value = ""; });
    $("vidBox").addEventListener("click", () => { if (!activeProj()) $("videoFile").click(); });
    $("genPlanBtn").addEventListener("click", genPlan);

    // 제품 입력/선택
    $("prodName").addEventListener("input", (e) => { state.product.name = e.target.value; refreshGen(); });
    $("prodFeatures").addEventListener("input", (e) => { state.product.features = e.target.value; });
    $("prodPick").addEventListener("change", (e) => pickProduct(e.target.value));
    $("uspUrlBtn").addEventListener("click", () => extractUrl($("uspUrl").value.trim()));
    $("uspUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") extractUrl($("uspUrl").value.trim()); });
    $("uspFileBtn").addEventListener("click", () => $("uspFile").click());
    $("uspFile").addEventListener("change", () => { if ($("uspFile").files[0]) extractFile($("uspFile").files[0]); $("uspFile").value = ""; });

    // 제품 정보 등록
    $("pfSave").addEventListener("click", saveProduct);
    $("pfReset").addEventListener("click", resetProductForm);

    loadProducts();
    renderStudio();
  }

  function switchPane(name) {
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
    document.querySelectorAll(".cw-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    if (name === "products") loadProducts();
  }

  function activeProj() { return state.projects[state.active]; }

  /* ─── 영상 → 프로젝트 + 병렬 분석 ─── */
  function handleVideos(files) {
    files.filter((f) => f.type.startsWith("video/")).forEach((file) => {
      const proj = { id: Math.random().toString(36).slice(2), name: "기획안 " + String.fromCharCode(65 + state.projects.length), file, url: URL.createObjectURL(file), analysis: [], plan: [], status: "analyzing", progress: 0, error: "", timer: null };
      state.projects.push(proj);
      state.active = state.projects.length - 1;
      analyzeProject(proj);
    });
    renderStudio();
  }

  function simProgress(proj, to, ms) {
    clearInterval(proj.timer);
    const step = 150, inc = (to - proj.progress) / (ms / step);
    proj.timer = setInterval(() => {
      proj.progress = Math.min(to, proj.progress + inc + Math.random() * 0.6);
      if (proj.progress >= to) { proj.progress = to; clearInterval(proj.timer); }
      if (proj === activeProj()) renderAnalyzePane();
      renderProjTabs();
    }, step);
  }

  async function analyzeProject(proj, feedback) {
    proj.status = "analyzing"; proj.error = ""; proj.progress = 0;
    renderProjTabs(); renderAnalyzePane();
    simProgress(proj, 95, 25000);
    try {
      const fd = new FormData();
      fd.append("video", proj.file, proj.file.name);
      if (feedback) fd.append("feedback", feedback);
      const r = await fetch("/api/content/analyze", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "분석 실패");
      proj.analysis = j.analysis || [];
      proj.status = "analyzed"; proj.progress = 100;
    } catch (e) {
      proj.status = "idle"; proj.error = e.message; proj.progress = 0;
    }
    clearInterval(proj.timer);
    renderProjTabs(); if (proj === activeProj()) { renderAnalyzePane(); refreshGen(); }
  }

  function renderProjTabs() {
    const root = $("projTabs");
    if (!state.projects.length) { root.innerHTML = ""; return; }
    root.innerHTML = state.projects.map((p, i) => {
      const working = p.status === "analyzing" || p.status === "planning";
      const dot = working ? "working" : (p.status === "analyzed" || p.plan.length ? "done" : "");
      const pct = working ? ` <span class="cw-proj-pct">(${Math.floor(p.progress)}%)</span>` : "";
      return `<div class="cw-proj ${i === state.active ? "active" : ""} ${working ? "working" : ""}" data-i="${i}">
        <span class="cw-proj-dot ${dot}"></span><span>${esc(p.name)}</span>${pct}
        <button class="cw-proj-x" data-del="${i}" title="삭제">×</button></div>`;
    }).join("") + `<button class="cw-proj-add" id="projAdd" title="영상 추가">+</button>`;
    root.querySelectorAll(".cw-proj").forEach((el) => el.addEventListener("click", (e) => { if (e.target.dataset.del != null) return; state.active = +el.dataset.i; renderStudio(); }));
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); delProject(+b.dataset.del); }));
    $("projAdd")?.addEventListener("click", () => $("videoFile").click());
  }

  function delProject(i) {
    if (!confirm("이 기획안을 삭제할까요?")) return;
    clearInterval(state.projects[i]?.timer);
    state.projects.splice(i, 1);
    state.active = Math.max(0, Math.min(state.active, state.projects.length - 1));
    renderStudio();
  }

  /* ─── 스튜디오 렌더 ─── */
  function renderStudio() {
    const p = activeProj();
    const vb = $("vidBox"), ve = $("vidEmpty");
    if (p && p.url) {
      vb.innerHTML = `<video src="${esc(p.url)}" id="refVideo" controls playsinline></video>`;
    } else {
      vb.innerHTML = `<div class="cw-vid-empty">레퍼런스 영상을<br>드래그하세요</div>`;
    }
    renderProjTabs(); renderAnalyzePane(); renderPlanPane(); refreshGen();
  }

  /* ─── 공용 표 (분석/기획안) ─── */
  function dataTable(kind, rows) {
    const editing = state.edit[kind];
    const isAnalysis = kind === "analysis";
    const cols = isAnalysis
      ? [["timestamp", "TIME", "cw-ts"], ["narration", "나레이션", "cw-narr"], ["caption", "자막", "cw-cap"], ["visual", "연출", "cw-dir"]]
      : [["narration", "신규 나레이션", "cw-narr"], ["caption", "신규 자막", "cw-cap"], ["direction", "연출", "cw-dir"]];
    const th = `<th class="cw-no">NO</th>` + cols.map(([f, label]) => `<th${f === "timestamp" ? ' class="cw-ts"' : ""}>${label}</th>`).join("");
    const trs = rows.map((a, i) => {
      const cells = cols.map(([f, label, cls]) => {
        if (editing) return `<td class="${cls}"><textarea class="cw-cell-edit" data-kind="${kind}" data-i="${i}" data-f="${f}">${esc(a[f])}</textarea></td>`;
        if (f === "timestamp") return `<td class="cw-ts" data-seek="${esc(a[f])}" title="클릭하면 그 지점 재생">${esc(a[f])}</td>`;
        return `<td class="${cls}">${esc(a[f])}</td>`;
      }).join("");
      return `<tr><td class="cw-no">${esc(a.no)}</td>${cells}</tr>`;
    }).join("");
    return `<table class="cw-tbl cw-${kind}-tbl"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  function toolbar(kind) {
    const editing = state.edit[kind];
    return `<div class="cw-tb-actions">
      <button class="cw-tb-btn" data-tb="edit" data-kind="${kind}">${editing ? "💾 변경사항 저장" : "✏️ 분석 결과 수동 수정"}</button>
      ${editing ? "" : `<button class="cw-tb-btn" data-tb="notion" data-kind="${kind}">📋 노션용 데이터 복사</button>
      <button class="cw-tb-btn" data-tb="narr" data-kind="${kind}">나레이션 복사</button>
      <button class="cw-tb-btn" data-tb="cap" data-kind="${kind}">자막 복사</button>`}
    </div>`;
  }

  function wireTable(scope, kind, rows) {
    scope.querySelectorAll(".cw-cell-edit").forEach((ta) => ta.addEventListener("blur", () => { rows[+ta.dataset.i][ta.dataset.f] = ta.value; }));
    scope.querySelectorAll("[data-seek]").forEach((td) => td.addEventListener("click", () => seekVideo(td.dataset.seek)));
    scope.querySelectorAll("[data-tb]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.kind;
      if (b.dataset.tb === "edit") {
        if (state.edit[k]) scope.querySelectorAll(".cw-cell-edit").forEach((ta) => { rows[+ta.dataset.i][ta.dataset.f] = ta.value; });
        state.edit[k] = !state.edit[k]; (k === "analysis" ? renderAnalyzePane() : renderPlanPane());
      } else if (b.dataset.tb === "notion") copyNotion(rows, kind);
      else if (b.dataset.tb === "narr") copyCol(rows, "narration", "나레이션");
      else if (b.dataset.tb === "cap") copyCol(rows, "caption", "자막");
    }));
  }

  /* ─── 분석 pane ─── */
  function renderAnalyzePane() {
    const root = $("analyzeWrap"), p = activeProj();
    if (!p) {
      root.innerHTML = `<div class="cw-drop" id="dropInline"><div class="cw-drop-ico">🎞️</div><div><b>분석할 레퍼런스 영상</b>을 화면 어디든 끌어다 놓으세요</div><button class="btn-primary" id="dropPick" style="margin-top:14px">파일 선택하기</button></div>`;
      $("dropPick").addEventListener("click", () => $("videoFile").click());
      return;
    }
    if (p.status === "analyzing") { root.innerHTML = progressCard(p.progress, "분석 중...", "데이터를 추출하는 중입니다"); return; }
    if (p.error) { root.innerHTML = `<div class="cw-sp-head"><span class="cw-dot"></span> 분석 결과</div><div class="empty" style="color:#e0245e">❌ ${esc(p.error)}</div>`; return; }
    root.innerHTML = `<div class="cw-sp-head"><span class="cw-dot"></span> 분석 결과 ${toolbar("analysis")}</div>
      <div class="cw-sp-body">${dataTable("analysis", p.analysis)}</div>
      <div class="cw-rebox">
        <div class="cw-rebox-h">🔄 데이터 재분석 요청 <span class="hint">AI 추출에 문제 있으면 피드백 주세요</span></div>
        <div class="cw-rebox-row"><textarea id="reInput" rows="2" placeholder="예: '나레이션과 자막이 바뀌었어', '고정배너를 자막이랑 분리해줘'"></textarea>
        <button class="cw-rebtn" id="reBtn">재분석 실행</button></div>
      </div>`;
    wireTable(root, "analysis", p.analysis);
    $("reBtn").addEventListener("click", () => { if (p.file) analyzeProject(p, $("reInput").value.trim()); });
  }

  /* ─── 기획안 pane ─── */
  function renderPlanPane() {
    const root = $("planWrap"), p = activeProj();
    if (!p || (!p.plan.length && p.status !== "planning")) {
      root.innerHTML = `<div class="empty cw-plan-empty">기획안 생성 대기 중<br><span class="hint">제품 정보 입력 후 좌측 [신규 기획안 생성]</span></div>`;
      return;
    }
    if (p.status === "planning") { root.innerHTML = progressCard(p.progress, "기획안 생성 중...", "레퍼런스 구조에 제품을 입히는 중"); return; }
    root.innerHTML = `<div class="cw-sp-head"><span class="cw-dot done"></span> 신규 기획안 ${toolbar("plan")}</div>
      <div class="cw-sp-body">${dataTable("plan", p.plan)}</div>
      <div class="cw-rebox">
        <div class="cw-rebox-h">✍️ 기획안 수정 요청</div>
        <div class="cw-rebox-row"><textarea id="refineInput" rows="2" placeholder="예: 더 신뢰감 있는 톤으로, 첫 3초 강하게"></textarea>
        <button class="cw-rebtn cw-rebtn-blue" id="refineBtn">수정 반영</button></div>
      </div>`;
    wireTable(root, "plan", p.plan);
    $("refineBtn").addEventListener("click", () => refine($("refineInput").value.trim()));
  }

  function progressCard(pct, title, sub) {
    const deg = Math.round((pct / 100) * 360);
    return `<div class="cw-prog"><div class="cw-prog-ring" style="background:conic-gradient(var(--accent) ${deg}deg, #eef0f3 0)"><div class="cw-prog-inner"><b>${Math.floor(pct)}%</b><span>ANALYSING</span></div></div>
      <div class="cw-prog-title">${title}</div><div class="hint">${sub}</div>
      <div class="cw-prog-bar"><span style="width:${pct}%"></span></div></div>`;
  }

  function seekVideo(ts) {
    const v = $("refVideo"); if (!v || !ts) return;
    const m = ts.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return;
    const sec = m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
    if (!isNaN(sec)) { v.currentTime = Math.max(0, sec); v.play().catch(() => {}); }
  }

  /* ─── 복사 ─── */
  function copyCol(rows, field, label) {
    const text = rows.map((a) => a[field]).filter((t) => t && t.trim()).join("\n");
    navigator.clipboard.writeText(text).then(() => toast(`${label} 복사됨`));
  }
  async function copyNotion(rows, kind) {
    const fields = kind === "analysis" ? ["narration", "caption", "visual"] : ["narration", "caption", "direction"];
    const tr = rows.map((e) => `<tr>` + fields.map((f) => `<td style="border:1px solid #eeeeee;padding:8px;color:#ff0000;">${esc(e[f]).replace(/\n/g, "<br>")}</td>`).join("") + `</tr>`).join("");
    const html = `<table style="border-collapse:collapse;width:100%;font-family:sans-serif;">${tr}</table>`;
    const plain = rows.map((e) => fields.map((f) => e[f]).join("\t")).join("\n");
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      toast("노션용(빨간 글씨)으로 복사됨");
    } catch (e) { navigator.clipboard.writeText(plain); toast("텍스트로 복사됨"); }
  }

  /* ─── 제품 선택/추출 ─── */
  function refreshGen() {
    const p = activeProj();
    const ready = p && p.analysis.length > 0 && state.product.name.trim();
    $("genPlanBtn").disabled = !ready;
  }
  function pickProduct(id) {
    const prod = state.products.find((x) => x.id === id);
    if (!prod) return;
    state.product.name = prod.product || prod.brand || "";
    state.product.features = [prod.usp, prod.notes ? "[특이사항] " + prod.notes : ""].filter(Boolean).join("\n");
    $("prodName").value = state.product.name; $("prodFeatures").value = state.product.features;
    refreshGen();
  }
  async function extractUrl(url) {
    if (!url || !url.startsWith("http")) { alert("URL을 입력하세요."); return; }
    uspBusy(true);
    try { const r = await fetch("/api/content/usp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); applyProduct(j.product); $("uspUrl").value = ""; }
    catch (e) { alert(e.message || "추출 실패"); } finally { uspBusy(false); }
  }
  async function extractFile(file) {
    uspBusy(true);
    try { const fd = new FormData(); fd.append("file", file, file.name); const r = await fetch("/api/content/usp", { method: "POST", body: fd }); const j = await r.json(); if (!r.ok) throw new Error(j.error); applyProduct(j.product); }
    catch (e) { alert(e.message || "추출 실패"); } finally { uspBusy(false); }
  }
  function applyProduct(prod) {
    if (!prod) return;
    state.product.name = prod.name || ""; state.product.features = prod.features || "";
    $("prodName").value = state.product.name; $("prodFeatures").value = state.product.features; refreshGen();
  }
  function uspBusy(b) { $("uspStatus").textContent = b ? "분석 중…" : ""; $("uspUrlBtn").disabled = b; $("uspFileBtn").disabled = b; }

  /* ─── 기획안 생성/수정 ─── */
  async function genPlan() {
    const p = activeProj(); if (!p || !p.analysis.length || !state.product.name.trim()) return;
    p.status = "planning"; p.progress = 0; renderProjTabs(); renderPlanPane(); simProgress(p, 95, 12000);
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "생성 실패");
      p.plan = j.plan || []; p.status = "analyzed"; p.progress = 100;
    } catch (e) { p.status = "analyzed"; alert(e.message); }
    clearInterval(p.timer); renderProjTabs(); renderPlanPane();
  }
  async function refine(feedback) {
    const p = activeProj(); if (!p || !feedback) return;
    $("refineBtn").disabled = true; $("refineBtn").textContent = "반영 중…";
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product, feedback }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); p.plan = j.plan || []; renderPlanPane();
    } catch (e) { alert(e.message); $("refineBtn").disabled = false; $("refineBtn").textContent = "수정 반영"; }
  }

  /* ─── 제품 정보 등록 ─── */
  async function loadProducts() {
    try { const r = await fetch("/api/content/products"); const j = await r.json(); state.products = j.products || []; renderProducts(); renderProdPicker(); }
    catch (e) {}
  }
  function renderProdPicker() {
    const sel = $("prodPick"); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">— 등록된 제품 선택 (또는 직접 입력) —</option>` +
      state.products.map((p) => `<option value="${p.id}">${esc(p.brand ? p.brand + " · " : "")}${esc(p.product || "")}</option>`).join("");
    sel.value = cur;
  }
  function renderProducts() {
    const root = $("prodList"); if (!root) return;
    if (!state.products.length) { root.innerHTML = `<div class="empty">등록된 제품 없음 — 왼쪽에서 추가하세요</div>`; return; }
    root.innerHTML = state.products.map((p) => `<div class="cw-prodrow">
      <div class="cw-prodrow-main"><b>${esc(p.brand || "")}${p.brand && p.product ? " · " : ""}${esc(p.product || "")}</b>
      ${p.usp ? `<div class="cw-prodrow-usp">${esc(p.usp)}</div>` : ""}${p.notes ? `<div class="cw-prodrow-note">⚠ ${esc(p.notes)}</div>` : ""}</div>
      <div class="cw-prodrow-btns"><button class="btn-text" data-edit="${p.id}">수정</button><button class="btn-text" data-del="${p.id}">삭제</button></div>
    </div>`).join("");
    root.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editProduct(b.dataset.edit)));
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteProduct(b.dataset.del)));
  }
  function editProduct(id) {
    const p = state.products.find((x) => x.id === id); if (!p) return;
    $("pfBrand").value = p.brand || ""; $("pfProduct").value = p.product || ""; $("pfUsp").value = p.usp || ""; $("pfNotes").value = p.notes || "";
    $("pfSave").dataset.editId = id; $("prodFormTitle").textContent = "제품 수정"; $("pfReset").hidden = false;
  }
  function resetProductForm() {
    ["pfBrand", "pfProduct", "pfUsp", "pfNotes"].forEach((id) => $(id).value = "");
    delete $("pfSave").dataset.editId; $("prodFormTitle").textContent = "새 제품 등록"; $("pfReset").hidden = true;
  }
  async function saveProduct() {
    const body = { brand: $("pfBrand").value.trim(), product: $("pfProduct").value.trim(), usp: $("pfUsp").value.trim(), notes: $("pfNotes").value.trim() };
    if ($("pfSave").dataset.editId) body.id = $("pfSave").dataset.editId;
    if (!body.brand && !body.product) { alert("브랜드 또는 제품명을 입력하세요."); return; }
    try { const r = await fetch("/api/content/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); resetProductForm(); loadProducts(); toast("제품 저장됨"); }
    catch (e) { alert(e.message || "저장 실패"); }
  }
  async function deleteProduct(id) {
    if (!confirm("이 제품을 삭제할까요?")) return;
    try { await fetch("/api/content/products/" + id, { method: "DELETE" }); loadProducts(); } catch (e) {}
  }

  function toast(msg) {
    let t = $("cwToast");
    if (!t) { t = document.createElement("div"); t.id = "cwToast"; t.className = "cw-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
