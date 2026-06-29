/*
 * 엑셀 자동 DM 발송 — 회사 DM_Sender v2.2.2 양식 그대로.
 * 엑셀 업로드 → /api/dm/excel/run → 잡 폴링 → 진행로그 → 결과 엑셀 다운로드.
 * ⚠ 로컬 PC 전용 (인스타가 클라우드 차단).
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let file = null;
  let jobId = null;
  let poll = null;

  function ready() {
    const drop = $("dmxDrop");
    if (!drop) return; // 탭 미존재
    const input = $("dmxFile");

    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { if (input.files[0]) setFile(input.files[0]); });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dmx-drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dmx-drag"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("dmx-drag");
      const f = [...(e.dataTransfer.files || [])].find((x) => x.name.toLowerCase().endsWith(".xlsx"));
      if (f) setFile(f); else alert("엑셀(.xlsx) 파일만 됩니다.");
    });

    $("dmxStart").addEventListener("click", start);
    $("dmxStop").addEventListener("click", stop);
    document.querySelectorAll(".dmx-preset").forEach((b) => b.addEventListener("click", () => setPreset(b.dataset.preset)));
    document.querySelectorAll("[data-v2='dmx-mode']").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    const addBtn = $("dmmAddBtn"); if (addBtn) addBtn.addEventListener("click", addAccount);
    const sendBtn = $("dmmSendBtn"); if (sendBtn) sendBtn.addEventListener("click", startManual);
    // 실시간 발송 엔진 상태 — 항상 폴링 (링크 어디서나 확인)
    if ($("dmEngine")) { pollEngine(); setInterval(pollEngine, 4000); }
  }

  function ageText(sec) {
    if (sec == null) return "방금";
    if (sec < 60) return sec + "초 전";
    const m = Math.floor(sec / 60);
    return m < 60 ? m + "분 전" : Math.floor(m / 60) + "시간 전";
  }
  async function pollEngine() {
    const dot = $("dmEngineDot"), txt = $("dmEngineTxt"), det = $("dmEngineDetail");
    if (!dot) return;
    try {
      const r = await fetch("/api/dm/status");
      const s = await r.json();
      const j = s.job || {};
      const stats = (j.total != null)
        ? `성공 ${j.sent || 0} · 실패 ${j.failed || 0}${j.held ? " · 보류 " + j.held : ""} / 총 ${j.total}`
        : "";
      dot.className = "dm-engine-dot e-" + s.engine;
      if (s.engine === "running") {
        txt.textContent = "🟢 발송 중";
        det.textContent = `${j.current ? "지금 " + j.current + " · " : ""}${stats} · 마지막 활동 ${ageText(s.age_seconds)}`;
      } else if (s.engine === "stale") {
        txt.textContent = "🔴 멈춘 것 같음";
        det.textContent = `마지막 활동 ${ageText(s.age_seconds)} — 발송기(PC) 확인 필요`;
      } else if (s.engine === "error") {
        txt.textContent = "⚠️ 오류로 멈춤";
        det.textContent = (stats ? stats + " · " : "") + "로그 확인하세요";
      } else {
        txt.textContent = "🟡 대기 중";
        det.textContent = (j.total != null) ? "최근 발송: " + stats : "발송 작업 없음";
      }
    } catch (e) {
      dot.className = "dm-engine-dot e-off";
      txt.textContent = "⚪ 서버 응답 없음";
      det.textContent = "앱이 꺼져 있거나 연결이 안 됨";
    }
  }

  // ── 엑셀 / 수동 모드 전환 ──
  let accountsLoaded = false;
  function setMode(m) {
    document.querySelectorAll("[data-v2='dmx-mode']").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    const ex = m !== "manual";
    if ($("dmxModeExcel")) $("dmxModeExcel").hidden = !ex;
    if ($("dmxModeManual")) $("dmxModeManual").hidden = ex;
    if ($("dmxExcelFollow")) $("dmxExcelFollow").style.display = ex ? "" : "none";
    if ($("dmxStart")) $("dmxStart").style.display = ex ? "" : "none";
    if (!ex && !accountsLoaded) { accountsLoaded = true; loadSenderAccounts(); }
  }

  // ── 내 계정 저장/관리 ──
  async function loadSenderAccounts() {
    try {
      const r = await fetch("/api/dm/sender-accounts");
      const j = await r.json();
      renderAccounts(j.accounts || []);
    } catch (e) { $("dmmList").innerHTML = `<div class="hint">계정 불러오기 실패</div>`; }
  }
  function renderAccounts(accs) {
    const list = $("dmmList"), sel = $("dmmAccount");
    if (!accs.length) {
      list.innerHTML = `<div class="hint">저장된 계정 없음 — 아래에서 추가하세요</div>`;
    } else {
      list.innerHTML = accs.map((a) => `<div class="dmm-acc"><span><b>@${escapeHtml(a.username)}</b>${a.name ? " · " + escapeHtml(a.name) : ""}</span><button class="btn-text" data-del="${a.id}">삭제</button></div>`).join("");
      list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteAccount(b.dataset.del)));
    }
    if (sel) sel.innerHTML = accs.length
      ? accs.map((a) => `<option value="${a.id}">@${escapeHtml(a.username)}${a.name ? " (" + escapeHtml(a.name) + ")" : ""}</option>`).join("")
      : `<option value="">먼저 계정을 저장하세요</option>`;
  }
  async function addAccount() {
    const username = $("dmmNewUser").value.trim();
    const password = $("dmmNewPw").value;
    const name = $("dmmNewName").value.trim();
    if (!username || !password) { alert("아이디와 비밀번호를 입력하세요."); return; }
    try {
      const r = await fetch("/api/dm/sender-accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "실패");
      $("dmmNewUser").value = ""; $("dmmNewPw").value = ""; $("dmmNewName").value = "";
      loadSenderAccounts();
      if (window.showToast) window.showToast({ icon: "✅", title: "계정 저장됨", body: "@" + username });
    } catch (e) { alert("저장 실패: " + e.message); }
  }
  async function deleteAccount(id) {
    if (!confirm("이 계정을 삭제할까요?")) return;
    try { await fetch("/api/dm/sender-accounts/" + id, { method: "DELETE" }); loadSenderAccounts(); } catch (e) {}
  }

  // ── 수동 발송 ──
  async function startManual() {
    const account_id = $("dmmAccount").value;
    if (!account_id) { alert("보내는 계정을 먼저 저장·선택하세요."); return; }
    const target_id = $("dmmTargetId").value.trim();
    if (!target_id) { alert("받는 사람 ID를 입력하세요."); return; }
    const message = $("dmmMessage").value.trim();
    if (!message) { alert("메시지를 입력하세요."); return; }
    if (!confirm(`@${target_id} 에게 DM을 보낼까요?\n\n• 브라우저 창 없이 백그라운드로 발송됩니다\n• 안전 설정(간격/한도) 적용됩니다`)) return;
    const body = {
      account_id, target_id, target_name: $("dmmTargetName").value.trim(), message,
      auto_follow: $("dmmAutoFollow").checked,
      daily_limit: $("dmxDaily").value, batch_limit: $("dmxBatch").value,
      gap_min: $("dmxGapMin").value, gap_max: $("dmxGapMax").value, break_every: $("dmxBreakEvery").value,
    };
    $("dmmSendBtn").disabled = true; $("dmmSendBtn").textContent = "시작 중…";
    try {
      const r = await fetch("/api/dm/manual/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "실패");
      beginJob(j.job_id, j.total);
      log(`▶ 수동 발송 시작 — @${target_id}`);
    } catch (e) {
      alert("발송 시작 실패: " + e.message);
    } finally {
      $("dmmSendBtn").disabled = false; $("dmmSendBtn").textContent = "▶ 수동 발송 (1명)";
    }
  }

  // 공통 — 잡 시작 후 진행/로그/폴링 셋업 (엑셀·수동 공유)
  function beginJob(jid, total) {
    jobId = jid;
    $("dmxTotal").textContent = total;
    $("dmxProgress").hidden = false;
    $("dmxLog").hidden = false;
    $("dmxLog").innerHTML = "";
    lastLogLen = 0;
    $("dmxStop").hidden = false;
    $("dmxResult").hidden = true;
    if (poll) clearInterval(poll);
    poll = setInterval(tick, 1500);
    tick();
  }

  function setPreset(p) {
    document.querySelectorAll(".dmx-preset").forEach((b) => b.classList.toggle("active", b.dataset.preset === p));
    const v = p === "fast"
      ? { daily: 50, batch: 15, gmin: 25, gmax: 90, brk: 8 }   // 표준(위험↑)
      : { daily: 30, batch: 10, gmin: 60, gmax: 300, brk: 6 }; // 안전(권장)
    $("dmxDaily").value = v.daily; $("dmxBatch").value = v.batch;
    $("dmxGapMin").value = v.gmin; $("dmxGapMax").value = v.gmax; $("dmxBreakEvery").value = v.brk;
  }

  function setFile(f) {
    file = f;
    $("dmxDropText").innerHTML = `📎 <b>${escapeHtml(f.name)}</b> 선택됨`;
    $("dmxStart").disabled = false;
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

  async function start() {
    if (!file) return;
    if (!confirm("자동 DM 발송을 시작할까요?\n\n• 브라우저 창 없이 백그라운드로 조용히 발송됩니다\n• 인스타에 사람처럼 천천히 보냅니다\n• 계정이 막힐 수 있으니 과하게 돌리지 마세요")) return;

    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("auto_follow", $("dmxAutoFollow").checked ? "1" : "0");
    fd.append("daily_limit", $("dmxDaily").value || "30");
    fd.append("batch_limit", $("dmxBatch").value || "10");
    fd.append("gap_min", $("dmxGapMin").value || "60");
    fd.append("gap_max", $("dmxGapMax").value || "300");
    fd.append("break_every", $("dmxBreakEvery").value || "6");

    $("dmxStart").disabled = true;
    $("dmxStart").textContent = "시작 중…";
    try {
      const r = await fetch("/api/dm/excel/run", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) { throw new Error(j.error || "실패"); }
      beginJob(j.job_id, j.total);
      $("dmxStart").textContent = "발송 중…";
      log(`▶ 발송 시작 — ${j.total}건 / 계정 ${j.accounts}개`);
    } catch (e) {
      alert("발송 시작 실패: " + e.message);
      $("dmxStart").disabled = false;
      $("dmxStart").textContent = "▶ 발송 시작";
    }
  }

  async function tick() {
    if (!jobId) return;
    try {
      const r = await fetch(`/api/dm/jobs/${jobId}`);
      const s = await r.json();
      const held = s.held || 0;
      const attempted = (s.sent || 0) + (s.failed || 0);
      $("dmxDone").textContent = attempted;
      $("dmxSent").textContent = s.sent || 0;
      $("dmxFailed").textContent = s.failed || 0;
      const hb = $("dmxHeld"); if (hb) hb.textContent = held;
      $("dmxCur").textContent = s.current ? "→ " + s.current : "";
      const pct = s.total ? Math.round(((attempted + held) / s.total) * 100) : 0;
      $("dmxBar").style.width = pct + "%";
      renderLog(s.log || []);
      if (s.status === "done" || s.status === "error") {
        clearInterval(poll); poll = null;
        finish(s);
      }
    } catch (e) { /* 무시 — 다음 폴에서 복구 */ }
  }

  function finish(s) {
    $("dmxStop").hidden = true;
    $("dmxStart").disabled = false;
    $("dmxStart").textContent = "▶ 발송 시작";
    const res = $("dmxResult");
    res.href = `/api/dm/excel/result/${jobId}`;
    res.hidden = false;
    const held = s.held || 0;
    log(s.status === "error" ? "❌ 오류로 종료 — 결과 엑셀 확인" : `🏁 완료 — 성공 ${s.sent || 0} / 실패 ${s.failed || 0}${held ? " / 보류 " + held : ""}`);
    if (window.showToast) window.showToast({ icon: s.status === "error" ? "⚠️" : "✅", title: "DM 발송 종료", body: `성공 ${s.sent || 0} · 실패 ${s.failed || 0}${held ? " · 보류 " + held : ""}`, accent: true, ttl: 6000 });
  }

  async function stop() {
    if (!jobId) return;
    $("dmxStop").textContent = "중지 중…";
    try { await fetch(`/api/dm/jobs/${jobId}/stop`, { method: "POST" }); } catch (e) {}
    log("⏹ 중지 요청 — 현재 발송 끝나면 멈춥니다");
    setTimeout(() => { $("dmxStop").textContent = "⏹ 중지"; }, 1500);
  }

  let lastLogLen = 0;
  function renderLog(lines) {
    if (lines.length === lastLogLen) return;
    lastLogLen = lines.length;
    const box = $("dmxLog");
    box.innerHTML = lines.slice(-200).map((l) => `<div class="dmx-log-line">${escapeHtml(l)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }
  function log(msg) {
    const box = $("dmxLog");
    if (!box) return;
    box.hidden = false;
    const d = document.createElement("div");
    d.className = "dmx-log-line";
    d.textContent = msg;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
