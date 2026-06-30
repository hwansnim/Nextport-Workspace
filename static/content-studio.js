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

    loadProducts();
    renderStudio();
  }

  function switchPane(name) {
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
    document.querySelectorAll(".cw-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    if (name === "products") { resetProductForm(); loadProducts(); }
    if (name === "library") loadLibrary();
    if (name === "productions") loadProductions();
    if (name === "shoot") renderShoot();
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

  /* ─── 촬영 기획안 생성 ─── */
  async function genShoot() {
    const p = activeProj(); if (!p || !p.plan.length) return;
    p.shootLoading = true; switchPane("shoot"); renderShoot();
    try {
      const r = await fetch("/api/content/shoot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: p.plan, product: state.product }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "생성 실패");
      p.shoot = j.shots || [];
    } catch (e) { alert(e.message); }
    p.shootLoading = false; renderShoot();
  }
  function renderShoot() {
    const root = $("shootWrap"); if (!root) return;
    const p = activeProj();
    if (p && p.shootLoading) { root.innerHTML = progressCard(60, "촬영 콘티 생성 중...", "기획안을 컷별 샷 리스트로 변환하는 중"); return; }
    if (!p || !(p.shoot && p.shoot.length)) {
      root.innerHTML = `<div class="empty">기획안 스튜디오에서 <b>[📹 촬영 기획안]</b> 버튼을 누르면 여기에 컷별 콘티가 나옵니다.</div>`;
      return;
    }
    const rows = p.shoot.map((s, i) => `<tr>
      <td class="cw-no">${esc(s.scene || (i + 1))}</td>
      <td class="cw-narr">${esc(s.visual)}</td>
      <td class="cw-dir">${esc(s.shot)}</td>
      <td class="cw-dir">${esc(s.setup)}</td>
      <td class="cw-cap">${esc(s.caption)}</td>
      <td>${esc(s.narration)}</td>
      <td class="cw-dir">${esc(s.note)}</td></tr>`).join("");
    root.innerHTML = `<div class="card"><div class="cw-card-h">📹 ${esc(p.name)} 촬영 콘티 <span class="hint">${state.product.name ? "· " + esc(state.product.name) : ""}</span>
      <button class="cw-tb-btn" id="shootCopy" style="float:right">📋 노션용 복사</button></div>
      <div style="overflow-x:auto"><table class="cw-tbl"><thead><tr>
      <th class="cw-no">컷</th><th>화면 구성</th><th>샷·앵글</th><th>소품·세팅</th><th>자막</th><th>나레이션</th><th>비고</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div>`;
    $("shootCopy").addEventListener("click", () => {
      const fields = ["scene", "visual", "shot", "setup", "caption", "narration", "note"];
      const plain = p.shoot.map((s) => fields.map((f) => s[f] || "").join("\t")).join("\n");
      const tr = p.shoot.map((s) => `<tr>` + fields.map((f) => `<td style="border:1px solid #eee;padding:6px;">${esc(s[f]).replace(/\n/g, "<br>")}</td>`).join("") + `</tr>`).join("");
      const html = `<table style="border-collapse:collapse">${tr}</table>`;
      navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]).then(() => toast("촬영 콘티 복사됨")).catch(() => { navigator.clipboard.writeText(plain); toast("복사됨"); });
    });
  }

  /* ─── 제작 관리 (누적·공유) ─── */
  const PM_CAT = { shoot: "촬영", noshoot: "미촬영" };
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
    const rows = state.productions.map((r) => `<tr>
      <td><b>${esc(r.title)}</b></td>
      <td class="cw-pm-date">${esc(r.date)}</td>
      <td>${esc(r.user)}</td>
      <td>${esc(r.brand)}</td>
      <td>${esc(r.product)}</td>
      <td><span class="cw-cat cw-cat-${esc(r.category || "noshoot")}">${PM_CAT[r.category] || "미촬영"}</span></td>
      <td class="cw-pm-note">${esc(r.note)}</td>
      <td class="cw-pm-act">
        <button class="btn-text" data-open="${esc(r.id)}">기획안</button>
        <button class="btn-text" data-pmedit="${esc(r.id)}">수정</button>
        <button class="btn-text" data-pmdel="${esc(r.id)}">삭제</button></td></tr>`).join("");
    root.innerHTML = `<div style="overflow-x:auto"><table class="cw-tbl cw-pm-tbl"><thead><tr>
      <th>제목</th><th>날짜</th><th>사용자</th><th>브랜드</th><th>제품</th><th>분류</th><th>비고</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
    root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openInStudio(b.dataset.open)));
    root.querySelectorAll("[data-pmedit]").forEach((b) => b.addEventListener("click", () => editPm(b.dataset.pmedit)));
    root.querySelectorAll("[data-pmdel]").forEach((b) => b.addEventListener("click", () => deletePm(b.dataset.pmdel)));
  }
  function openInStudio(id) {
    const r = state.productions.find((x) => x.id === id); if (!r) return;
    switchPane("studio");
    if (r.product_id) {
      const sel = $("prodPick");
      if ([...sel.options].some((o) => o.value === r.product_id)) { sel.value = r.product_id; pickProduct(r.product_id); }
    } else if (r.product) {
      state.product = { id: "", name: r.product, features: "", brand: r.brand || "", op_type: "own", appeals: [] };
      $("prodName").value = r.product; refreshGen();
    }
    toast("기획안 스튜디오 — 레퍼런스 영상을 올리고 생성하세요");
  }
  function editPm(id) {
    const r = state.productions.find((x) => x.id === id); if (!r) return;
    $("pmTitle").value = r.title || ""; $("pmDate").value = r.date || ""; $("pmUser").value = r.user || "";
    $("pmBrand").value = r.brand || ""; $("pmProduct").value = r.product || ""; $("pmCategory").value = r.category || "noshoot"; $("pmNote").value = r.note || "";
    $("pmProductPick").value = r.product_id && [...$("pmProductPick").options].some((o) => o.value === r.product_id) ? r.product_id : "";
    $("pmSave").dataset.editId = id; $("pmFormTitle").textContent = "항목 수정"; $("pmReset").hidden = false;
  }
  function resetPmForm() {
    ["pmTitle", "pmDate", "pmUser", "pmBrand", "pmProduct", "pmNote"].forEach((id) => { if ($(id)) $(id).value = ""; });
    if ($("pmCategory")) $("pmCategory").value = "noshoot";
    if ($("pmProductPick")) $("pmProductPick").value = "";
    if ($("pmSave")) delete $("pmSave").dataset.editId;
    if ($("pmFormTitle")) $("pmFormTitle").textContent = "새 항목 추가";
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

  function toast(msg) {
    let t = $("cwToast");
    if (!t) { t = document.createElement("div"); t.id = "cwToast"; t.className = "cw-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
