/*
 * 넥스트포트 DM v2 위젯 (인플루언서 5,000 + 계정 100+)
 * 격리된 namespace. 의존: window.api, window.escapeHtml
 */
(function () {
  if (!window.api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));

  const v2 = {
    influencers: [],
    accounts: [],
    page: 1,
    pageSize: 50,
    total: 0,
    q: "",
    statusFilter: "",
    summary: {},
    imports: [],
    selected: new Set(),
  };

  // ─── IMPORT ─────────────────────────────────────────────
  async function loadImports() {
    try {
      const r = await api("/api/dm/import/preview");
      v2.imports = r.files || [];
      const hint = $("#dmImportsDirHint");
      if (hint) hint.textContent = r.imports_dir || "";
      renderImports();
    } catch (e) { console.error(e); }
  }

  function renderImports() {
    const root = $("#dmImportFiles");
    if (!root) return;
    if (!v2.imports.length) {
      root.innerHTML = `<div class="empty" style="padding:14px;font-size:12px">data/imports/ 폴더가 비어있음. 엑셀 박은 후 [↻ 새로고침]</div>
        <button class="btn-secondary" data-v2="refresh-imports">↻ 새로고침</button>`;
      return;
    }
    root.innerHTML = `
      <div class="dm-import-list">
        ${v2.imports.map(f => `
          <div class="dm-import-row">
            <span class="di-name">📄 ${esc(f.name)}</span>
            <span class="di-size">${f.size_kb} KB</span>
            <span class="di-time">${esc(f.modified.replace("T", " ").slice(0, 16))}</span>
            <button class="btn-secondary" data-v2="import-inf" data-name="${esc(f.name)}">인플루언서로 임포트</button>
            <button class="btn-secondary" data-v2="import-acc" data-name="${esc(f.name)}">계정으로 임포트</button>
          </div>
        `).join("")}
      </div>
      <button class="btn-text" data-v2="refresh-imports" style="margin-top:8px">↻ 새로고침</button>
    `;
  }

  // ─── INFLUENCERS ────────────────────────────────────────
  async function loadInfluencers() {
    try {
      const params = new URLSearchParams({
        page: v2.page, page_size: v2.pageSize,
        q: v2.q, status: v2.statusFilter,
      });
      const r = await api(`/api/influencers?${params}`);
      v2.influencers = r.influencers || [];
      v2.total = r.total || 0;
      v2.summary = r.summary || {};
      renderInfluencers();
    } catch (e) { console.error(e); }
  }

  function renderInfluencers() {
    const stat = $("#dmInfStat");
    if (stat) {
      const by = v2.summary.by_status || {};
      const parts = [`전체 ${v2.summary.total || 0}`];
      ["미발송", "발송중", "답장받음", "컨펌", "거절"].forEach(s => {
        if (by[s]) parts.push(`${s}: ${by[s]}`);
      });
      stat.textContent = parts.join(" · ");
    }

    const body = $("#dmInfBody");
    if (!body) return;
    if (!v2.influencers.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">${v2.total === 0 ? "데이터 없음. 엑셀 임포트 먼저." : "이 페이지 비어있음"}</td></tr>`;
      renderPager();
      return;
    }
    body.innerHTML = v2.influencers.map(it => {
      const status = it.status || "미발송";
      return `<tr data-iid="${esc(it.id)}">
        <td><input type="checkbox" class="dm-inf-chk" data-id="${esc(it.id)}" ${v2.selected.has(it.id) ? "checked" : ""} /></td>
        <td>
          <a href="${esc(it.url || `https://www.instagram.com/${it.instagram_id}/`)}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">
            @${esc(it.instagram_id || "")}
          </a>
        </td>
        <td>${esc(it.seller_name || "-")}</td>
        <td><span class="dm-chip s-${esc(status_class(status))}">${esc(status)}</span></td>
        <td style="text-align:center">${it.send_count || 0}</td>
        <td style="font-size:11px;color:#888">${esc(it.last_sent_date || "-")}</td>
        <td style="font-size:11px">${esc(it.last_sent_account_id || "-")}</td>
        <td><button class="btn-text" data-v2="edit-inf" data-id="${esc(it.id)}">✎</button></td>
      </tr>`;
    }).join("");
    renderPager();
  }

  function status_class(s) {
    const m = {
      "미발송": "pending", "발송중": "sending",
      "답장받음": "replied", "컨펌": "active",
      "거절": "failed", "비공개": "disabled",
      "1차완료": "sent", "2차완료": "sent", "3차완료": "sent",
    };
    return m[s] || "pending";
  }

  function renderPager() {
    const root = $("#dmInfPager");
    if (!root) return;
    const totalPages = Math.max(1, Math.ceil(v2.total / v2.pageSize));
    if (totalPages <= 1) { root.innerHTML = ""; return; }
    const cur = v2.page;
    root.innerHTML = `
      <button class="btn-text" data-v2="page" data-p="1" ${cur === 1 ? "disabled" : ""}>«</button>
      <button class="btn-text" data-v2="page" data-p="${cur - 1}" ${cur === 1 ? "disabled" : ""}>‹</button>
      <span>${cur} / ${totalPages}</span>
      <button class="btn-text" data-v2="page" data-p="${cur + 1}" ${cur === totalPages ? "disabled" : ""}>›</button>
      <button class="btn-text" data-v2="page" data-p="${totalPages}" ${cur === totalPages ? "disabled" : ""}>»</button>
    `;
  }

  // ─── ACCOUNTS ───────────────────────────────────────────
  async function loadAccounts() {
    try {
      const r = await api("/api/our_accounts");
      v2.accounts = r.accounts || [];
      renderAccounts(r.summary || {});
    } catch (e) { console.error(e); }
  }

  function renderAccounts(summary) {
    const stat = $("#dmAccStat");
    if (stat) {
      const by = summary.by_status || {};
      const parts = [`전체 ${summary.total || 0}`];
      ["활성", "사람인증", "휴식", "차단"].forEach(s => {
        if (by[s]) parts.push(`${s}: ${by[s]}`);
      });
      stat.textContent = parts.join(" · ");
    }
    const body = $("#dmAccBody");
    if (!body) return;
    if (!v2.accounts.length) {
      body.innerHTML = `<tr><td colspan="10" class="empty">데이터 없음. 엑셀 임포트 먼저.</td></tr>`;
      return;
    }
    // 기기별 그룹 정렬
    const sorted = [...v2.accounts].sort((a, b) =>
      (a.device || "").localeCompare(b.device || "") ||
      (a.created_date || "").localeCompare(b.created_date || ""));
    let lastDevice = null;
    body.innerHTML = sorted.map(a => {
      const status = a.status || "활성";
      let html = "";
      if (a.device !== lastDevice) {
        html += `<tr class="dm-group-row"><td colspan="10">📱 ${esc(a.device || "(미지정 기기)")}</td></tr>`;
        lastDevice = a.device;
      }
      html += `<tr data-aid="${esc(a.id)}">
        <td><b>@${esc(a.instagram_id || "")}</b></td>
        <td style="font-size:11px;color:#888">${esc(a.device || "-")}</td>
        <td>${esc(a.account_owner || "-")}</td>
        <td style="font-size:11px">${esc(a.login_id || "-")}</td>
        <td style="font-size:11px">${esc(a.phone || "-")}</td>
        <td style="font-size:11px">${esc(a.created_date || "-")}</td>
        <td><span class="dm-chip s-${esc(acc_status_class(status))}">${esc(status)}</span></td>
        <td style="text-align:right">${a.total_sent || 0}</td>
        <td style="font-size:11px;color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.notes || '')}">${esc((a.notes || "").slice(0, 30))}</td>
        <td><button class="btn-text" data-v2="edit-acc" data-id="${esc(a.id)}">✎</button></td>
      </tr>`;
      return html;
    }).join("");
  }

  function acc_status_class(s) {
    if (s === "활성") return "active";
    if (s === "차단") return "blocked";
    if (s === "휴식") return "warmup";
    if (s === "사람인증") return "warmup";
    return "disabled";
  }

  // ─── EVENT HANDLERS ─────────────────────────────────────
  document.addEventListener("click", async (e) => {
    if (!$("#tab-dm")?.classList.contains("active")) return;

    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    if (what === "refresh-imports") return loadImports();

    if (what === "import-inf" || what === "import-acc") {
      const filename = trg.dataset.name;
      const isInf = what === "import-inf";
      const label = isInf ? "인플루언서" : "계정";
      const overwrite = $("#dmImportOverwrite")?.checked;
      const mode = overwrite ? "update" : "add";
      const modeLabel = overwrite ? "덮어쓰기 (중복 시 갱신)" : "신규만 추가";
      if (!confirm(`'${filename}' → ${label} 마스터\n모드: ${modeLabel}\n진행할까?`)) return;
      trg.disabled = true;
      trg.textContent = "임포트 중…";
      try {
        const r = await api(`/api/dm/import/${isInf ? "influencers" : "accounts"}`, {
          method: "POST",
          body: JSON.stringify({ filename, mode }),
        });
        if (r.error) {
          alert(`실패: ${r.error}`);
        } else {
          const parts = [`✓ 신규 ${r.added}`];
          if (r.updated) parts.push(`갱신 ${r.updated}`);
          parts.push(`중복 ${r.skipped_duplicate}`);
          parts.push(`빈 ${r.skipped_empty}`);
          alert(`${parts.join(" · ")}\n총 ${r.total_after}개`);
          if (isInf) await loadInfluencers();
          else await loadAccounts();
        }
      } catch (err) {
        alert("실패: " + err.message);
      } finally {
        trg.disabled = false;
        trg.textContent = isInf ? "인플루언서로 임포트" : "계정으로 임포트";
      }
      return;
    }

    if (what === "page") {
      const p = parseInt(trg.dataset.p) || 1;
      if (p !== v2.page) {
        v2.page = p;
        await loadInfluencers();
      }
      return;
    }

    if (what === "edit-inf") {
      const it = v2.influencers.find(x => x.id === trg.dataset.id);
      if (!it) return;
      const newStatus = prompt(`${it.seller_name || it.instagram_id} 상태 변경\n(미발송/발송중/답장받음/컨펌/거절/비공개)`, it.status || "미발송");
      if (newStatus === null) return;
      try {
        await api(`/api/influencers/${it.id}`, { method: "PATCH", body: JSON.stringify({ status: newStatus.trim() }) });
        await loadInfluencers();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }

    if (what === "edit-acc") {
      const a = v2.accounts.find(x => x.id === trg.dataset.id);
      if (!a) return;
      const newStatus = prompt(`@${a.instagram_id} 상태 변경\n(활성/사람인증/휴식/차단)`, a.status || "활성");
      if (newStatus === null) return;
      try {
        await api(`/api/our_accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: newStatus.trim() }) });
        await loadAccounts();
      } catch (err) { alert("실패: " + err.message); }
      return;
    }
  });

  // 검색 + 필터
  let searchTimer;
  document.addEventListener("input", (e) => {
    if (e.target.id === "dmInfSearch") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        v2.q = e.target.value;
        v2.page = 1;
        loadInfluencers();
      }, 300);
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "dmInfStatusFilter") {
      v2.statusFilter = e.target.value;
      v2.page = 1;
      loadInfluencers();
    }
    if (e.target.id === "dmInfAll") {
      const all = e.target.checked;
      v2.influencers.forEach(it => {
        if (all) v2.selected.add(it.id);
        else v2.selected.delete(it.id);
      });
      renderInfluencers();
    }
    if (e.target.classList?.contains("dm-inf-chk")) {
      if (e.target.checked) v2.selected.add(e.target.dataset.id);
      else v2.selected.delete(e.target.dataset.id);
    }
  });

  // 탭 진입 시
  document.addEventListener("click", (e) => {
    const tab = e.target.closest('.side-item[data-tab="dm"]');
    if (tab) {
      setTimeout(() => {
        loadImports();
        loadInfluencers();
        loadAccounts();
      }, 80);
    }
  });

  // 초기 로드
  setTimeout(() => {
    loadImports();
    loadInfluencers();
    loadAccounts();
  }, 600);
})();
