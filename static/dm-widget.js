/*
 * 넥스트포트 영업 (DM) 위젯 — 격리된 namespace
 * 의존: app.js의 api(), escapeHtml(), $, $$ 만 사용
 */
(function () {
  if (!window.api) {
    console.warn("[DM] app.js 안 로드됨");
    return;
  }

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));

  const dm = {
    accounts: [],
    targets: [],
    templates: [],
    selected: new Set(),
    jobId: null,
    pollTimer: null,
  };

  const STATUS_LABEL = {
    active: "활성", warmup: "워밍업", blocked: "차단됨", disabled: "비활성",
    pending: "미발송", sending: "발송중", sent: "발송완료", replied: "답장받음", failed: "실패",
  };

  // ─── LOAD ──────────────────────────────────────────────
  async function loadAccounts() {
    try {
      const r = await api("/api/dm/accounts");
      dm.accounts = r.accounts || [];
      renderAccounts();
    } catch (e) { console.error(e); }
  }
  async function loadTargets() {
    try {
      const r = await api("/api/dm/targets");
      dm.targets = r.targets || [];
      renderTargets();
    } catch (e) { console.error(e); }
  }
  async function loadTemplates() {
    try {
      const r = await api("/api/dm/templates");
      dm.templates = r.templates || [];
      renderTemplates();
      // 발송 셀렉트 채우기
      const sel = $("#dmSendTemplate");
      if (sel) {
        sel.innerHTML = `<option value="">템플릿 선택…</option>` +
          dm.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
      }
      // 템플릿 다이얼로그 브랜드 셀렉트
      const bs = $("#dmTemplateForm")?.elements?.brand_id;
      if (bs && window.state?.brands) {
        const prev = bs.value;
        bs.innerHTML = `<option value="">(없음)</option>` +
          window.state.brands.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
        bs.value = prev;
      }
    } catch (e) { console.error(e); }
  }

  // ─── RENDER ────────────────────────────────────────────
  function renderAccounts() {
    const body = $("#dmAccountsBody");
    if (!body) return;
    const stat = $("#dmPoolStat");
    const active = dm.accounts.filter(a => a.status === "active").length;
    const sentToday = dm.accounts.reduce((s, a) => s + (a.daily_count || 0), 0);
    const limit = dm.accounts.reduce((s, a) => s + (a.daily_limit || 0), 0);
    if (stat) stat.textContent = `${dm.accounts.length}개 (활성 ${active}) · 오늘 ${sentToday}/${limit}`;

    if (!dm.accounts.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty">계정 없음. [+ 계정 추가]</td></tr>`;
      return;
    }
    body.innerHTML = dm.accounts.map(a => {
      const dailyPct = a.daily_limit > 0 ? Math.round((a.daily_count || 0) / a.daily_limit * 100) : 0;
      return `<tr data-aid="${esc(a.id)}">
        <td><b>@${esc(a.username)}</b></td>
        <td>${esc(a.sender_name || "-")}</td>
        <td><span class="dm-chip s-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span></td>
        <td>${a.daily_count || 0} / ${a.daily_limit || 0}
          <div class="dm-mini-bar"><span style="width:${dailyPct}%"></span></div>
        </td>
        <td>${a.total_sent || 0}</td>
        <td style="font-size:11px;color:#888">${a.last_used_at ? a.last_used_at.replace("T", " ").slice(0, 16) : "-"}</td>
        <td><button class="btn-text" data-dm="edit-account" data-id="${esc(a.id)}">✎</button></td>
      </tr>`;
    }).join("");
  }

  function renderTemplates() {
    const root = $("#dmTemplatesList");
    if (!root) return;
    if (!dm.templates.length) {
      root.innerHTML = `<div class="empty">템플릿 없음. [+ 템플릿 추가]</div>`;
      return;
    }
    root.innerHTML = dm.templates.map(t => `
      <div class="dm-template-card" data-dm="edit-template" data-id="${esc(t.id)}">
        <div class="dm-template-name">${esc(t.name)}</div>
        <div class="dm-template-preview">${esc((t.body || "").slice(0, 140))}${t.body && t.body.length > 140 ? "…" : ""}</div>
        <div class="dm-template-meta">발신인: ${esc(t.sender_name || "-")} ${t.brand_id ? `· ${esc(t.brand_id)}` : ""}</div>
      </div>
    `).join("");
  }

  function renderTargets() {
    const body = $("#dmTargetsBody");
    if (!body) return;
    const filter = $("#dmTargetFilter")?.value || "";
    const list = dm.targets.filter(t => !filter || t.status === filter);
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">${filter ? "해당 상태 없음" : "타겟 없음. [+ 타겟 추가]"}</td></tr>`;
      updateBulkBar();
      return;
    }
    body.innerHTML = list.map(t => {
      const isSel = dm.selected.has(t.id);
      return `<tr data-tid="${esc(t.id)}">
        <td><input type="checkbox" class="dm-target-chk" data-id="${esc(t.id)}" ${isSel ? "checked" : ""} /></td>
        <td><b>@${esc(t.username)}</b></td>
        <td>${esc(t.display_name || "-")}</td>
        <td>${esc(t.category || "-")}</td>
        <td>${(t.followers || 0).toLocaleString()}</td>
        <td><span class="dm-chip s-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span></td>
        <td style="font-size:11px;color:#888">${t.last_sent_at ? t.last_sent_at.replace("T", " ").slice(0, 16) : "-"}</td>
        <td><button class="btn-text" data-dm="edit-target" data-id="${esc(t.id)}">✎</button></td>
      </tr>`;
    }).join("");
    updateBulkBar();
  }

  function updateBulkBar() {
    const bar = $("#dmBulkBar");
    const cnt = $("#dmSelectedCount");
    if (!bar || !cnt) return;
    if (dm.selected.size > 0) {
      bar.hidden = false;
      cnt.textContent = `${dm.selected.size}명 선택됨`;
    } else {
      bar.hidden = true;
    }
  }

  // ─── EVENTS ────────────────────────────────────────────
  document.addEventListener("click", (e) => {
    if (!$("#tab-dm")?.classList.contains("active")) return;

    // 체크박스
    const chk = e.target.closest(".dm-target-chk");
    if (chk) {
      if (chk.checked) dm.selected.add(chk.dataset.id);
      else dm.selected.delete(chk.dataset.id);
      updateBulkBar();
      return;
    }

    const trg = e.target.closest("[data-dm]");
    if (!trg) return;
    const what = trg.dataset.dm;
    const id = trg.dataset.id;

    if (what === "edit-account") {
      const a = dm.accounts.find(x => x.id === id);
      openAccountDialog(a);
    } else if (what === "edit-target") {
      const t = dm.targets.find(x => x.id === id);
      openTargetDialog(t);
    } else if (what === "edit-template") {
      const t = dm.templates.find(x => x.id === id);
      openTemplateDialog(t);
    }
  });

  // 전체 선택
  document.addEventListener("change", (e) => {
    if (e.target.id === "dmTargetAll") {
      const filter = $("#dmTargetFilter")?.value || "";
      const list = dm.targets.filter(t => !filter || t.status === filter);
      if (e.target.checked) {
        list.forEach(t => dm.selected.add(t.id));
      } else {
        list.forEach(t => dm.selected.delete(t.id));
      }
      renderTargets();
    }
    if (e.target.id === "dmTargetFilter") {
      renderTargets();
    }
  });

  // ─── 다이얼로그 ────────────────────────────────────────
  function openAccountDialog(a) {
    const f = $("#dmAccountForm");
    f.reset();
    f.elements.id.value = a?.id || "";
    if (a) {
      $("#dmAccountTitle").textContent = `계정 수정 — @${a.username}`;
      f.elements.username.value = a.username || "";
      f.elements.password.value = ""; // 비번 안 박힘 (수정 시 빈칸이면 유지)
      f.elements.password.placeholder = "(변경 시만 입력)";
      f.elements.password.required = false;
      f.elements.sender_name.value = a.sender_name || "";
      f.elements.daily_limit.value = a.daily_limit || 50;
      f.elements.status.value = a.status || "active";
      f.elements.notes.value = a.notes || "";
    } else {
      $("#dmAccountTitle").textContent = "계정 추가";
      f.elements.password.required = true;
      f.elements.password.placeholder = "";
    }
    $("#dmAccountDialog").showModal();
  }

  function openTargetDialog(t) {
    const f = $("#dmTargetForm");
    f.reset();
    f.elements.id.value = t?.id || "";
    if (t) {
      f.elements.username.value = t.username || "";
      f.elements.display_name.value = t.display_name || "";
      f.elements.category.value = t.category || "";
      f.elements.followers.value = t.followers || "";
      f.elements.notes.value = t.notes || "";
    }
    $("#dmTargetDialog").showModal();
  }

  function openTemplateDialog(t) {
    const f = $("#dmTemplateForm");
    f.reset();
    f.elements.id.value = t?.id || "";
    if (t) {
      $("#dmTemplateTitle").textContent = `템플릿 수정 — ${t.name}`;
      f.elements.name.value = t.name || "";
      f.elements.sender_name.value = t.sender_name || "";
      f.elements.brand_id.value = t.brand_id || "";
      f.elements.body.value = t.body || "";
    } else {
      $("#dmTemplateTitle").textContent = "템플릿 추가";
    }
    $("#dmTemplateDialog").showModal();
  }

  function openBulkDialog(kind) {
    const f = $("#dmBulkForm");
    f.reset();
    f.elements.kind.value = kind;
    if (kind === "accounts") {
      $("#dmBulkTitle").textContent = "계정 일괄 등록";
      $("#dmBulkHint").innerHTML = "각 줄: <code>username\\tpassword\\tsender_name</code> (탭/쉼표 구분)";
    } else {
      $("#dmBulkTitle").textContent = "타겟 일괄 등록";
      $("#dmBulkHint").innerHTML = "각 줄: <code>username\\tdisplay_name\\tcategory\\tfollowers</code>";
    }
    $("#dmBulkDialog").showModal();
  }

  // ─── 버튼 ──────────────────────────────────────────────
  document.addEventListener("click", async (e) => {
    if (e.target.id === "btnDmAccountAdd") return openAccountDialog(null);
    if (e.target.id === "btnDmAccountBulk") return openBulkDialog("accounts");
    if (e.target.id === "btnDmTargetAdd") return openTargetDialog(null);
    if (e.target.id === "btnDmTargetBulk") return openBulkDialog("targets");
    if (e.target.id === "btnDmTemplateAdd") return openTemplateDialog(null);

    if (e.target.closest('[data-action="cancel-dm-account"]')) return $("#dmAccountDialog").close();
    if (e.target.closest('[data-action="cancel-dm-target"]')) return $("#dmTargetDialog").close();
    if (e.target.closest('[data-action="cancel-dm-template"]')) return $("#dmTemplateDialog").close();
    if (e.target.closest('[data-action="cancel-dm-bulk"]')) return $("#dmBulkDialog").close();

    if (e.target.closest('[data-action="delete-dm-account"]')) {
      const id = $("#dmAccountForm").elements.id.value;
      if (!id || !confirm("계정 삭제?")) return;
      await api(`/api/dm/accounts/${id}`, { method: "DELETE" });
      $("#dmAccountDialog").close();
      await loadAccounts();
      return;
    }
    if (e.target.closest('[data-action="delete-dm-target"]')) {
      const id = $("#dmTargetForm").elements.id.value;
      if (!id || !confirm("타겟 삭제?")) return;
      await api(`/api/dm/targets/${id}`, { method: "DELETE" });
      $("#dmTargetDialog").close();
      await loadTargets();
      return;
    }
    if (e.target.closest('[data-action="delete-dm-template"]')) {
      const id = $("#dmTemplateForm").elements.id.value;
      if (!id || !confirm("템플릿 삭제?")) return;
      await api(`/api/dm/templates/${id}`, { method: "DELETE" });
      $("#dmTemplateDialog").close();
      await loadTemplates();
      return;
    }

    // 발송 시작
    if (e.target.id === "btnDmSendStart") {
      const tplId = $("#dmSendTemplate").value;
      if (!tplId) { alert("템플릿 선택 필요"); return; }
      if (dm.selected.size === 0) { alert("타겟 선택 필요"); return; }
      if (!confirm(`${dm.selected.size}명에게 DM 발송 시작? (한 명당 30초~3분, 계정 로테이션)`)) return;
      try {
        const r = await api("/api/dm/send", {
          method: "POST",
          body: JSON.stringify({
            target_ids: Array.from(dm.selected),
            template_id: tplId,
          }),
        });
        dm.jobId = r.job_id;
        $("#dmJobPanel").hidden = false;
        startJobPolling();
      } catch (err) {
        alert("발송 실패: " + err.message);
      }
      return;
    }
    if (e.target.id === "btnDmJobStop") {
      if (dm.jobId) await api(`/api/dm/jobs/${dm.jobId}/stop`, { method: "POST" });
      return;
    }
  });

  // ─── 폼 submit ─────────────────────────────────────────
  document.addEventListener("submit", async (e) => {
    if (e.target.id === "dmAccountForm") {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      const id = data.id; delete data.id;
      try {
        if (id) {
          // 비번 비어있으면 안 보냄
          if (!data.password) delete data.password;
          await api(`/api/dm/accounts/${id}`, { method: "PATCH", body: JSON.stringify(data) });
        } else {
          await api("/api/dm/accounts", { method: "POST", body: JSON.stringify(data) });
        }
        $("#dmAccountDialog").close();
        await loadAccounts();
      } catch (err) { alert("저장 실패: " + err.message); }
      return;
    }
    if (e.target.id === "dmTargetForm") {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      const id = data.id; delete data.id;
      try {
        if (id) await api(`/api/dm/targets/${id}`, { method: "PATCH", body: JSON.stringify(data) });
        else await api("/api/dm/targets", { method: "POST", body: JSON.stringify(data) });
        $("#dmTargetDialog").close();
        await loadTargets();
      } catch (err) { alert("저장 실패: " + err.message); }
      return;
    }
    if (e.target.id === "dmTemplateForm") {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      const id = data.id; delete data.id;
      try {
        if (id) await api(`/api/dm/templates/${id}`, { method: "PATCH", body: JSON.stringify(data) });
        else await api("/api/dm/templates", { method: "POST", body: JSON.stringify(data) });
        $("#dmTemplateDialog").close();
        await loadTemplates();
      } catch (err) { alert("저장 실패: " + err.message); }
      return;
    }
    if (e.target.id === "dmBulkForm") {
      e.preventDefault();
      const fd = new FormData(e.target);
      const kind = fd.get("kind");
      const csv = fd.get("csv") || "";
      const rows = csv.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
        const cols = line.split(/[\t,]/).map(s => s.trim());
        if (kind === "accounts") {
          return { username: cols[0], password: cols[1], sender_name: cols[2] || "" };
        } else {
          return {
            username: cols[0], display_name: cols[1] || "",
            category: cols[2] || "", followers: parseInt(cols[3] || 0) || 0,
          };
        }
      });
      try {
        const r = await api(`/api/dm/${kind === "accounts" ? "accounts" : "targets"}/bulk`, {
          method: "POST", body: JSON.stringify({ rows }),
        });
        alert(`${r.added}개 추가됨 (전체 ${r.total}개)`);
        $("#dmBulkDialog").close();
        if (kind === "accounts") await loadAccounts(); else await loadTargets();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
  });

  // ─── 작업 진행 폴링 ────────────────────────────────────
  function startJobPolling() {
    if (dm.pollTimer) clearInterval(dm.pollTimer);
    dm.pollTimer = setInterval(async () => {
      if (!dm.jobId) return;
      try {
        const job = await api(`/api/dm/jobs/${dm.jobId}`);
        renderJobProgress(job);
        if (job.status === "done" || job.status === "error") {
          clearInterval(dm.pollTimer);
          dm.pollTimer = null;
          await loadAccounts();
          await loadTargets();
          dm.selected.clear();
        }
      } catch (e) { console.error(e); }
    }, 2000);
  }

  function renderJobProgress(job) {
    const root = $("#dmJobProgress");
    const logBox = $("#dmJobLog");
    if (!root) return;
    const total = job.total || 1;
    const done = (job.sent || 0) + (job.failed || 0);
    const pct = Math.round(done / total * 100);
    root.innerHTML = `
      <div style="display:flex;gap:20px;margin-bottom:10px;font-size:13px">
        <div><b>${job.sent || 0}</b> 성공</div>
        <div><b>${job.failed || 0}</b> 실패</div>
        <div><b>${total - done}</b> 남음</div>
        <div style="margin-left:auto">${esc(job.current || "")}</div>
      </div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div>
      <div style="font-size:11px;color:#888;margin-top:4px">상태: ${esc(job.status)}</div>
    `;
    if (logBox && job.log) {
      logBox.innerHTML = job.log.slice(-30).map(esc).join("<br>");
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // ─── 탭 진입 훅 ────────────────────────────────────────
  // app.js의 switchTab을 가로채는 대신, 사이드바 클릭 감지
  document.addEventListener("click", (e) => {
    const item = e.target.closest('.side-item[data-tab="dm"]');
    if (item) {
      // 약간 딜레이 후 로드 (탭 활성화 후)
      setTimeout(() => {
        loadAccounts();
        loadTargets();
        loadTemplates();
      }, 50);
    }
  });

  // 초기 로드 (백그라운드)
  setTimeout(() => {
    loadAccounts();
    loadTargets();
    loadTemplates();
  }, 500);
})();
