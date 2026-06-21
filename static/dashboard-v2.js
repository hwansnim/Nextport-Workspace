/*
 * 대시보드 v2 — 카페24 스타일 + 월별 매출 막대 + 캠페인 표 + 엑셀스럽 인터랙션.
 * 엑셀 기능: Ctrl+C/V/Z/Y, 셀 선택 (클릭/Shift+화살표/범위), 화살표 이동, 함수 (=SUM, =AVG, =COUNT)
 */
(function () {
  if (!window.api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = window.escapeHtml || ((s) => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])));
  const fmtKRW = n => "₩" + (n || 0).toLocaleString();
  const fmtKRWshort = n => {
    n = n || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + "억";
    if (n >= 10000) return (n / 10000).toFixed(0) + "만";
    return n.toLocaleString();
  };

  const st = {
    data: null,
    range: "month",       // month | day
    activeCell: null,     // {row, col}
    selection: null,      // {r1, c1, r2, c2}
    undoStack: [],
    redoStack: [],
    editing: false,
  };

  async function load() {
    try {
      const r = await api("/api/dashboard_v2");
      st.data = r;
      renderStats();
      renderChart();
      renderSheet();
    } catch (e) { console.error(e); }
  }

  // ─── 1. 상단 카드 (카페24 풍) ───────────────────────────
  function renderStats() {
    if (!st.data) return;
    const t = st.data.totals || {};
    $("#dvStatRevenue").textContent = fmtKRW(t.revenue);
    $("#dvStatCost").textContent = fmtKRW(t.cost);
    $("#dvStatProfit").textContent = fmtKRW(t.profit);
    $("#dvStatCampaigns").textContent = t.campaign_count || 0;

    // 이번 달 / 최근 7일 sub
    const monthThis = (st.data.months || []).slice(-1)[0];
    const daySum7 = (st.data.days || []).reduce((a, d) => a + d.revenue, 0);
    $("#dvStatRevSub").textContent = `이번 달 ${fmtKRWshort(monthThis?.revenue || 0)} · 최근 7일 ${fmtKRWshort(daySum7)}`;
    $("#dvStatCostSub").textContent = `마진율 ${t.margin_pct != null ? t.margin_pct.toFixed(1) + "%" : "—"}`;
    $("#dvStatProfitSub").textContent = `누적 마켓 ${t.market_count || 0}건`;
    $("#dvStatCampaignsSub").textContent = `마켓 ${t.market_count || 0}건 진행`;
  }

  // ─── 2. SVG 막대 그래프 ────────────────────────────────
  function renderChart() {
    const svg = $("#dvChartSvg");
    if (!svg || !st.data) return;
    const data = st.range === "month" ? (st.data.months || []) : (st.data.days || []);
    if (!data.length) { svg.innerHTML = ""; return; }
    const W = 1100, H = 280;
    const padL = 60, padR = 20, padT = 30, padB = 40;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(...data.map(d => d.revenue), 100);
    const niceMax = Math.ceil(max / 100000) * 100000 || max;
    const barW = innerW / data.length * 0.72;
    const slot = innerW / data.length;

    let html = "";
    // 가로 격자 (4단)
    for (let i = 0; i <= 4; i++) {
      const y = padT + innerH * (i / 4);
      const v = niceMax * (1 - i / 4);
      html += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#eee" />`;
      html += `<text x="${padL - 10}" y="${y + 4}" text-anchor="end" font-size="10" fill="#999">${fmtKRWshort(v)}</text>`;
    }
    // 막대 + 라벨
    data.forEach((d, i) => {
      const x = padL + slot * i + (slot - barW) / 2;
      const h = niceMax > 0 ? (d.revenue / niceMax) * innerH : 0;
      const y = padT + innerH - h;
      const isToday = d.is_today;
      const fill = isToday ? "#3182F6" : (d.revenue > 0 ? "#69a6ff" : "#e8e3da");
      html += `<rect class="dv-bar" data-idx="${i}" x="${x}" y="${y}" width="${barW}" height="${h}" fill="${fill}" rx="3" />`;
      // 값 라벨 (막대 위)
      if (d.revenue > 0) {
        html += `<text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="#3182F6" font-weight="700">${fmtKRWshort(d.revenue)}</text>`;
      }
      // x축 라벨
      html += `<text x="${x + barW / 2}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="${isToday ? '#3182F6' : '#666'}" font-weight="${isToday ? 700 : 400}">${esc(d.label)}</text>`;
    });
    svg.innerHTML = html;
  }

  // ─── 3. 엑셀스럽 시트 ──────────────────────────────────
  // 컬럼 매핑 — 편집 가능한 열: G(매출, idx 6), H(비용, idx 7)
  const EDITABLE_COLS = [6, 7];  // 매출 / 비용 (0-indexed)
  // numeric cols (집계용)
  const NUMERIC_COLS = [5, 6, 7, 8, 9];  // 마켓수 / 매출 / 비용 / 공헌 이익 / 마진율

  function renderSheet() {
    const body = $("#dvSheetBody");
    const foot = $("#dvSheetFoot");
    if (!body || !st.data) return;
    const camps = st.data.campaigns || [];
    if (!camps.length) {
      body.innerHTML = `<tr><td colspan="12" class="empty">캠페인 없음 — [셀러 캠페인]에서 만들기</td></tr>`;
      foot.innerHTML = "";
      return;
    }
    body.innerHTML = camps.map((c, i) => {
      const profit = (c.revenue || 0) - (c.cost || 0);
      const margin = c.margin_pct;
      return `
        <tr data-cid="${esc(c.id)}" data-row="${i}">
          <td class="dv-rowhdr">${i + 1}</td>
          <td class="dv-cell" data-r="${i}" data-c="1" data-type="text">${esc(c.seller_name || "")}</td>
          <td class="dv-cell" data-r="${i}" data-c="2" data-type="text">${esc(c.brand || "")} · ${esc(c.product || "")}</td>
          <td class="dv-cell" data-r="${i}" data-c="3" data-type="text">${esc(c.type || "")}</td>
          <td class="dv-cell" data-r="${i}" data-c="4" data-type="text">${esc(c.status || "")}</td>
          <td class="dv-cell dv-num" data-r="${i}" data-c="5" data-type="num">${c.market_count || 0}</td>
          <td class="dv-cell dv-num dv-editable" data-r="${i}" data-c="6" data-type="num" data-val="${c.revenue || 0}">${fmtKRW(c.revenue)}</td>
          <td class="dv-cell dv-num dv-editable" data-r="${i}" data-c="7" data-type="num" data-val="${c.cost || 0}">${fmtKRW(c.cost)}</td>
          <td class="dv-cell dv-num" data-r="${i}" data-c="8" data-type="num" data-val="${profit}"><b>${fmtKRW(profit)}</b></td>
          <td class="dv-cell dv-num" data-r="${i}" data-c="9" data-type="num" data-val="${margin || 0}">${margin != null ? margin + "%" : "—"}</td>
          <td class="dv-cell" data-r="${i}" data-c="10" data-type="text">${esc(c.latest_market_date || "-")}</td>
          <td><button class="btn-text" data-v2="dv-goto-cam" data-cid="${esc(c.id)}">→</button></td>
        </tr>
      `;
    }).join("");

    // 합계 행 (footer)
    const sums = { rev: 0, cost: 0, profit: 0, markets: 0 };
    camps.forEach(c => {
      sums.rev += c.revenue || 0;
      sums.cost += c.cost || 0;
      sums.profit += (c.revenue || 0) - (c.cost || 0);
      sums.markets += c.market_count || 0;
    });
    const sumMargin = sums.rev > 0 ? Math.round((sums.profit / sums.rev) * 1000) / 10 : null;
    foot.innerHTML = `
      <tr class="dv-foot-row">
        <td colspan="5" style="text-align:right;font-weight:700;color:var(--accent)">합계</td>
        <td class="dv-num"><b>${sums.markets}</b></td>
        <td class="dv-num"><b>${fmtKRW(sums.rev)}</b></td>
        <td class="dv-num"><b>${fmtKRW(sums.cost)}</b></td>
        <td class="dv-num"><b style="color:var(--accent)">${fmtKRW(sums.profit)}</b></td>
        <td class="dv-num"><b>${sumMargin != null ? sumMargin + "%" : "—"}</b></td>
        <td colspan="2"></td>
      </tr>
    `;
  }

  // ─── 셀 선택 / 편집 / 단축키 ────────────────────────────
  function getCell(r, c) { return document.querySelector(`.dv-cell[data-r="${r}"][data-c="${c}"]`); }
  function rowCount() { return $$("#dvSheetBody tr").length; }
  function colMaxIdx() { return 10; }

  function clearSelection() {
    $$(".dv-cell.selected, .dv-cell.range-selected").forEach(c => {
      c.classList.remove("selected", "range-selected");
    });
  }

  function selectCell(r, c, extend = false) {
    if (r < 0 || c < 0 || c > colMaxIdx() || r >= rowCount()) return;
    const cell = getCell(r, c);
    if (!cell) return;
    if (!extend) {
      clearSelection();
      st.activeCell = { row: r, col: c };
      st.selection = { r1: r, c1: c, r2: r, c2: c };
      cell.classList.add("selected");
    } else {
      // 범위 확장
      if (!st.activeCell) st.activeCell = { row: r, col: c };
      const a = st.activeCell;
      st.selection = {
        r1: Math.min(a.row, r), c1: Math.min(a.col, c),
        r2: Math.max(a.row, r), c2: Math.max(a.col, c),
      };
      $$(".dv-cell").forEach(el => el.classList.remove("range-selected", "selected"));
      for (let rr = st.selection.r1; rr <= st.selection.r2; rr++) {
        for (let cc = st.selection.c1; cc <= st.selection.c2; cc++) {
          const el = getCell(rr, cc);
          if (el) el.classList.add("range-selected");
        }
      }
      cell.classList.add("selected");
    }
    showFormulaBar(cell);
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function showFormulaBar(cell) {
    const bar = $("#dvFormulaBar");
    if (!bar) return;
    bar.hidden = false;
    const r = parseInt(cell.dataset.r);
    const c = parseInt(cell.dataset.c);
    const colLetters = "ABCDEFGHIJKL";
    $("#dvCellCoord").textContent = `${colLetters[c]}${r + 1}`;
    const editable = cell.classList.contains("dv-editable");
    const inp = $("#dvFormulaInput");
    inp.value = editable ? (cell.dataset.val || "") : cell.innerText.trim();
    inp.readOnly = !editable;
  }

  async function commitCell(r, c, raw) {
    const cell = getCell(r, c);
    if (!cell || !cell.classList.contains("dv-editable")) return false;
    let val = (raw == null ? "" : String(raw)).trim();
    // 함수 evaluator
    if (val.startsWith("=")) {
      val = evalFormula(val);
    }
    const num = parseInt(val) || 0;
    const oldVal = parseInt(cell.dataset.val) || 0;
    if (num === oldVal) return false;

    // undo 박기
    st.undoStack.push({ r, c, old: oldVal, new: num });
    st.redoStack = [];

    // 백엔드 PATCH
    const row = cell.closest("tr");
    const cid = row?.dataset.cid;
    if (!cid) return false;
    const field = c === 6 ? "revenue" : (c === 7 ? "cost" : null);
    if (!field) return false;

    cell.dataset.val = num;
    cell.innerHTML = fmtKRW(num);
    try {
      await api("/api/dashboard_v2/cell", {
        method: "PATCH",
        body: JSON.stringify({ campaign_id: cid, field, value: num }),
      });
      // 공헌 이익 / 마진율 즉시 재계산
      recalcRow(r);
      recalcFooter();
      return true;
    } catch (err) {
      alert("저장 실패: " + err.message);
      return false;
    }
  }

  function recalcRow(r) {
    const rev = parseInt(getCell(r, 6)?.dataset.val || "0");
    const cost = parseInt(getCell(r, 7)?.dataset.val || "0");
    const profit = rev - cost;
    const margin = rev > 0 ? Math.round((profit / rev) * 1000) / 10 : null;
    const pCell = getCell(r, 8);
    const mCell = getCell(r, 9);
    if (pCell) { pCell.dataset.val = profit; pCell.innerHTML = `<b>${fmtKRW(profit)}</b>`; }
    if (mCell) { mCell.dataset.val = margin || 0; mCell.innerHTML = margin != null ? margin + "%" : "—"; }
  }

  function recalcFooter() {
    let rev = 0, cost = 0, profit = 0;
    $$("#dvSheetBody tr").forEach((tr, r) => {
      rev += parseInt(getCell(r, 6)?.dataset.val || "0");
      cost += parseInt(getCell(r, 7)?.dataset.val || "0");
    });
    profit = rev - cost;
    const margin = rev > 0 ? Math.round((profit / rev) * 1000) / 10 : null;
    const foot = $("#dvSheetFoot");
    if (!foot) return;
    const cells = foot.querySelectorAll("td");
    if (cells.length < 10) return;
    cells[6].innerHTML = `<b>${fmtKRW(rev)}</b>`;
    cells[7].innerHTML = `<b>${fmtKRW(cost)}</b>`;
    cells[8].innerHTML = `<b style="color:var(--accent)">${fmtKRW(profit)}</b>`;
    cells[9].innerHTML = `<b>${margin != null ? margin + "%" : "—"}</b>`;
  }

  // 함수 평가기 (단순) — =SUM(G2:G10) / =AVG / =COUNT / =MIN / =MAX
  function evalFormula(formula) {
    const m = formula.match(/^=(SUM|AVG|AVERAGE|COUNT|MIN|MAX)\(([A-L])(\d+):([A-L])(\d+)\)\s*$/i);
    if (!m) return formula;
    const fn = m[1].toUpperCase();
    const colLetters = "ABCDEFGHIJKL";
    const c1 = colLetters.indexOf(m[2].toUpperCase());
    const r1 = parseInt(m[3]) - 1;
    const c2 = colLetters.indexOf(m[4].toUpperCase());
    const r2 = parseInt(m[5]) - 1;
    const vals = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const cell = getCell(r, c);
        if (!cell) continue;
        const v = parseFloat(cell.dataset.val || cell.innerText.replace(/[^0-9.-]/g, ""));
        if (!isNaN(v)) vals.push(v);
      }
    }
    if (!vals.length) return 0;
    if (fn === "SUM") return vals.reduce((a, b) => a + b, 0);
    if (fn === "AVG" || fn === "AVERAGE") return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    if (fn === "COUNT") return vals.length;
    if (fn === "MIN") return Math.min(...vals);
    if (fn === "MAX") return Math.max(...vals);
    return 0;
  }

  // 클립보드
  function copySelection() {
    if (!st.selection) return;
    const rows = [];
    for (let r = st.selection.r1; r <= st.selection.r2; r++) {
      const cells = [];
      for (let c = st.selection.c1; c <= st.selection.c2; c++) {
        const el = getCell(r, c);
        const v = el?.dataset.val ?? el?.innerText?.trim();
        cells.push(v || "");
      }
      rows.push(cells.join("\t"));
    }
    navigator.clipboard.writeText(rows.join("\n")).then(() => {
      window.showToast?.({ icon: "📋", title: "복사됨", body: `${rows.length}행`, ttl: 1500 });
    });
  }

  async function pasteToSelection() {
    if (!st.activeCell) return;
    try {
      const text = await navigator.clipboard.readText();
      const rows = text.replace(/\r/g, "").split("\n").filter(Boolean).map(r => r.split("\t"));
      const baseR = st.activeCell.row, baseC = st.activeCell.col;
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
          await commitCell(baseR + i, baseC + j, rows[i][j]);
        }
      }
    } catch (err) { alert("붙여넣기 실패: " + err.message); }
  }

  async function undo() {
    const op = st.undoStack.pop();
    if (!op) return;
    st.redoStack.push(op);
    await commitCellSilently(op.r, op.c, op.old);
  }
  async function redo() {
    const op = st.redoStack.pop();
    if (!op) return;
    st.undoStack.push(op);
    await commitCellSilently(op.r, op.c, op.new);
  }
  async function commitCellSilently(r, c, val) {
    const cell = getCell(r, c);
    if (!cell) return;
    const cid = cell.closest("tr")?.dataset.cid;
    const field = c === 6 ? "revenue" : "cost";
    cell.dataset.val = val;
    cell.innerHTML = fmtKRW(val);
    try {
      await api("/api/dashboard_v2/cell", {
        method: "PATCH",
        body: JSON.stringify({ campaign_id: cid, field, value: val }),
      });
      recalcRow(r);
      recalcFooter();
    } catch {}
  }

  // CSV export
  function exportCsv() {
    const rows = [["#","셀러","브랜드 · 제품","타입","상태","마켓수","매출","비용","공헌이익","마진율","최근마켓일"]];
    $$("#dvSheetBody tr").forEach((tr, i) => {
      const cells = Array.from(tr.querySelectorAll(".dv-cell"));
      const row = [i + 1];
      cells.forEach(td => {
        const v = td.dataset.val ?? td.innerText.replace(/,/g, " ");
        row.push(v);
      });
      rows.push(row);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dashboard_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── 이벤트 ────────────────────────────────────────────
  document.addEventListener("click", async (e) => {
    // 셀 클릭
    const cell = e.target.closest(".dv-cell");
    if (cell && cell.closest("#dvSheet")) {
      const r = parseInt(cell.dataset.r);
      const c = parseInt(cell.dataset.c);
      if (e.shiftKey) selectCell(r, c, true);
      else selectCell(r, c, false);
      return;
    }

    const trg = e.target.closest("[data-v2]");
    if (!trg) return;
    const what = trg.dataset.v2;

    if (what === "dv-range") {
      st.range = trg.dataset.range;
      $$(".dv-range-btn").forEach(b => b.classList.toggle("active", b === trg));
      renderChart();
      return;
    }
    if (what === "dv-goto-cam") {
      // 캠페인 탭으로 이동 + 해당 캠페인 자동 오픈
      const cid = trg.dataset.cid;
      document.querySelector('.side-item[data-tab="campaigns"]')?.click();
      setTimeout(() => {
        // campaigns-v2.js의 openCampaign 호출
        const camOpen = document.querySelector(`[data-v2="cam-open"][data-id="${cid}"], [data-v2="cam-detail"][data-id="${cid}"]`);
        if (camOpen) camOpen.click();
      }, 400);
      return;
    }
    if (what === "dv-export-csv") return exportCsv();
  });

  // 행 클릭 시 캠페인으로 이동
  document.addEventListener("dblclick", (e) => {
    if (e.target.closest(".dv-cell.dv-editable")) {
      const cell = e.target.closest(".dv-cell.dv-editable");
      cell.contentEditable = "true";
      cell.focus();
      st.editing = true;
      // 텍스트 전체 선택
      const range = document.createRange();
      range.selectNodeContents(cell);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    const row = e.target.closest("tr[data-cid]");
    if (row) {
      const cid = row.dataset.cid;
      document.querySelector('.side-item[data-tab="campaigns"]')?.click();
      setTimeout(() => {
        const camOpen = document.querySelector(`[data-v2="cam-open"][data-id="${cid}"]`);
        if (camOpen) camOpen.click();
      }, 400);
    }
  });

  // contenteditable blur = 저장
  document.addEventListener("blur", async (e) => {
    if (st.editing && e.target.classList?.contains("dv-editable")) {
      e.target.contentEditable = "false";
      st.editing = false;
      const r = parseInt(e.target.dataset.r);
      const c = parseInt(e.target.dataset.c);
      await commitCell(r, c, e.target.innerText);
    }
  }, true);

  // 키보드
  document.addEventListener("keydown", async (e) => {
    if (!document.getElementById("tab-dashboard")?.classList.contains("active")) return;

    // 함수 입력바 Enter
    if (e.target.id === "dvFormulaInput" && e.key === "Enter") {
      if (!st.activeCell) return;
      await commitCell(st.activeCell.row, st.activeCell.col, e.target.value);
      e.preventDefault();
      return;
    }

    if (e.target.tagName === "INPUT" || e.target.isContentEditable) return;
    if (!st.activeCell) return;

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "c") { copySelection(); e.preventDefault(); return; }
    if (ctrl && e.key.toLowerCase() === "v") { await pasteToSelection(); e.preventDefault(); return; }
    if (ctrl && e.key.toLowerCase() === "z") { await undo(); e.preventDefault(); return; }
    if (ctrl && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { await redo(); e.preventDefault(); return; }

    const { row, col } = st.activeCell;
    const ext = e.shiftKey;
    if (e.key === "ArrowUp") { selectCell(row - 1, col, ext); e.preventDefault(); }
    else if (e.key === "ArrowDown") { selectCell(row + 1, col, ext); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { selectCell(row, col - 1, ext); e.preventDefault(); }
    else if (e.key === "ArrowRight") { selectCell(row, col + 1, ext); e.preventDefault(); }
    else if (e.key === "Tab") {
      selectCell(row, col + (e.shiftKey ? -1 : 1), false);
      e.preventDefault();
    }
    else if (e.key === "Enter") {
      const cell = getCell(row, col);
      if (cell?.classList.contains("dv-editable")) {
        cell.contentEditable = "true"; cell.focus(); st.editing = true;
        document.execCommand("selectAll", false, null);
        e.preventDefault();
      } else {
        selectCell(row + 1, col, false);
      }
    }
    else if (e.key === "Delete" || e.key === "Backspace") {
      // 선택 범위 0으로
      if (st.selection) {
        for (let r = st.selection.r1; r <= st.selection.r2; r++) {
          for (let c = st.selection.c1; c <= st.selection.c2; c++) {
            await commitCell(r, c, "0");
          }
        }
      }
      e.preventDefault();
    }
  });

  // 탭 진입
  document.addEventListener("click", (e) => {
    const t = e.target.closest('.side-item[data-tab="dashboard"]');
    if (t) setTimeout(load, 80);
  });

  setTimeout(load, 900);
})();
