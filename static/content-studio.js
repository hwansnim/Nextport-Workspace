/*
 * 콘텐츠 스튜디오 — 레퍼런스 분석기 + 기획안 스튜디오 + 확정 누적 학습.
 * 레퍼런스 분석(좌측 별도 탭) → 기획안 스튜디오(제품 입혀 생성) → 확정 라이브러리(같은 제품 자동 학습).
 * 진행률 1%씩 끝까지 차오름 · 화면 이동해도 백그라운드 작업표시 유지.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const OP_LABEL = { own: "자사", agency: "대행" };
  const state = {
    projects: [], active: 0, products: [], plans: [], productions: [], pfAppeals: [],
    meta: { connected: false, accounts: [] },
    product: { id: "", name: "", features: "", brand: "", op_type: "own", appeals: [] },
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
    $("toStudioBtn").addEventListener("click", () => switchPane("studio"));
    $("studioBack").addEventListener("click", showStudioList);

    // 전체화면 드롭 (어느 화면이든)
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
      if (vids.length) { switchPane("analyzer"); handleVideos(vids); }
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

    // 제품 정보 등록 (+ 소구점 칩)
    $("pfSave").addEventListener("click", saveProduct);
    $("pfReset").addEventListener("click", resetProductForm);
    $("pfAppealInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPfAppeal(e.target.value); e.target.value = ""; } });

    // 제작 관리
    $("pmSave").addEventListener("click", savePm);
    $("pmReset").addEventListener("click", resetPmForm);
    $("pmProductPick").addEventListener("change", (e) => {
      const prod = state.products.find((x) => x.id === e.target.value);
      if (prod) { $("pmBrand").value = prod.brand || ""; $("pmProduct").value = prod.product || ""; }
    });

    // 촬영기획안 (자체 생성)
    $("shootProduct").addEventListener("change", (e) => loadShootPlans(e.target.value));
    $("shootGen").addEventListener("click", shootGenFromPicks);

    // 효율 분석 (메타)
    $("metaSaveToken").addEventListener("click", saveMetaToken);
    $("metaVerify").addEventListener("click", verifyMeta);
    $("metaAddAcct").addEventListener("click", addMetaAcct);
    $("perfLoad").addEventListener("click", perfLoad);

    loadProducts();
    renderStudio();
  }

  function switchPane(name) {
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
    document.querySelectorAll(".cw-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    if (name === "products") { resetProductForm(); loadProducts(); }
    if (name === "library") loadLibrary();
    if (name === "perf") loadMeta();
    if (name === "shoot") { loadShootSources(); renderShoot(); }
    if (name === "studio") showStudioList();
    if (name === "analyzer" || name === "studio") renderStudio();
  }

  function activeProj() { return state.projects[state.active]; }

  /* ─── 영상 → 프로젝트 + 병렬 분석 ─── */
  function handleVideos(files) {
    files.filter((f) => f.type.startsWith("video/")).forEach((file) => {
      const proj = { id: Math.random().toString(36).slice(2), name: "기획안 " + String.fromCharCode(65 + state.projects.length), file, url: URL.createObjectURL(file), analysis: [], plan: [], draft: [], why_watch: "", why_buy: "", status: "analyzing", progress: 0, error: "", timer: null };
      state.projects.push(proj);
      state.active = state.projects.length - 1;
      analyzeProject(proj);
    });
    renderStudio();
  }

  // 진행률: 빠르게 차오른 뒤 1%씩 99까지 계속 (멈추지 않음). 완료 시 100.
  function simProgress(proj) {
    clearInterval(proj.timer);
    proj.timer = setInterval(() => {
      const cur = proj.progress;
      let inc;
      if (cur < 60) inc = Math.random() * 4 + 2;
      else if (cur < 90) inc = Math.random() * 1.2 + 0.4;
      else inc = Math.max(0.15, (99 - cur) * 0.05); // 90%부터 1%씩 천천히 creep
      proj.progress = Math.min(99, cur + inc);
      if (proj === activeProj()) (proj.status === "planning" ? renderPlanPane() : renderAnalyzePane());
      renderProjTabs(); renderJobs();
    }, 400);
  }

  async function analyzeProject(proj, feedback) {
    proj.status = "analyzing"; proj.error = ""; proj.progress = 0;
    renderProjTabs(); renderAnalyzePane(); renderJobs();
    simProgress(proj);
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
    renderProjTabs(); renderJobs(); if (proj === activeProj()) { renderAnalyzePane(); refreshGen(); }
  }

  function renderProjTabs() {
    const roots = document.querySelectorAll(".cw-proj-tabs");
    const html = !state.projects.length ? "" : (state.projects.map((p, i) => {
      const working = p.status === "analyzing" || p.status === "planning";
      const dot = working ? "working" : (p.status === "analyzed" || p.plan.length ? "done" : "");
      const pct = working ? ` <span class="cw-proj-pct">(${Math.floor(p.progress)}%)</span>` : "";
      return `<div class="cw-proj ${i === state.active ? "active" : ""} ${working ? "working" : ""}" data-i="${i}">
        <span class="cw-proj-dot ${dot}"></span><span>${esc(p.name)}</span>${pct}
        <button class="cw-proj-x" data-del="${i}" title="삭제">×</button></div>`;
    }).join("") + `<button class="cw-proj-add" title="영상 추가">+</button>`);
    roots.forEach((root) => {
      root.innerHTML = html;
      root.querySelectorAll(".cw-proj").forEach((el) => el.addEventListener("click", (e) => { if (e.target.dataset.del != null) return; state.active = +el.dataset.i; renderStudio(); }));
      root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); delProject(+b.dataset.del); }));
      root.querySelector(".cw-proj-add")?.addEventListener("click", () => $("videoFile").click());
    });
  }

  function delProject(i) {
    if (!confirm("이 기획안을 삭제할까요?")) return;
    clearInterval(state.projects[i]?.timer);
    state.projects.splice(i, 1);
    state.active = Math.max(0, Math.min(state.active, state.projects.length - 1));
    renderStudio(); renderJobs();
  }

  // 글로벌 작업표시 — 어느 화면에 있든 진행 중인 분석/기획 보여줌
  function renderJobs() {
    let el = $("cwJobs");
    if (!el) { el = document.createElement("div"); el.id = "cwJobs"; el.className = "cw-jobs"; document.body.appendChild(el); }
    const working = state.projects.filter((p) => p.status === "analyzing" || p.status === "planning");
    if (!working.length) { el.classList.remove("show"); el.innerHTML = ""; return; }
    el.classList.add("show");
    el.innerHTML = working.map((p) => {
      const label = p.status === "analyzing" ? "분석" : "기획";
      return `<div class="cw-job" data-go="${p.id}"><span class="cw-job-spin"></span><span>${esc(p.name)} ${label} 중</span> <b>${Math.floor(p.progress)}%</b></div>`;
    }).join("");
    el.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      const i = state.projects.findIndex((p) => p.id === b.dataset.go);
      if (i >= 0) { state.active = i; switchPane(state.projects[i].status === "planning" ? "studio" : "analyzer"); }
    }));
  }

  /* ─── 스튜디오 렌더 ─── */
  function renderStudio() {
    const p = activeProj();
    const vb = $("vidBox");
    if (vb) {
      if (p && p.url) vb.innerHTML = `<video src="${esc(p.url)}" id="refVideo" controls playsinline></video>`;
      else vb.innerHTML = `<div class="cw-vid-empty">레퍼런스 영상을<br>드래그하세요</div>`;
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
    if (!root) return;
    if (!p) {
      root.innerHTML = `<div class="cw-drop" id="dropInline"><div class="cw-drop-ico">🎞️</div><div><b>분석할 레퍼런스 영상</b>을 화면 어디든 끌어다 놓으세요</div><button class="btn-primary" id="dropPick" style="margin-top:14px">파일 선택하기</button></div>`;
      $("dropPick").addEventListener("click", () => $("videoFile").click());
      return;
    }
    if (p.status === "analyzing") { root.innerHTML = progressCard(p.progress, "분석 중...", "데이터를 추출하는 중입니다 · 다른 화면으로 이동해도 계속됩니다"); return; }
    if (p.error) { root.innerHTML = `<div class="cw-sp-head"><span class="cw-dot"></span> 분석 결과</div><div class="empty" style="color:#e0245e">❌ ${esc(p.error)}<br><button class="btn-secondary" id="reTry" style="margin-top:12px">다시 분석</button></div>`; $("reTry")?.addEventListener("click", () => { if (p.file) analyzeProject(p); }); return; }
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
    if (!root) return;
    if (!p || (!p.plan.length && p.status !== "planning")) {
      root.innerHTML = `<div class="empty cw-plan-empty">기획안 생성 대기 중<br><span class="hint">레퍼런스 분석 후, 제품 정보 입력하고 좌측 [신규 기획안 생성]</span></div>`;
      return;
    }
    if (p.status === "planning") { root.innerHTML = progressCard(p.progress, "기획안 생성 중...", "레퍼런스 플로우에 제품을 입히는 중 · 다른 화면 이동 가능"); return; }
    const why = (p.why_watch || p.why_buy)
      ? `<div class="cw-why"><div class="cw-why-col"><b>👀 왜 볼까</b><span>${esc(p.why_watch || "-")}</span></div><div class="cw-why-col cw-why-buy"><b>💳 왜 살까</b><span>${esc(p.why_buy || "-")}</span></div></div>`
      : "";
    root.innerHTML = `<div class="cw-sp-head"><span class="cw-dot done"></span> 신규 기획안 ${toolbar("plan")}</div>
      ${why}
      <div class="cw-sp-body">${dataTable("plan", p.plan)}</div>
      <div class="cw-rebox">
        <div class="cw-rebox-h">✍️ 기획안 수정 요청</div>
        <div class="cw-rebox-row"><textarea id="refineInput" rows="2" placeholder="예: 더 신뢰감 있는 톤으로, 첫 3초 강하게"></textarea>
        <button class="cw-rebtn cw-rebtn-blue" id="refineBtn">수정 반영</button></div>
      </div>
      <div class="cw-confirm">
        <input id="confirmNote" class="cw-confirm-note" placeholder="확정 메모(선택): 왜 이렇게 갔는지 — 다음 학습에 반영돼요" />
        <button class="cw-confirm-btn cw-shoot-btn" id="shootBtn">📹 촬영 기획안</button>
        <button class="cw-confirm-btn" id="confirmBtn">✅ 기획안 확정</button>
      </div>`;
    wireTable(root, "plan", p.plan);
    $("refineBtn").addEventListener("click", () => refine($("refineInput").value.trim()));
    $("confirmBtn").addEventListener("click", () => confirmPlan());
    $("shootBtn").addEventListener("click", () => genShoot());
  }

  /* ─── 촬영 기획안 = 장소별 동선 스케줄 + .docx ─── */
  let shootState = { schedule: null, meta: {}, filename: "촬영스케줄", busy: false };

  // (1) 스튜디오 연결: 현재 기획안 → 단일 편 스케줄
  async function genShoot() {
    const p = activeProj(); if (!p || !p.plan.length) return;
    switchPane("shoot");
    await runSchedule([{ label: state.product.name || "기획안", rows: p.plan }], state.product, (state.product.name || p.name) + "_촬영스케줄");
  }
  async function runSchedule(plans, product, filename) {
    shootState.busy = true; shootState.filename = filename || "촬영스케줄";
    $("shootWrap").innerHTML = progressCard(55, "촬영 스케줄 생성 중...", "장소별 동선으로 컷을 재배치하는 중");
    try {
      const r = await fetch("/api/content/shoot/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plans, product }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "생성 실패");
      shootState.schedule = j; shootState.meta = { title: j.title, brand: product.brand || "", product: product.name || "" };
      shootState.busy = false; renderShoot();
    } catch (e) { shootState.busy = false; shootState.schedule = null; $("shootWrap").innerHTML = `<div class="empty" style="color:#e0245e">❌ ${esc(e.message)}</div>`; }
  }
  function renderShoot() {
    const root = $("shootWrap"); if (!root || shootState.busy) return;
    const sc = shootState.schedule;
    if (!sc || !(sc.locations && sc.locations.length)) {
      if (!root.querySelector(".cw-loc")) root.innerHTML = `<div class="empty">제품·기획안을 고르고 <b>[촬영 스케줄 생성]</b>을 누르세요. (또는 기획안 스튜디오 상세에서 [📹 촬영 기획안])</div>`;
      return;
    }
    const locs = sc.locations.map((loc) => {
      const cuts = (loc.cuts || []).map((c, i) => `<div class="cw-cut">
        <div class="cw-cut-tag">#${i + 1} <span>${esc(c.tag || "")}</span></div>
        <div class="cw-cut-action">${esc(c.action)}</div>
        <div class="cw-cut-narr">🎙 ${esc(c.narration)}</div></div>`).join("");
      return `<div class="cw-loc">
        <div class="cw-loc-h">■ ${esc(loc.location)} <span class="cw-loc-n">${(loc.cuts || []).length}컷</span></div>
        <div class="cw-loc-info">복장: ${esc(loc.wardrobe || "-")} &nbsp;|&nbsp; 셋업: ${esc(loc.setup || "-")}</div>
        <div class="cw-cuts">${cuts}</div></div>`;
    }).join("");
    root.innerHTML = `<div class="cw-shoot-head"><b>${esc(sc.title || "촬영 스케줄")}</b>
      <button class="btn-primary" id="shootDocx">📄 워드(.docx) 다운로드</button></div>${locs}`;
    $("shootDocx").addEventListener("click", downloadDocx);
  }
  async function downloadDocx() {
    if (!shootState.schedule) return;
    const btn = $("shootDocx"); btn.disabled = true; btn.textContent = "생성 중…";
    try {
      const r = await fetch("/api/content/shoot/docx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schedule: shootState.schedule, meta: shootState.meta, filename: shootState.filename }) });
      if (!r.ok) throw new Error("생성 실패");
      const blob = await r.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = shootState.filename + ".docx"; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url); toast("워드 파일 다운로드됨");
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = "📄 워드(.docx) 다운로드"; }
  }
  // (2) 자체 생성: 제품 → 확정 기획안 묶음 선택 → 스케줄
  async function loadShootSources() {
    const sel = $("shootProduct"); if (!sel) return;
    if (!state.products.length) { try { const r = await fetch("/api/content/products"); state.products = (await r.json()).products || []; } catch (e) {} }
    const cur = sel.value;
    sel.innerHTML = `<option value="">— 제품 선택 (확정 기획안 묶음) —</option>` +
      state.products.map((p) => `<option value="${p.id}">${esc(p.brand ? p.brand + " · " : "")}${esc(p.product || "")}</option>`).join("");
    sel.value = cur;
  }
  async function loadShootPlans(productId) {
    const root = $("shootPlanPick");
    if (!productId) { root.innerHTML = `<span class="hint">제품을 먼저 선택하세요</span>`; $("shootGen").disabled = true; return; }
    try {
      const r = await fetch("/api/content/plans?product_id=" + encodeURIComponent(productId));
      const plans = (await r.json()).plans || [];
      if (!plans.length) { root.innerHTML = `<span class="hint">이 제품의 확정 기획안이 없습니다 (기획안 스튜디오에서 확정하세요)</span>`; $("shootGen").disabled = true; return; }
      root.innerHTML = plans.map((p, i) => `<label class="cw-shoot-plan"><input type="checkbox" data-plan="${esc(p.id)}" ${i === 0 ? "checked" : ""}/> ${esc(p.title || "기획안")} <span class="hint">${(p.final || []).length}컷 · ${esc((p.created_at || "").slice(0, 10))}</span></label>`).join("");
      state._shootPlans = plans; $("shootGen").disabled = false;
    } catch (e) {}
  }
  async function shootGenFromPicks() {
    const ids = [...document.querySelectorAll('#shootPlanPick input[data-plan]:checked')].map((c) => c.dataset.plan);
    const picked = (state._shootPlans || []).filter((p) => ids.includes(p.id));
    if (!picked.length) { alert("기획안을 1개 이상 선택하세요."); return; }
    const prod = state.products.find((x) => x.id === $("shootProduct").value) || {};
    const product = { name: prod.product || prod.brand || "", features: prod.usp || "", brand: prod.brand || "" };
    const plans = picked.map((p, i) => ({ label: picked.length > 1 ? `${i + 1}편` : (p.title || "기획안"), rows: p.final || [] }));
    await runSchedule(plans, product, (prod.product || "촬영") + "_촬영스케줄");
  }

  /* ─── 기획안 스튜디오 = 제작 관리 목록 ↔ 항목별 생성기 ─── */
  const PM_CAT = { shoot: "촬영", noshoot: "미촬영" };
  function showStudioList() {
    state.studioEntry = null;
    if ($("studioDetail")) $("studioDetail").hidden = true;
    if ($("studioList")) $("studioList").hidden = false;
    loadProductions();
  }
  function openEntry(id) {
    const r = state.productions.find((x) => x.id === id); if (!r) return;
    state.studioEntry = id;
    $("studioList").hidden = true; $("studioDetail").hidden = false;
    $("detailTitle").textContent = r.title || "기획안";
    $("detailMeta").textContent = [r.brand, r.product, PM_CAT[r.category] || "", r.date, r.user].filter(Boolean).join(" · ");
    // 제품 자동 세팅
    if (r.product_id && [...$("prodPick").options].some((o) => o.value === r.product_id)) {
      $("prodPick").value = r.product_id; pickProduct(r.product_id);
    } else if (r.product) {
      state.product = { id: "", name: r.product, features: "", brand: r.brand || "", op_type: "own", appeals: [] };
      $("prodPick").value = ""; $("prodName").value = r.product; $("prodFeatures").value = ""; updateLearnNote(); refreshGen();
    }
    renderStudio();
  }
  async function loadProductions() {
    renderPmProductPick();
    try { const r = await fetch("/api/content/productions"); const j = await r.json(); state.productions = j.rows || []; renderProductions(); }
    catch (e) {}
  }
  function renderPmProductPick() {
    const sel = $("pmProductPick"); if (!sel) return;
    sel.innerHTML = `<option value="">— 등록 제품 (브랜드·제품 자동 채움) —</option>` +
      state.products.map((p) => `<option value="${p.id}">${esc(p.brand ? p.brand + " · " : "")}${esc(p.product || "")}</option>`).join("");
  }
  function renderProductions() {
    const root = $("pmList"); if (!root) return;
    if (!state.productions.length) { root.innerHTML = `<div class="empty">아직 항목이 없습니다 — 위에서 추가하세요</div>`; return; }
    const rows = state.productions.map((r) => `<tr class="cw-pm-row" data-open="${esc(r.id)}">
      <td><b>${esc(r.title)}</b></td>
      <td class="cw-pm-date">${esc(r.date)}</td>
      <td>${esc(r.user)}</td>
      <td>${esc(r.brand)}</td>
      <td>${esc(r.product)}</td>
      <td><span class="cw-cat cw-cat-${esc(r.category || "noshoot")}">${PM_CAT[r.category] || "미촬영"}</span></td>
      <td class="cw-pm-note">${esc(r.note)}</td>
      <td class="cw-pm-act">
        <button class="btn-text" data-pmedit="${esc(r.id)}">수정</button>
        <button class="btn-text" data-pmdel="${esc(r.id)}">삭제</button></td></tr>`).join("");
    root.innerHTML = `<div style="overflow-x:auto"><table class="cw-tbl cw-pm-tbl"><thead><tr>
      <th>제목</th><th>날짜</th><th>사용자</th><th>브랜드</th><th>제품</th><th>분류</th><th>비고</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
    root.querySelectorAll(".cw-pm-row").forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.closest("[data-pmedit],[data-pmdel]")) return; openEntry(tr.dataset.open); }));
    root.querySelectorAll("[data-pmedit]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); editPm(b.dataset.pmedit); }));
    root.querySelectorAll("[data-pmdel]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); deletePm(b.dataset.pmdel); }));
  }
  function editPm(id) {
    const r = state.productions.find((x) => x.id === id); if (!r) return;
    $("pmTitle").value = r.title || ""; $("pmDate").value = r.date || ""; $("pmUser").value = r.user || "";
    $("pmBrand").value = r.brand || ""; $("pmProduct").value = r.product || ""; $("pmCategory").value = r.category || "noshoot"; $("pmNote").value = r.note || "";
    $("pmProductPick").value = r.product_id && [...$("pmProductPick").options].some((o) => o.value === r.product_id) ? r.product_id : "";
    $("pmSave").dataset.editId = id; $("pmSave").textContent = "저장"; $("pmReset").hidden = false;
    $("pmTitle").focus();
  }
  function resetPmForm() {
    ["pmTitle", "pmDate", "pmUser", "pmBrand", "pmProduct", "pmNote"].forEach((id) => { if ($(id)) $(id).value = ""; });
    if ($("pmCategory")) $("pmCategory").value = "noshoot";
    if ($("pmProductPick")) $("pmProductPick").value = "";
    if ($("pmSave")) { delete $("pmSave").dataset.editId; $("pmSave").textContent = "+ 추가"; }
    if ($("pmReset")) $("pmReset").hidden = true;
  }
  async function savePm() {
    const body = {
      title: $("pmTitle").value.trim(), date: $("pmDate").value, user: $("pmUser").value.trim(),
      brand: $("pmBrand").value.trim(), product: $("pmProduct").value.trim(),
      product_id: $("pmProductPick").value || "", category: $("pmCategory").value, note: $("pmNote").value.trim(),
    };
    if ($("pmSave").dataset.editId) body.id = $("pmSave").dataset.editId;
    if (!body.title) { alert("제목을 입력하세요."); return; }
    try { const r = await fetch("/api/content/productions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); resetPmForm(); loadProductions(); toast("제작 항목 저장됨"); }
    catch (e) { alert(e.message || "저장 실패"); }
  }
  async function deletePm(id) {
    if (!confirm("이 항목을 삭제할까요?")) return;
    try { await fetch("/api/content/productions/" + id, { method: "DELETE" }); loadProductions(); } catch (e) {}
  }

  function progressCard(pct, title, sub) {
    const deg = Math.round((pct / 100) * 360);
    return `<div class="cw-prog"><div class="cw-prog-ring" style="background:conic-gradient(var(--ctx,var(--accent)) ${deg}deg, #eef0f3 0)"><div class="cw-prog-inner"><b>${Math.floor(pct)}%</b><span>WORKING</span></div></div>
      <div class="cw-prog-title">${title}</div><div class="hint">${sub}</div>
      <div class="cw-prog-bar"><span style="width:${pct}%"></span></div></div>`;
  }

  function seekVideo(ts) {
    const v = $("refVideo"); if (!v || !ts) { switchPane("analyzer"); return; }
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
    if (!prod) { state.product = { id: "", name: "", features: "", brand: "", op_type: "own", appeals: [] }; updateLearnNote(); refreshGen(); return; }
    state.product = {
      id: prod.id,
      name: prod.product || prod.brand || "",
      features: [prod.usp, prod.notes ? "[특이사항] " + prod.notes : ""].filter(Boolean).join("\n"),
      brand: prod.brand || "", op_type: prod.op_type || "own", appeals: [...(prod.appeals || [])],
    };
    $("prodName").value = state.product.name; $("prodFeatures").value = state.product.features;
    updateLearnNote(); refreshGen();
  }
  async function updateLearnNote() {
    const el = $("learnNote"); if (!el) return;
    if (!state.product.id) {
      el.hidden = false; el.className = "cw-learn cw-learn-muted";
      el.innerHTML = `💡 <b>등록된 제품을 선택</b>하면 확정본이 누적·학습됩니다.`;
      return;
    }
    try {
      const r = await fetch("/api/content/plans?product_id=" + encodeURIComponent(state.product.id));
      const j = await r.json(); const n = (j.plans || []).length;
      el.hidden = false; el.className = "cw-learn" + (n ? " cw-learn-on" : " cw-learn-muted");
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
    switchPane("studio");
    p.status = "planning"; p.progress = 0; renderProjTabs(); renderPlanPane(); renderJobs(); simProgress(p);
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product, product_id: state.product.id }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "생성 실패");
      p.plan = j.plan || []; p.draft = JSON.parse(JSON.stringify(p.plan));
      p.why_watch = j.why_watch || ""; p.why_buy = j.why_buy || ""; p.status = "analyzed"; p.progress = 100;
      if (j.learned_from) toast(`확정본 ${j.learned_from}개 학습 반영됨`);
    } catch (e) { p.status = "analyzed"; alert(e.message); }
    clearInterval(p.timer); renderProjTabs(); renderPlanPane(); renderJobs();
  }
  async function refine(feedback) {
    const p = activeProj(); if (!p || !feedback) return;
    $("refineBtn").disabled = true; $("refineBtn").textContent = "반영 중…";
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product, product_id: state.product.id, feedback }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); p.plan = j.plan || []; p.why_watch = j.why_watch || p.why_watch; p.why_buy = j.why_buy || p.why_buy; renderPlanPane();
    } catch (e) { alert(e.message); $("refineBtn").disabled = false; $("refineBtn").textContent = "수정 반영"; }
  }
  async function confirmPlan() {
    const p = activeProj(); if (!p || !p.plan.length) return;
    if (!state.product.id) {
      if (!confirm("등록된 제품을 선택하지 않아 '학습'에는 반영되지 않습니다.\n그래도 라이브러리에 저장할까요?")) return;
    }
    const btn = $("confirmBtn"); btn.disabled = true; btn.textContent = "저장 중…";
    try {
      const body = {
        product_id: state.product.id, product_name: state.product.name,
        brand: state.product.brand, op_type: state.product.op_type,
        appeals: state.product.appeals, why_watch: p.why_watch || "", why_buy: p.why_buy || "",
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
    const plans = state.plans;
    if (!plans.length) {
      root.innerHTML = `<div class="empty">확정된 기획안이 없습니다.<br><span class="hint">기획안 스튜디오에서 멘트를 다듬고 <b>[기획안 확정]</b>을 누르면 여기에 쌓여요.</span></div>`;
      return;
    }
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
          ${(p.appeals && p.appeals.length) ? `<div class="cw-prodrow-appeals">${p.appeals.map((a) => `<span class="cw-tag-sm">${esc(a)}</span>`).join("")}</div>` : ""}
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

  /* ─── 제품 정보 등록 (소구점 칩 포함) ─── */
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
    root.innerHTML = state.products.map((p) => {
      const op = p.op_type || "own";
      return `<div class="cw-prodrow">
        <div class="cw-prodrow-main"><b><span class="cw-badge cw-badge-${esc(op)}">${OP_LABEL[op] || "자사"}</span> ${esc(p.brand || "")}${p.brand && p.product ? " · " : ""}${esc(p.product || "")}</b>
        ${(p.appeals && p.appeals.length) ? `<div class="cw-prodrow-appeals">${p.appeals.map((a) => `<span class="cw-tag-sm">${esc(a)}</span>`).join("")}</div>` : ""}
        ${p.usp ? `<div class="cw-prodrow-usp">${esc(p.usp)}</div>` : ""}${p.notes ? `<div class="cw-prodrow-note">⚠ ${esc(p.notes)}</div>` : ""}</div>
        <div class="cw-prodrow-btns"><button class="btn-text" data-edit="${p.id}">수정</button><button class="btn-text" data-del="${p.id}">삭제</button></div>
      </div>`;
    }).join("");
    root.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editProduct(b.dataset.edit)));
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteProduct(b.dataset.del)));
  }
  function addPfAppeal(v) {
    v = (v || "").trim(); if (!v) return;
    if (!state.pfAppeals.includes(v)) state.pfAppeals.push(v);
    renderPfAppeals();
  }
  function renderPfAppeals() {
    const root = $("pfAppealsTags"); if (!root) return;
    root.innerHTML = state.pfAppeals.map((a) => `<span class="cw-tag">${esc(a)}<button data-x="${esc(a)}" title="삭제">×</button></span>`).join("");
    root.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => { state.pfAppeals = state.pfAppeals.filter((x) => x !== b.dataset.x); renderPfAppeals(); }));
  }
  function editProduct(id) {
    const p = state.products.find((x) => x.id === id); if (!p) return;
    if ($("pfOpType")) $("pfOpType").value = p.op_type || "own";
    $("pfBrand").value = p.brand || ""; $("pfProduct").value = p.product || ""; $("pfUsp").value = p.usp || ""; $("pfNotes").value = p.notes || "";
    state.pfAppeals = [...(p.appeals || [])]; renderPfAppeals();
    $("pfSave").dataset.editId = id; $("prodFormTitle").textContent = "제품 수정"; $("pfReset").hidden = false;
  }
  function resetProductForm() {
    ["pfBrand", "pfProduct", "pfUsp", "pfNotes"].forEach((id) => { if ($(id)) $(id).value = ""; });
    if ($("pfOpType")) $("pfOpType").value = "own";
    state.pfAppeals = []; renderPfAppeals();
    if ($("pfSave")) { delete $("pfSave").dataset.editId; }
    if ($("prodFormTitle")) $("prodFormTitle").textContent = "새 제품 등록";
    if ($("pfReset")) $("pfReset").hidden = true;
  }
  async function saveProduct() {
    const body = { op_type: $("pfOpType") ? $("pfOpType").value : "own", brand: $("pfBrand").value.trim(), product: $("pfProduct").value.trim(), usp: $("pfUsp").value.trim(), notes: $("pfNotes").value.trim(), appeals: state.pfAppeals };
    if ($("pfSave").dataset.editId) body.id = $("pfSave").dataset.editId;
    if (!body.brand && !body.product) { alert("브랜드 또는 제품명을 입력하세요."); return; }
    try { const r = await fetch("/api/content/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); resetProductForm(); loadProducts(); toast("제품 저장됨"); }
    catch (e) { alert(e.message || "저장 실패"); }
  }
  async function deleteProduct(id) {
    if (!confirm("이 제품을 삭제할까요?")) return;
    try { await fetch("/api/content/products/" + id, { method: "DELETE" }); loadProducts(); } catch (e) {}
  }

  /* ─── 효율 분석 (메타 마케팅 API) ─── */
  async function loadMeta() {
    try { const r = await fetch("/api/content/meta/config"); const j = await r.json(); state.meta.connected = !!j.connected; state.meta.accounts = j.accounts || []; } catch (e) {}
    const st = $("metaStatus");
    if (st) st.innerHTML = state.meta.connected ? '<span style="color:#34c759">● 연결됨</span>' : '<span style="color:#e0245e">● 토큰 필요</span>';
    renderMetaAccts(); renderPerfAccountOptions();
  }
  function renderMetaAccts() {
    const root = $("metaAccts"); if (!root) return;
    if (!state.meta.accounts.length) { root.innerHTML = `<div class="hint" style="padding:6px 0">등록된 광고계정 없음 — 아래에서 추가</div>`; return; }
    root.innerHTML = state.meta.accounts.map((a) => `<div class="cw-meta-acct"><b>${esc(a.brand || "(브랜드 미지정)")}</b> <span class="hint">act_${esc(a.id)}${a.name ? " · " + esc(a.name) : ""}</span><button class="btn-text" data-macctdel="${esc(a.id)}">삭제</button></div>`).join("");
    root.querySelectorAll("[data-macctdel]").forEach((b) => b.addEventListener("click", () => delMetaAcct(b.dataset.macctdel)));
  }
  function renderPerfAccountOptions() {
    const sel = $("perfAccount"); if (!sel) return;
    sel.innerHTML = state.meta.accounts.length
      ? state.meta.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.brand || ("act_" + a.id))}</option>`).join("")
      : `<option value="">— 계정 등록 필요 —</option>`;
  }
  async function saveMetaToken() {
    const t = $("metaToken").value.trim(); if (!t) { alert("토큰을 입력하세요."); return; }
    try { await fetch("/api/content/meta/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) }); $("metaToken").value = ""; toast("토큰 저장됨 (서버에만 보관)"); loadMeta(); }
    catch (e) { alert("저장 실패"); }
  }
  async function verifyMeta() {
    const t = $("metaToken").value.trim();
    try {
      const r = await fetch("/api/content/meta/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t ? { token: t } : {}) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      if (!(j.accounts || []).length) { alert("접근 가능한 광고계정이 없습니다. 토큰 권한(ads_read)을 확인하세요."); return; }
      alert("접근 가능한 광고계정:\n\n" + j.accounts.map((a) => `act_${a.id} · ${a.name} (${a.currency || ""})`).join("\n") + "\n\n→ 아래 '계정 추가'에 ID를 넣고 브랜드명을 매핑하세요.");
    } catch (e) { alert(e.message || "확인 실패"); }
  }
  async function addMetaAcct() {
    const id = $("metaAcctId").value.trim().replace("act_", ""); const brand = $("metaAcctBrand").value.trim();
    if (!id) { alert("광고계정 ID(숫자)를 입력하세요."); return; }
    const accts = [...state.meta.accounts.filter((a) => a.id !== id), { id, brand }];
    try { await fetch("/api/content/meta/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: accts }) }); $("metaAcctId").value = ""; $("metaAcctBrand").value = ""; toast("계정 추가됨"); loadMeta(); }
    catch (e) { alert("추가 실패"); }
  }
  async function delMetaAcct(id) {
    const accts = state.meta.accounts.filter((a) => a.id !== id);
    try { await fetch("/api/content/meta/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: accts }) }); loadMeta(); } catch (e) {}
  }
  async function perfLoad() {
    const acct = $("perfAccount").value; if (!acct) { alert("광고계정을 등록·선택하세요."); return; }
    $("perfWrap").innerHTML = progressCard(50, "성과 불러오는 중...", "메타 광고관리자 데이터 조회 중");
    try {
      const r = await fetch("/api/content/perf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: acct, date_preset: $("perfDate").value, level: $("perfLevel").value }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      renderPerf(j.rows || []);
    } catch (e) { $("perfWrap").innerHTML = `<div class="empty" style="color:#e0245e">❌ ${esc(e.message)}</div>`; }
  }
  function renderPerf(rows) {
    const root = $("perfWrap"); if (!root) return;
    if (!rows.length) { root.innerHTML = `<div class="empty">해당 기간 데이터가 없습니다.</div>`; return; }
    const level = $("perfLevel").value;
    const nameOf = (r) => level === "ad" ? r.ad : level === "adset" ? r.adset : r.campaign;
    const won = (n) => n ? n.toLocaleString() + "원" : "-";
    const sum = rows.reduce((a, r) => ({ spend: a.spend + r.spend, purchases: a.purchases + r.purchases }), { spend: 0, purchases: 0 });
    const trs = rows.map((r) => `<tr><td class="cw-narr">${esc(nameOf(r))}</td>
      <td>${won(r.spend)}</td><td>${r.impressions.toLocaleString()}</td><td>${r.clicks.toLocaleString()}</td>
      <td>${r.ctr}%</td><td><b>${r.roas ? r.roas + "x" : "-"}</b></td><td>${r.purchases || "-"}</td><td>${won(r.cpa)}</td></tr>`).join("");
    root.innerHTML = `<div style="overflow-x:auto"><table class="cw-tbl cw-perf-tbl"><thead><tr>
      <th>${level === "ad" ? "광고" : level === "adset" ? "광고세트" : "캠페인"}</th><th>지출</th><th>노출</th><th>클릭</th><th>CTR</th><th>ROAS</th><th>구매</th><th>CPA</th>
      </tr></thead><tbody>${trs}</tbody>
      <tfoot><tr><td>합계 (${rows.length})</td><td>${won(sum.spend)}</td><td colspan="4"></td><td>${sum.purchases || "-"}</td><td>${won(sum.purchases ? Math.round(sum.spend / sum.purchases) : 0)}</td></tr></tfoot>
      </table></div>`;
  }

  function toast(msg) {
    let t = $("cwToast");
    if (!t) { t = document.createElement("div"); t.id = "cwToast"; t.className = "cw-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
