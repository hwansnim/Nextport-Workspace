/*
 * 넥스트포트 셀러 플레이북 — 4탭 + N차 스위치 + 이벤트/정산 포함
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let currentToken = document.body.dataset.token;
  const KIND_LABEL = {
    pre: "사전", shipment: "발송", content: "콘텐츠",
    live: "라이브", post: "사후", other: "기타",
  };
  const EVENT_LABEL = {
    live_start: "라이브 시작",
    live_end: "라이브 종료",
    shipment: "제품 발송",
    meeting: "미팅",
    deadline: "마감",
    other: "기타",
  };
  const EVENT_ICON = {
    live_start: "🔴", live_end: "⚪", shipment: "📦",
    meeting: "🎤", deadline: "⏰", other: "📌",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return `${d.getMonth()+1}/${d.getDate()}`;
    } catch { return iso; }
  }
  function fmtKRW(n) {
    if (!n || n === 0) return "0";
    return Number(n).toLocaleString("ko-KR");
  }

  // 페이지 로드 시 sp-sheet 강제 hide (안전망)
  const _initSheet = document.getElementById("spSheet");
  if (_initSheet) _initSheet.hidden = true;

  async function load(token) {
    try {
      const r = await fetch(`/api/seller/${token}`);
      if (!r.ok) {
        document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#888">유효하지 않은 링크입니다.</div>';
        return;
      }
      const data = await r.json();
      currentToken = token;
      window.history.replaceState(null, "", `/s/${token}`);
      render(data);
    } catch (e) {
      document.body.innerHTML = `<div style="padding:60px 20px;text-align:center;color:#888">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function render(data) {
    const c = data.campaign;
    const b = data.brand;
    const p = data.product;
    const others = data.other_rounds || [];
    const events = data.events || [];
    const fi = data.financials || {};
    const brandLabel = b ? `${b.emoji || "🏷️"} ${b.name}` : c.brand;

    $("#spBrandPill").textContent = brandLabel;
    $("#spD").textContent = c.d_label || "";
    $("#spTitle").textContent = `${c.seller_name} ${c.round}차 공구`;
    document.title = `${c.seller_name} ${c.round}차 · ${b ? b.name : (c.brand || "넥스트포트")}`;

    // N차 스위치
    const sw = $("#spRoundSwitch");
    if (others.length > 1) {
      sw.hidden = false;
      sw.innerHTML = others.map(o =>
        `<option value="${esc(o.token)}" ${o.token === currentToken ? "selected" : ""}>${o.round}차 (${esc(o.status || "")})</option>`
      ).join("");
      sw.onchange = () => load(sw.value);
    } else {
      sw.hidden = true;
    }

    // 서브
    const subParts = [];
    if (c.live_start) subParts.push(`📅 ${fmtDate(c.live_start)} ~ ${fmtDate(c.live_end)}`);
    if (c.open_kind) subParts.push(c.open_kind);
    if (c.stage_label) subParts.push(c.stage_label);
    $("#spSub").textContent = subParts.join(" · ");

    renderEvents(events);
    renderSchedule(c);
    renderSettle(c, fi);
    renderProduct(c, p);
    renderFAQ(c);
  }

  function renderEvents(events) {
    const root = $("#spEvents");
    if (!events.length) {
      root.innerHTML = `<div class="sp-empty" style="padding:14px;font-size:12px">이벤트 없음</div>`;
      return;
    }
    root.innerHTML = events.map(ev => {
      const icon = EVENT_ICON[ev.kind] || "📌";
      const label = EVENT_LABEL[ev.kind] || "기타";
      return `<div class="sp-event-row k-${esc(ev.kind || "other")}">
        <span class="ev-icon">${icon}</span>
        <div class="ev-body">
          <div class="ev-title">${esc(ev.title || label)}</div>
          <div class="ev-date">${esc(ev.date || "")}${ev.time ? " · " + esc(ev.time) : ""}</div>
        </div>
      </div>`;
    }).join("");
  }

  function renderSchedule(c) {
    const root = $("#spSchedule");
    const items = c.daily_schedule || [];
    if (!items.length) {
      root.innerHTML = `<div class="sp-empty">일자별 액션이 아직 등록되지 않았어요.</div>`;
      return;
    }
    root.innerHTML = items.map((it, idx) => {
      const tagLabel = KIND_LABEL[it.kind] || KIND_LABEL.other;
      const stories = Array.isArray(it.stories) ? it.stories : [];
      const filledSlots = stories.filter(s => s.caption || s.label || s.image_url).length;
      const hasFeed = it.feed_post && (it.feed_post.caption || it.feed_post.image_url);
      const slotCount = filledSlots + (hasFeed ? 1 : 0);
      const firstSlotLabel = stories.find(s => s.label || s.caption);
      return `
        <div class="sp-card k-${esc(it.kind || "other")} ${it.is_new ? "new" : ""}" data-idx="${idx}">
          <div class="sp-card-d">${esc(it.day_label || "")}</div>
          <div class="sp-card-date">${esc(it.date || "")}</div>
          <div class="sp-card-tag">${esc(tagLabel)}</div>
          ${slotCount > 0
            ? `<div class="sp-card-slots">📱 ${slotCount}개 슬롯</div>
               ${firstSlotLabel?.label ? `<div class="sp-card-title">${esc(firstSlotLabel.label)}</div>` : ""}
               ${firstSlotLabel?.caption ? `<div class="sp-card-sub">${esc(firstSlotLabel.caption.slice(0, 80))}...</div>` : ""}`
            : `<div class="sp-card-title">${esc(it.title || "")}</div>
               ${it.subtitle ? `<div class="sp-card-sub">${esc(it.subtitle)}</div>` : ""}`
          }
        </div>
      `;
    }).join("");
    $$(".sp-card", root).forEach(card => {
      card.addEventListener("click", () => openSheet(items[+card.dataset.idx]));
    });
  }

  function renderSettle(c, fi) {
    const root = $("#spSettle");
    if (!fi.has_data) {
      let html = `<div class="sp-info-box">
        <h3 style="font-size:12px;color:var(--muted);margin:0 0 8px 0">정산 정보</h3>
        <div class="sp-empty" style="padding:20px;font-size:12px">아직 매출 데이터가 입력되지 않았어요.<br>라이브 종료 후 업데이트됩니다.</div>`;
      // settlement 메타라도 표시
      const st = c.settlement || {};
      if (st.rs_percent || st.type) {
        html += `<div class="sp-prod-section">
          <h4>정산 조건</h4>
          ${st.rs_percent ? `<div class="sp-info-row"><span class="k">RS%</span><span class="v">${st.rs_percent}%</span></div>` : ""}
          ${st.type ? `<div class="sp-info-row"><span class="k">유형</span><span class="v">${esc(st.type)}</span></div>` : ""}
          ${st.pg_logistics ? `<div class="sp-info-row"><span class="k">PG/배송</span><span class="v">${esc(st.pg_logistics)}</span></div>` : ""}
        </div>`;
      }
      html += `</div>`;
      root.innerHTML = html;
      return;
    }
    const costs = fi.costs || {};
    root.innerHTML = `
      <div class="sp-settle-hero">
        <div class="ssh-label">총 매출</div>
        <div class="ssh-value">${fmtKRW(fi.revenue)}원</div>
        <div class="ssh-divider"></div>
        <div class="ssh-grid">
          <div><div class="ssg-label">총 비용</div><div class="ssg-value">−${fmtKRW(fi.total_cost)}원</div></div>
          <div><div class="ssg-label">공헌이익</div><div class="ssg-value gold">${fmtKRW(fi.profit)}원</div></div>
          <div><div class="ssg-label">이익률</div><div class="ssg-value gold">${fi.rate}%</div></div>
        </div>
      </div>

      <div class="sp-info-box" style="margin-top:14px">
        <h3>비용 상세</h3>
        <div class="sp-info-row"><span class="k">셀러수수료</span><span class="v">${fmtKRW(costs.seller_fee)}원</span></div>
        <div class="sp-info-row"><span class="k">PG사 수수료</span><span class="v">${fmtKRW(costs.pg_fee)}원</span></div>
        <div class="sp-info-row"><span class="k">이벤트 비용</span><span class="v">${fmtKRW(costs.event_cost)}원</span></div>
        <div class="sp-info-row"><span class="k">원가</span><span class="v">${fmtKRW(costs.cost)}원</span></div>
        <div class="sp-info-row"><span class="k">배송비</span><span class="v">${fmtKRW(costs.shipping)}원</span></div>
        <div class="sp-info-row"><span class="k">부가세</span><span class="v">${fmtKRW(costs.vat)}원</span></div>
      </div>
    `;
  }

  function renderProduct(c, p) {
    const root = $("#spProduct");
    if (!p && !c.product) {
      root.innerHTML = `<div class="sp-empty">제품 정보가 아직 등록되지 않았어요.</div>`;
      return;
    }
    const name = (p && p.name) || c.product || "제품";
    let html = `<div class="sp-prod-box">
      <h3>제품</h3>
      <div class="prod-name">${esc(name)}</div>`;
    if (p) {
      if (p.usp) html += `<div class="sp-prod-section"><h4>핵심 USP</h4><p>${esc(p.usp)}</p></div>`;
      if (p.detail) html += `<div class="sp-prod-section"><h4>상세 정보</h4><p>${esc(p.detail)}</p></div>`;
      if (p.price) html += `<div class="sp-prod-section"><h4>가격 / 혜택</h4><p>${esc(p.price)}</p></div>`;
      if (p.avoid) html += `<div class="sp-prod-section warn"><h4>⚠ 금지 멘트</h4><p>${esc(p.avoid)}</p></div>`;
    }
    html += `</div>`;

    // 시트 링크 + 캠페인 기본 정보
    if (c.sheet_url) {
      html += `<a class="sp-info-cta" href="${esc(c.sheet_url)}" target="_blank" rel="noopener">📋 상세 스케줄링 시트 열기 ↗</a>`;
    }
    root.innerHTML = html;
  }

  function renderFAQ(c) {
    const root = $("#spFaq");
    const faq = c.faq || [];
    if (!faq.length) {
      root.innerHTML = `<div class="sp-empty">아직 등록된 무물(Q&A)이 없어요.</div>`;
      return;
    }
    root.innerHTML = faq.map(f => `
      <div class="sp-faq-card">
        <div class="q">${esc(f.q || "")}</div>
        <div class="a">${esc(f.a || "")}</div>
      </div>
    `).join("");
  }

  function openSheet(it) {
    const body = $("#spSheetBody");
    const tag = KIND_LABEL[it.kind] || "기타";
    let html = `
      <div class="sp-sheet-tag">${esc(tag)}</div>
      <h2>${esc(it.day_label || it.title || it.date || "")}</h2>
      <div style="font-size:13px;color:#6b6e7d;margin-bottom:14px">${esc(it.date || "")}${it.subtitle ? " · " + esc(it.subtitle) : ""}</div>
    `;

    // STORY 슬롯들 (5개)
    const stories = Array.isArray(it.stories) ? it.stories : [];
    if (stories.length) {
      for (const s of stories) {
        if (!s.label && !s.caption && !s.image_url) continue;
        html += `<div class="sp-slot">
          <div class="sp-slot-label">${esc(s.label || `STORY ${s.slot || ""}`)}</div>
          ${s.image_url ? `<img class="sp-slot-img" src="${esc(s.image_url)}" alt="" loading="lazy" />` : ""}
          ${s.caption ? `<div class="sp-slot-caption">${esc(s.caption)}</div>
            <button class="sp-copy-btn" data-copy="${esc(s.caption)}">📋 멘트 복사</button>` : ""}
        </div>`;
      }
    }

    // 게시물
    const fp = it.feed_post;
    if (fp && (fp.label || fp.caption || fp.image_url)) {
      html += `<div class="sp-slot sp-slot-feed">
        <div class="sp-slot-label">📷 ${esc(fp.label || "게시물")}</div>
        ${fp.image_url ? `<img class="sp-slot-img" src="${esc(fp.image_url)}" alt="" loading="lazy" />` : ""}
        ${fp.caption ? `<div class="sp-slot-caption">${esc(fp.caption)}</div>
          <button class="sp-copy-btn" data-copy="${esc(fp.caption)}">📋 멘트 복사</button>` : ""}
      </div>`;
    }

    // 기존 호환 — actions[] 도 처리
    if (it.actions && it.actions.length) {
      html += `<div style="margin-top:14px"><h4 style="font-size:11px;color:#6b6e7d;margin:0 0 6px 0">액션</h4>`;
      for (const a of it.actions) {
        html += `<div class="sp-action">
          <div class="time">${esc(a.time || "")}${a.type ? " · " + esc(a.type) : ""}</div>
          <div class="what">${esc(a.guide || a.text || "")}</div>
        </div>`;
      }
      html += `</div>`;
    }

    if (it.notes) {
      html += `<div class="sp-slot sp-slot-notes">
        <div class="sp-slot-label">📝 비고</div>
        <div class="sp-slot-caption">${esc(it.notes)}</div>
      </div>`;
    }

    body.innerHTML = html;
    $("#spSheet").hidden = false;
  }

  // 복사 버튼
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".sp-copy-btn");
    if (!btn) return;
    const text = btn.dataset.copy || "";
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = "✓ 복사됨";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("copied");
      }, 1500);
    } catch (err) {
      // 폴백
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      btn.textContent = "✓ 복사됨";
      setTimeout(() => { btn.textContent = "📋 멘트 복사"; }, 1500);
    }
  });
  function closeSheet() {
    const sheet = $("#spSheet");
    if (sheet) sheet.hidden = true;
  }

  // X 버튼 + 백드롭에 직접 이벤트 박기 (글로벌 delegated 의존 X)
  $$("[data-sp-close]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      closeSheet();
    });
  });
  // sp-sheet 컨테이너 자체 클릭 (백드롭 영역) 시 닫기
  const sheetEl = $("#spSheet");
  if (sheetEl) {
    sheetEl.addEventListener("click", (e) => {
      // card 자체를 클릭한 게 아니면 (= 바깥 = 백드롭) 닫기
      if (e.target === sheetEl || e.target.classList.contains("sp-sheet-backdrop")) {
        closeSheet();
      }
    });
  }
  // ESC 키
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetEl && !sheetEl.hidden) {
      closeSheet();
    }
  });

  // 탭 전환은 글로벌 delegated 유지 (동적 element)
  document.addEventListener("click", (e) => {
    const tabBtn = e.target.closest(".sp-tab");
    if (tabBtn) {
      $$(".sp-tab").forEach(t => t.classList.toggle("active", t === tabBtn));
      $$(".sp-pane").forEach(p => p.classList.toggle("active", p.id === `sp-${tabBtn.dataset.spTab}`));
    }
    // 백업: data-sp-close 가 동적으로 박힐 수도 있어서 글로벌도 유지
    if (e.target.closest("[data-sp-close]")) closeSheet();
  });

  load(currentToken);
})();
