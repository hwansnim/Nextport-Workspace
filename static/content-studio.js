/*
 * 콘텐츠 스튜디오 — 레퍼런스 분석 + 기획안 생성 (AI Studio 이식, 서버사이드 Gemini).
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  const state = { projects: [], active: 0, product: { name: "", features: "" } };

  function init() {
    // 워크스페이스 전환 드롭다운
    const wb = $("wsBrand"), wd = $("wsDropdown");
    if (wb && wd) {
      wb.addEventListener("click", (e) => { if (e.target.closest(".ws-dd-item")) return; e.stopPropagation(); wd.hidden = !wd.hidden; });
      document.addEventListener("click", () => { wd.hidden = true; });
    }
    // 좌측 탭 전환
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.addEventListener("click", () => switchPane(b.dataset.pane)));
    // 영상 업로드
    const drop = $("videoDrop"), input = $("videoFile");
    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { handleVideos([...input.files]); input.value = ""; });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); handleVideos([...e.dataTransfer.files].filter((f) => f.type.startsWith("video/"))); });
    // 제품 정보
    $("prodName").addEventListener("input", (e) => { state.product.name = e.target.value; refreshGenBtn(); });
    $("prodFeatures").addEventListener("input", (e) => { state.product.features = e.target.value; });
    // USP 추출
    $("uspUrlBtn").addEventListener("click", () => extractUrl($("uspUrl").value.trim()));
    $("uspUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") extractUrl($("uspUrl").value.trim()); });
    $("uspFileBtn").addEventListener("click", () => $("uspFile").click());
    $("uspFile").addEventListener("change", () => { if ($("uspFile").files[0]) extractFile($("uspFile").files[0]); $("uspFile").value = ""; });
    // 생성/수정
    $("genPlanBtn").addEventListener("click", genPlan);
    $("refineBtn").addEventListener("click", () => refine($("refineInput").value.trim()));
  }

  function switchPane(name) {
    document.querySelectorAll(".cw-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
    document.querySelectorAll(".cw-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    if (name === "plan") { renderPlan(); refreshGenBtn(); }
  }

  function activeProj() { return state.projects[state.active]; }

  // ── 영상 → 프로젝트 생성 + 자동 분석 ──
  function handleVideos(files) {
    files.filter((f) => f.type.startsWith("video/")).forEach((file) => {
      const proj = { id: Math.random().toString(36).slice(2), name: "기획안 " + String.fromCharCode(65 + state.projects.length), file, url: URL.createObjectURL(file), analysis: [], plan: [], status: "analyzing", error: "" };
      state.projects.push(proj);
      state.active = state.projects.length - 1;
      analyzeProject(proj);
    });
    renderProjTabs(); renderAnalyze();
  }

  async function analyzeProject(proj, feedback) {
    proj.status = "analyzing"; proj.error = "";
    renderProjTabs(); renderAnalyze();
    try {
      const fd = new FormData();
      fd.append("video", proj.file, proj.file.name);
      if (feedback) fd.append("feedback", feedback);
      const r = await fetch("/api/content/analyze", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "분석 실패");
      proj.analysis = j.analysis || [];
      proj.status = "analyzed";
    } catch (e) {
      proj.status = "idle"; proj.error = e.message;
    }
    renderProjTabs(); renderAnalyze(); refreshGenBtn();
  }

  function renderProjTabs() {
    const root = $("projTabs");
    if (!state.projects.length) { root.innerHTML = ""; return; }
    root.innerHTML = state.projects.map((p, i) => {
      const dot = p.status === "analyzing" ? "working" : (p.status === "analyzed" ? "done" : "");
      return `<div class="cw-proj ${i === state.active ? "active" : ""}" data-i="${i}">
        <span class="cw-proj-dot ${dot}"></span><span>${esc(p.name)}</span>
        <button class="cw-proj-x" data-del="${i}" title="삭제">×</button>
      </div>`;
    }).join("") + `<button class="cw-proj-add" id="projAdd" title="영상 추가">+</button>`;
    root.querySelectorAll(".cw-proj").forEach((el) => el.addEventListener("click", (e) => { if (e.target.dataset.del == null) { state.active = +el.dataset.i; renderProjTabs(); renderAnalyze(); refreshGenBtn(); } }));
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); delProject(+b.dataset.del); }));
    $("projAdd")?.addEventListener("click", () => $("videoFile").click());
  }

  function delProject(i) {
    if (!confirm("이 기획안을 삭제할까요?")) return;
    state.projects.splice(i, 1);
    state.active = Math.max(0, Math.min(state.active, state.projects.length - 1));
    renderProjTabs(); renderAnalyze(); renderPlan(); refreshGenBtn();
  }

  function renderAnalyze() {
    const body = $("analyzeBody");
    if (!state.projects.length) {
      body.innerHTML = `<div class="cw-drop" id="videoDrop2"><div class="cw-drop-ico">🎞️</div><div><b>레퍼런스 영상</b>을 끌어다 놓거나 <b>클릭</b></div><div class="hint">올리면 자동 분석</div></div>`;
      $("videoDrop2").addEventListener("click", () => $("videoFile").click());
      return;
    }
    const p = activeProj();
    let inner = `<div class="cw-analyze-split">
      <div class="cw-vid card"><video src="${esc(p.url)}" controls playsinline></video></div>
      <div class="cw-atable card">`;
    if (p.status === "analyzing") {
      inner += `<div class="cw-loading"><div class="cw-spin"></div><div>레퍼런스 분석 중… (영상 길이에 따라 20초~1분)</div></div>`;
    } else if (p.error) {
      inner += `<div class="empty" style="color:#e0245e">❌ ${esc(p.error)}</div>`;
    } else {
      inner += analysisTable(p);
    }
    inner += `</div></div>`;
    body.innerHTML = inner;
    if (p.status === "analyzed") wireAnalyzeEdits(p);
  }

  function analysisTable(p) {
    const rows = p.analysis.map((a, i) => `<tr>
      <td class="cw-no">${esc(a.no)}</td>
      <td class="cw-ts" data-edit data-i="${i}" data-f="timestamp">${esc(a.timestamp)}</td>
      <td data-edit data-i="${i}" data-f="narration">${esc(a.narration)}</td>
      <td data-edit data-i="${i}" data-f="caption">${esc(a.caption)}</td>
      <td data-edit data-i="${i}" data-f="visual">${esc(a.visual)}</td>
    </tr>`).join("");
    return `<table class="cw-tbl">
      <thead><tr><th>No</th><th>타임</th><th>나레이션</th><th>자막</th><th>연출</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="cw-reanalyze">
        <input type="text" id="reanalyzeInput" placeholder="재분석 피드백 (예: 자막 구분 더 정확히)" />
        <button class="btn-secondary" id="reanalyzeBtn">↻ 재분석</button>
      </div>`;
  }

  function wireAnalyzeEdits(p) {
    document.querySelectorAll("#analyzeBody [data-edit]").forEach((td) => {
      td.contentEditable = "true";
      td.addEventListener("blur", () => { p.analysis[+td.dataset.i][td.dataset.f] = td.innerText; });
    });
    $("reanalyzeBtn")?.addEventListener("click", () => { if (p.file) analyzeProject(p, $("reanalyzeInput").value.trim()); });
  }

  // ── USP 추출 ──
  async function extractUrl(url) {
    if (!url || !url.startsWith("http")) { alert("URL을 입력하세요."); return; }
    uspBusy(true);
    try {
      const r = await fetch("/api/content/usp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "추출 실패");
      applyProduct(j.product); $("uspUrl").value = "";
    } catch (e) { alert(e.message); } finally { uspBusy(false); }
  }
  async function extractFile(file) {
    uspBusy(true);
    try {
      const fd = new FormData(); fd.append("file", file, file.name);
      const r = await fetch("/api/content/usp", { method: "POST", body: fd });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "추출 실패");
      applyProduct(j.product);
    } catch (e) { alert(e.message); } finally { uspBusy(false); }
  }
  function applyProduct(prod) {
    if (!prod) return;
    state.product.name = prod.name || ""; state.product.features = prod.features || "";
    $("prodName").value = state.product.name; $("prodFeatures").value = state.product.features;
    refreshGenBtn();
  }
  function uspBusy(b) { $("uspStatus").textContent = b ? "분석 중…" : ""; $("uspUrlBtn").disabled = b; $("uspFileBtn").disabled = b; }

  // ── 기획안 생성 / 수정 ──
  function refreshGenBtn() {
    const p = activeProj();
    const ready = p && p.analysis.length > 0 && state.product.name.trim();
    const btn = $("genPlanBtn");
    if (btn) btn.disabled = !ready;
    const hint = $("genHint");
    if (hint) hint.textContent = !p || !p.analysis.length ? "먼저 레퍼런스 분석 탭에서 영상을 분석하세요." : (!state.product.name.trim() ? "제품명을 입력하세요." : "");
    $("planRefName").textContent = p ? "· " + p.name + " 기반" : "";
  }

  async function genPlan() {
    const p = activeProj(); if (!p || !p.analysis.length) return;
    $("genPlanBtn").disabled = true; $("genPlanBtn").textContent = "생성 중…";
    $("planBody").innerHTML = `<div class="cw-loading"><div class="cw-spin"></div><div>기획안 생성 중…</div></div>`;
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "생성 실패");
      p.plan = j.plan || []; renderPlan();
    } catch (e) { $("planBody").innerHTML = `<div class="empty" style="color:#e0245e">❌ ${esc(e.message)}</div>`; }
    finally { $("genPlanBtn").disabled = false; $("genPlanBtn").textContent = "✨ 기획안 생성"; refreshGenBtn(); }
  }

  async function refine(feedback) {
    const p = activeProj(); if (!p || !feedback) return;
    $("refineBtn").disabled = true;
    try {
      const r = await fetch("/api/content/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis, product: state.product, feedback }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "수정 실패");
      p.plan = j.plan || []; $("refineInput").value = ""; renderPlan();
    } catch (e) { alert(e.message); } finally { $("refineBtn").disabled = false; }
  }

  function renderPlan() {
    const p = activeProj();
    const body = $("planBody"), refine = $("refineBox");
    if (!p || !p.plan.length) {
      body.innerHTML = `<div class="empty">아직 생성된 기획안이 없습니다. 제품 정보 입력 후 [기획안 생성]을 누르세요.</div>`;
      if (refine) refine.hidden = true; return;
    }
    const edit = !!state.planEdit;
    const cell = (i, f, cls) => edit
      ? `<td class="${cls}"><textarea class="cw-pedit" data-i="${i}" data-f="${f}">${esc(p.plan[i][f])}</textarea></td>`
      : `<td class="${cls}">${esc(p.plan[i][f])}</td>`;
    const rows = p.plan.map((a, i) => `<tr>
      <td class="cw-no">${esc(a.no)}</td>
      ${cell(i, "narration", "cw-pl-narr")}
      ${cell(i, "caption", "cw-pl-cap")}
      ${cell(i, "direction", "cw-pl-dir")}
    </tr>`).join("");
    body.innerHTML = `
      <div class="cw-plan-actions">
        <button class="btn-text" id="planEditToggle">${edit ? "💾 변경사항 저장" : "✏️ 직접 수정"}</button>
        ${edit ? "" : `<button class="btn-text" id="planCopyNotion">📋 노션용 복사</button>
        <button class="btn-text" id="planCopyNarr">나레이션 복사</button>
        <button class="btn-text" id="planCopyCap">자막 복사</button>`}
      </div>
      <table class="cw-tbl cw-plan-tbl">
        <thead><tr><th style="width:34px">No</th><th style="width:35%">신규 나레이션</th><th style="width:35%">신규 자막</th><th>연출</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    if (refine) refine.hidden = edit;
    $("planEditToggle")?.addEventListener("click", () => togglePlanEdit(p));
    $("planCopyNotion")?.addEventListener("click", () => copyNotion(p));
    $("planCopyNarr")?.addEventListener("click", () => copyColumn(p, "narration", "나레이션"));
    $("planCopyCap")?.addEventListener("click", () => copyColumn(p, "caption", "자막"));
  }

  function togglePlanEdit(p) {
    if (state.planEdit) {
      document.querySelectorAll("#planBody .cw-pedit").forEach((ta) => { p.plan[+ta.dataset.i][ta.dataset.f] = ta.value; });
    }
    state.planEdit = !state.planEdit;
    renderPlan();
  }

  function copyColumn(p, field, label) {
    const text = p.plan.map((a) => a[field]).filter((t) => t && t.trim()).join("\n");
    navigator.clipboard.writeText(text).then(() => toast(`신규 ${label} 복사됨`));
  }

  // 노션용 복사 — 원본처럼 빨간 글씨 HTML 표
  async function copyNotion(p) {
    const rows = p.plan.map((e) => `<tr>` +
      [e.narration, e.caption, e.direction].map((v) =>
        `<td style="border:1px solid #eeeeee;padding:8px;color:#ff0000;">${esc(v).replace(/\n/g, "<br>")}</td>`).join("") +
      `</tr>`).join("");
    const html = `<table style="border-collapse:collapse;width:100%;font-family:sans-serif;">${rows}</table>`;
    const plain = p.plan.map((e) => `${e.narration}\t${e.caption}\t${e.direction}`).join("\n");
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      toast("노션용(빨간 글씨)으로 복사됨");
    } catch (e) { navigator.clipboard.writeText(plain); toast("텍스트로 복사됨"); }
  }

  function toast(msg) {
    let t = document.getElementById("cwToast");
    if (!t) { t = document.createElement("div"); t.id = "cwToast"; t.className = "cw-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
