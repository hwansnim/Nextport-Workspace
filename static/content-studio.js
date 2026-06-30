/*
 * 콘텐츠 스튜디오 — 레퍼런스 분석 + 기획안 생성 + 확정 누적 학습.
 * 상단 세그먼트(자사/대행/전체) + 브랜드 칩으로 맥락 구분. 기획안 확정 → 제품별 라이브러리 적재 →
 * 신규 기획안 생성 시 같은 제품 확정본을 자동 학습.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const OP_LABEL = { own: "자사", agency: "대행" };
  const state = {
    projects: [], active: 0, products: [], plans: [],
    product: { id: "", name: "", features: "", brand: "", op_type: "own" },
    opType: "own", brand: "",
    edit: { analysis: false, plan: false },
  };

  function init() {
    // 워크스페이스 드롭다운
    const wb = $("wsBrand"), wd = $("wsDropdown");
    if (wb && wd) {
      wb.addEventListener("click", (e) => { if (e.target.closest(".ws-dd-item")) return; e.stopPropagation(); wd.hidden = !wd.hidden; });
      document.addEventListener("click", () => { wd.hidden = true; });
    }
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.addEventListener("click", () => switchPane(b.dataset.pane)));

    // 상단 세그먼트 (자사/대행/전체)
    $("opSeg").querySelectorAll(".cw-seg-btn").forEach((b) => b.addEventListener("click", () => setOp(b.dataset.op)));

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
    $("prodName").addEventListener("input", (e) => { state.product.name = e.target.value; state.product.id = ""; updateLearnNote(); refreshGen(); });
    $("prodFeatures").addEventListener("input", (e) => { state.product.features = e.target.value; });
    $("prodPick").addEventListener("change", (e) => pickProduct(e.target.value));
    $("uspUrlBtn").addEventListener("click", () => extractUrl($("uspUrl").value.trim()));
    $("uspUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") extractUrl($("uspUrl").value.trim()); });
    $("uspFileBtn").addEventListener("click", () => $("uspFile").click());
    $("uspFile").addEventListener("change", () => { if ($("uspFile").files[0]) extractFile($("uspFile").files[0]); $("uspFile").value = ""; });

    // 제품 정보 등록
    $("pfSave").addEventListener("click", saveProduct);
    $("pfReset").addEventListener("click", resetProductForm);

    setOp("own");
    loadProducts();
    renderStudio();
  }

  /* ─── 운영구분(자사/대행) 맥락 ─── */
  function setOp(op) {
    state.opType = op; state.brand = "";
    $("cwMain").dataset.op = op;
    $("opSeg").querySelectorAll(".cw-seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.op === op));
    // 제품 등록폼 기본 운영구분 = 현재 맥락
    if ($("pfOpType") && !$("pfSave").dataset.editId) $("pfOpType").value = (op === "agency" ? "agency" : "own");
    renderBrandChips(); renderProdPicker(); renderProducts(); renderLibrary();
  }
  function setBrand(b) {
    state.brand = (state.brand === b ? "" : b);
    renderBrandChips(); renderProdPicker(); renderProducts(); renderLibrary();
  }
  function opMatch(item) { return state.opType === "all" || (item.op_type || "own") === state.opType; }
  function brandsForOp() {
    const seen = new Map();
    state.products.filter(opMatch).forEach((p) => {
      const b = (p.brand || "").trim(); if (!b) return;
      if (!seen.has(b)) seen.set(b, { name: b, op: p.op_type || "own", n: 0 });
      seen.get(b).n++;
    });
    return [...seen.values()];
  }
  function renderBrandChips() {
    const root = $("brandChips"); if (!root) return;
    const brands = brandsForOp();
    if (!brands.length) { root.innerHTML = `<span class="cw-chip-empty">등록된 브랜드 없음 — [제품 정보]에서 추가</span>`; return; }
    root.innerHTML = `<button class="cw-chip ${state.brand === "" ? "active" : ""}" data-b="">전체 브랜드</button>` +
      brands.map((b) => `<button class="cw-chip cw-chip-${esc(b.op)} ${state.brand === b.name ? "active" : ""}" data-b="${esc(b.name)}">${esc(b.name)} <span class="cw-chip-n">${b.n}</span></button>`).join("");
    root.querySelectorAll(".cw-chip").forEach((c) => c.addEventListener("click", () => setBrand(c.dataset.b)));
  }
  function filteredProducts() {
    return state.products.filter((p) => opMatch(p) && (!state.brand || (p.brand || "") === state.brand));
  }

  function switchPane(name) {
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
    document.querySelectorAll(".cw-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    if (name === "products") { resetProductForm(); loadProducts(); }
    if (name === "library") loadLibrary();
  }

  function activeProj() { return state.projects[state.active]; }

  /* ─── 영상 → 프로젝트 + 병렬 분석 ─── */
  function handleVideos(files) {
    files.filter((f) => f.type.startsWith("video/")).forEach((file) => {
      const proj = { id: Math.random().toString(36).slice(2), name: "기획안 " + String.fromCharCode(65 + state.projects.length), file, url: URL.createObjectURL(file), analysis: [], plan: [], draft: [], status: "analyzing", progress: 0, error: "", timer: null };
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
      if (proj === activeProj()) (proj.status === "planning" ? renderPlanPane() : renderAnalyzePane());
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
    const vb = $("vidBox");
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
      <button class="cw-tb-btn" data-tb="edit" data-kind="${kind}">${editing ? "💾 변경사항 저장" : "✏️ 수동 수정"}</button>
      ${editing ? "" : `<button class="cw-tb-btn" data-tb="notion" data-kind="${kind}">📋 노션용 복사</button>
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
      </div>
      <div class="cw-confirm">
        <input id="confirmNote" class="cw-confirm-note" placeholder="확정 메모(선택): 왜 이렇게 갔는지 — 다음 학습에 반영돼요" />
        <button class="cw-confirm-btn" id="confirmBtn">✅ 기획안 확정 (라이브러리에 저장)</button>
      </div>`;
    wireTable(root, "plan", p.plan);
    $("refineBtn").addEventListener("click", () => refine($("refineInput").value.trim()));
    $("confirmBtn").addEventListener("click", () => confirmPlan());
  }

  function progressCard(pct, title, sub) {
    const deg = Math.round((pct / 100) * 360);
    return `<div class="cw-prog"><div class="cw-prog-ring" style="background:conic-gradient(var(--ctx,var(--accent)) ${deg}deg, #eef0f3 0)"><div class="cw-prog-inner"><b>${Math.floor(pct)}%</b><span>WORKING</span></div></div>
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
    if (!prod) { state.product = { id: "", name: "", features: "", brand: "", op_type: state.opType === "agency" ? "agency" : "own" }; updateLearnNote(); refreshGen(); return; }
    state.product = {
      id: prod.id,
      name: prod.product || prod.brand || "",
      features: [prod.usp, prod.notes ? "[특이사항] " + prod.notes : ""].filter(Boolean).join("\n"),
      brand: prod.brand || "", op_type: prod.op_type || "own",
    };
    $("prodName").value = state.product.name; $("prodFeatures").value = state.product.features;
    updateLearnNote(); refreshGen();
  }
  async function updateLearnNote() {
    const el = $("learnNote"); if (!el) return;
    if (!state.product.id) {
      el.hidden = false;
      el.className = "cw-learn cw-learn-muted";
      el.innerHTML = `💡 <b>등록된 제품을 선택</b>하면 확정본이 누적·학습됩니다.`;
      return;
    }
    try {
      const r = await fetch("/api/content/plans?product_id=" + encodeURIComponent(state.product.id));
      const j = await r.json(); const n = (j.plans || []).length;
      el.hidden = false;
      el.className = "cw-learn" + (n ? " cw-learn-on" : " cw-learn-muted");
      el.innerHTML = n
        ? `📚 <b>${esc(state.product.name)}</b> 확정본 <b>${n}개</b> 누적 — 신규 생성 시 자동 학습 ✓`
        : `📭 <b>${esc(state.product.name)}</b> 확정본 0개 — 확정할수록 완성도가 쌓여요.`;
    } catch (e) { el.hidden = true; }
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
    state.product.id = ""; state.product.name = prod.name || ""; state.product.features = prod.features || "";
    $("prodName").value = state.product.name; $("prodFeatures").value = state.product.features; updateLearnNote(); refreshGen();
  }
  function uspBusy(b) { $("uspStatus").textContent = b ? "분석 중…" : ""; $("uspUrlBtn").disabled = b; $("uspFileBtn").disabled = b; }

  /* ─── 기획안 생성/수정/확정 ─── */
  async function genPlan() {
    const p = activeProj(); if (!p || !p.analysis.length || !state.product.name.trim()) return;
    p.status = "planning"; p.progress = 0; renderProjTabs(); renderPlanPane(); simProgress(p, 95, 12000);
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product, product_id: state.product.id }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "생성 실패");
      p.plan = j.plan || []; p.draft = JSON.parse(JSON.stringify(p.plan)); p.status = "analyzed"; p.progress = 100;
      if (j.learned_from) toast(`확정본 ${j.learned_from}개 학습 반영됨`);
    } catch (e) { p.status = "analyzed"; alert(e.message); }
    clearInterval(p.timer); renderProjTabs(); renderPlanPane();
  }
  async function refine(feedback) {
    const p = activeProj(); if (!p || !feedback) return;
    $("refineBtn").disabled = true; $("refineBtn").textContent = "반영 중…";
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product, product_id: state.product.id, feedback }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); p.plan = j.plan || []; renderPlanPane();
    } catch (e) { alert(e.message); $("refineBtn").disabled = false; $("refineBtn").textContent = "수정 반영"; }
  }
  async function confirmPlan() {
    const p = activeProj(); if (!p || !p.plan.length) return;
    if (!state.product.id) {
      if (!confirm("등록된 제품을 선택하지 않아 '학습'에는 반영되지 않습니다.\n그래도 라이브러리에 저장할까요?\n\n(좌측에서 제품을 선택하면 같은 제품 학습에 쌓입니다)")) return;
    }
    const btn = $("confirmBtn"); btn.disabled = true; btn.textContent = "저장 중…";
    try {
      const body = {
        product_id: state.product.id, product_name: state.product.name,
        brand: state.product.brand, op_type: state.product.op_type,
        title: p.name, reference: p.analysis, draft: p.draft, final: p.plan,
        note: ($("confirmNote").value || "").trim(),
      };
      const r = await fetch("/api/content/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "저장 실패");
      toast("✅ 기획안 확정 — 라이브러리에 누적됨");
      updateLearnNote(); loadLibrary();
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = "✅ 기획안 확정 (라이브러리에 저장)"; }
  }

  /* ─── 광고 라이브러리 ─── */
  async function loadLibrary() {
    try { const r = await fetch("/api/content/plans"); const j = await r.json(); state.plans = j.plans || []; renderLibrary(); }
    catch (e) {}
  }
  function renderLibrary() {
    const root = $("libList"); if (!root) return;
    let plans = state.plans.filter((x) => state.opType === "all" || (x.op_type || "own") === state.opType);
    if (state.brand) plans = plans.filter((x) => (x.brand || "") === state.brand);
    if (!plans.length) {
      root.innerHTML = `<div class="empty">확정된 기획안이 없습니다.<br><span class="hint">기획안 스튜디오에서 멘트를 다듬고 <b>[기획안 확정]</b>을 누르면 여기에 쌓여요.</span></div>`;
      return;
    }
    // 제품별 그룹
    const groups = {};
    plans.forEach((p) => { const k = p.product_name || p.brand || "(미지정)"; (groups[k] = groups[k] || []).push(p); });
    root.innerHTML = Object.entries(groups).map(([name, list]) => {
      const op = list[0].op_type || "own"; const brand = list[0].brand || "";
      return `<div class="cw-lib-group">
        <div class="cw-lib-gh"><span class="cw-badge cw-badge-${esc(op)}">${OP_LABEL[op] || "자사"}</span>
          ${brand ? `<span class="cw-lib-brand">${esc(brand)}</span>` : ""}<b>${esc(name)}</b>
          <span class="cw-lib-count">확정본 ${list.length}개</span></div>
        ${list.map((p) => libCard(p)).join("")}</div>`;
    }).join("");
    root.querySelectorAll("[data-libtoggle]").forEach((b) => b.addEventListener("click", () => {
      const body = root.querySelector(`#libbody-${b.dataset.libtoggle}`); if (body) body.hidden = !body.hidden;
    }));
    root.querySelectorAll("[data-libdel]").forEach((b) => b.addEventListener("click", () => deletePlan(b.dataset.libdel)));
  }
  function libCard(p) {
    const date = (p.created_at || "").slice(0, 16).replace("T", " ");
    const narr = (p.final || []).map((r) => r.narration).filter(Boolean).join(" / ");
    const rows = (p.final || []).map((r, i) => `<tr><td class="cw-no">${i + 1}</td><td class="cw-narr">${esc(r.narration)}</td><td class="cw-cap">${esc(r.caption)}</td><td class="cw-dir">${esc(r.direction)}</td></tr>`).join("");
    return `<div class="cw-lib-card">
      <div class="cw-lib-row">
        <div class="cw-lib-main"><div class="cw-lib-title">${esc(p.title || "기획안")} <span class="cw-lib-date">${esc(date)}</span></div>
          <div class="cw-lib-prev">${esc(narr).slice(0, 110)}${narr.length > 110 ? "…" : ""}</div>
          ${p.note ? `<div class="cw-lib-note">📝 ${esc(p.note)}</div>` : ""}</div>
        <div class="cw-lib-btns"><button class="btn-text" data-libtoggle="${esc(p.id)}">펼치기</button><button class="btn-text" data-libdel="${esc(p.id)}">삭제</button></div>
      </div>
      <div class="cw-lib-body" id="libbody-${esc(p.id)}" hidden>
        <table class="cw-tbl"><thead><tr><th class="cw-no">NO</th><th>나레이션</th><th>자막</th><th>연출</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
  }
  async function deletePlan(id) {
    if (!confirm("이 확정본을 삭제할까요? (학습 참고에서도 제외됩니다)")) return;
    try { await fetch("/api/content/plans/" + id, { method: "DELETE" }); loadLibrary(); updateLearnNote(); } catch (e) {}
  }

  /* ─── 제품 정보 등록 ─── */
  async function loadProducts() {
    try { const r = await fetch("/api/content/products"); const j = await r.json(); state.products = j.products || []; renderProducts(); renderProdPicker(); renderBrandChips(); }
    catch (e) {}
  }
  function renderProdPicker() {
    const sel = $("prodPick"); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">— 등록된 제품 선택 (또는 직접 입력) —</option>` +
      filteredProducts().map((p) => `<option value="${p.id}">${esc(p.brand ? p.brand + " · " : "")}${esc(p.product || "")}</option>`).join("");
    sel.value = cur;
  }
  function renderProducts() {
    const root = $("prodList"); if (!root) return;
    const list = filteredProducts();
    if (!list.length) { root.innerHTML = `<div class="empty">${state.products.length ? "이 맥락에 등록된 제품 없음" : "등록된 제품 없음 — 왼쪽에서 추가하세요"}</div>`; return; }
    root.innerHTML = list.map((p) => {
      const op = p.op_type || "own";
      return `<div class="cw-prodrow">
        <div class="cw-prodrow-main"><b><span class="cw-badge cw-badge-${esc(op)}">${OP_LABEL[op] || "자사"}</span> ${esc(p.brand || "")}${p.brand && p.product ? " · " : ""}${esc(p.product || "")}</b>
        ${p.usp ? `<div class="cw-prodrow-usp">${esc(p.usp)}</div>` : ""}${p.notes ? `<div class="cw-prodrow-note">⚠ ${esc(p.notes)}</div>` : ""}</div>
        <div class="cw-prodrow-btns"><button class="btn-text" data-edit="${p.id}">수정</button><button class="btn-text" data-del="${p.id}">삭제</button></div>
      </div>`;
    }).join("");
    root.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editProduct(b.dataset.edit)));
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteProduct(b.dataset.del)));
  }
  function editProduct(id) {
    const p = state.products.find((x) => x.id === id); if (!p) return;
    if ($("pfOpType")) $("pfOpType").value = p.op_type || "own";
    $("pfBrand").value = p.brand || ""; $("pfProduct").value = p.product || ""; $("pfUsp").value = p.usp || ""; $("pfNotes").value = p.notes || "";
    $("pfSave").dataset.editId = id; $("prodFormTitle").textContent = "제품 수정"; $("pfReset").hidden = false;
  }
  function resetProductForm() {
    ["pfBrand", "pfProduct", "pfUsp", "pfNotes"].forEach((id) => $(id).value = "");
    if ($("pfOpType")) $("pfOpType").value = (state.opType === "agency" ? "agency" : "own");
    delete $("pfSave").dataset.editId; $("prodFormTitle").textContent = "새 제품 등록"; $("pfReset").hidden = true;
  }
  async function saveProduct() {
    const body = { op_type: $("pfOpType") ? $("pfOpType").value : "own", brand: $("pfBrand").value.trim(), product: $("pfProduct").value.trim(), usp: $("pfUsp").value.trim(), notes: $("pfNotes").value.trim() };
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
