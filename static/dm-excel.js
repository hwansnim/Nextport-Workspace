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
    if (!confirm("자동 DM 발송을 시작할까요?\n\n• 크롬 창이 자동으로 열립니다 (끄지 마세요)\n• 인스타에 사람처럼 천천히 보냅니다\n• 계정이 막힐 수 있으니 과하게 돌리지 마세요")) return;

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
      jobId = j.job_id;
      $("dmxTotal").textContent = j.total;
      $("dmxProgress").hidden = false;
      $("dmxLog").hidden = false;
      $("dmxLog").innerHTML = "";
      $("dmxStop").hidden = false;
      $("dmxResult").hidden = true;
      $("dmxStart").textContent = "발송 중…";
      log(`▶ 발송 시작 — ${j.total}건 / 계정 ${j.accounts}개`);
      poll = setInterval(tick, 1500);
      tick();
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
