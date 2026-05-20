/*
 * 넥스트포트 워크스페이스 - AI 채팅 위젯 (격리된 JS)
 * 다른 코드와 의존 0. 이 파일만 지우면 깔끔하게 제거됨.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const widget = $("#chat-widget");
  if (!widget) return; // 위젯 없으면 종료

  const fab = $("#chatFab");
  const closeBtn = $("#chatCloseBtn");
  const newBtn = $("#chatNewBtn");
  const panel = widget.querySelector(".chat-panel");
  const messages = $("#chatMessages");
  const input = $("#chatInput");
  const sendBtn = $("#chatSendBtn");
  const attachBtn = $("#chatAttachBtn");
  const imageInput = $("#chatImageInput");
  const preview = $("#chatPreview");

  let pendingImage = null;
  let isSending = false;
  let loaded = false;

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function toggle() {
    const wasCollapsed = widget.classList.contains("collapsed");
    widget.classList.toggle("collapsed");
    if (wasCollapsed) {
      if (!loaded) {
        loadMessages();
        loaded = true;
      }
      setTimeout(() => input?.focus(), 200);
    }
  }

  fab?.addEventListener("click", toggle);
  closeBtn?.addEventListener("click", toggle);

  newBtn?.addEventListener("click", async () => {
    if (!confirm("새 대화 시작? 지금까지 대화는 사라져요.")) return;
    try {
      await fetch("/api/chat/new", { method: "POST" });
      messages.innerHTML = '<div class="chat-empty"><div class="big">💬</div>대화를 시작하세요</div>';
      pendingImage = null;
      renderPreview();
    } catch (e) { alert("초기화 실패: " + e.message); }
  });

  const TOOL_LABEL = {
    list_campaigns: "📋 캠페인 조회",
    find_campaign: "🔍 캠페인 찾기",
    add_campaign: "✨ 캠페인 추가",
    update_campaign: "✏️ 캠페인 수정",
    add_calendar_event: "📅 캘린더 이벤트 추가",
    add_meeting: "🎤 미팅 추가",
    list_brands: "🏷️ 브랜드 조회",
    get_today_summary: "📊 오늘 요약",
  };

  function renderMessage(m) {
    const div = document.createElement("div");
    div.className = `chat-msg ${m.role}`;
    let html = "";
    if (m.image) html += `<img class="msg-image" src="${escHtml(m.image)}" alt="이미지" />`;
    if (m.text) html += escHtml(m.text);
    if (m.tool_calls && m.tool_calls.length) {
      html += '<div class="chat-tools">';
      for (const tc of m.tool_calls) {
        const label = TOOL_LABEL[tc.name] || tc.name;
        const argsBrief = formatToolArgs(tc.args || {});
        html += `<div class="chat-tool-row" title="${escHtml(JSON.stringify(tc.args))}">
          <span class="ct-icon">✓</span>
          <span class="ct-name">${escHtml(label)}</span>
          ${argsBrief ? `<span class="ct-args">${escHtml(argsBrief)}</span>` : ''}
        </div>`;
      }
      html += '</div>';
    }
    div.innerHTML = html;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function formatToolArgs(args) {
    if (!args || !Object.keys(args).length) return "";
    // 가장 중요한 필드 위주로 짧게
    const priority = ["seller_name", "title", "date", "round_number", "live_start", "live_end", "status", "campaign_id"];
    const shown = [];
    for (const k of priority) {
      if (args[k] != null && args[k] !== "") shown.push(`${k}:${args[k]}`);
    }
    // changes는 별도 처리
    if (args.changes) {
      shown.push(`changes:${Object.keys(args.changes).join(",")}`);
    }
    return shown.slice(0, 4).join(" · ");
  }

  async function loadMessages() {
    try {
      const r = await fetch("/api/chat/messages");
      const data = await r.json();
      messages.innerHTML = "";
      if (!data.messages || data.messages.length === 0) {
        messages.innerHTML = `
          <div class="chat-empty">
            <div class="big">💬</div>
            <div><b>안녕하세요!</b></div>
            <div style="margin-top:6px">메시지를 입력하거나 이미지를 끌어 놓으세요.</div>
          </div>`;
        return;
      }
      for (const m of data.messages) renderMessage(m);
    } catch (e) {
      messages.innerHTML = `<div class="chat-empty">에러: ${escHtml(e.message)}</div>`;
    }
  }

  function renderPreview() {
    if (!pendingImage) {
      preview.hidden = true;
      preview.innerHTML = "";
      return;
    }
    const url = URL.createObjectURL(pendingImage);
    preview.hidden = false;
    const sizeKB = Math.round((pendingImage.size || 0) / 1024);
    const name = pendingImage.name || "붙여넣은 이미지";
    preview.innerHTML = `
      <img src="${url}" />
      <span class="preview-info">${escHtml(name)} (${sizeKB} KB)</span>
      <button class="preview-remove" data-remove-img>✕</button>
    `;
  }

  preview.addEventListener("click", (e) => {
    if (e.target.matches("[data-remove-img]")) {
      pendingImage = null;
      renderPreview();
    }
  });

  // 첨부 버튼 → 파일 선택
  attachBtn?.addEventListener("click", () => imageInput.click());
  imageInput?.addEventListener("change", () => {
    if (imageInput.files && imageInput.files[0]) {
      pendingImage = imageInput.files[0];
      renderPreview();
      imageInput.value = "";
    }
  });

  // 드래그 앤 드롭 (패널 전체)
  ["dragenter", "dragover"].forEach((ev) => {
    panel.addEventListener(ev, (e) => {
      e.preventDefault();
      panel.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    panel.addEventListener(ev, (e) => {
      e.preventDefault();
      panel.classList.remove("dragover");
    });
  });
  panel.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith("image/")) {
      pendingImage = f;
      renderPreview();
    }
  });

  // 클립보드 paste (입력란에서)
  input?.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          pendingImage = blob;
          renderPreview();
          e.preventDefault();
        }
        break;
      }
    }
  });

  async function sendMessage() {
    if (isSending) return;
    const text = input.value.trim();
    if (!text && !pendingImage) return;

    isSending = true;
    sendBtn.disabled = true;

    const fd = new FormData();
    fd.append("text", text);
    if (pendingImage) fd.append("image", pendingImage);

    // 사용자 메시지 즉시 표시
    // empty placeholder 제거
    const empty = messages.querySelector(".chat-empty");
    if (empty) empty.remove();

    const localImg = pendingImage ? URL.createObjectURL(pendingImage) : null;
    renderMessage({ role: "user", text, image: localImg });

    input.value = "";
    input.style.height = "auto";
    pendingImage = null;
    renderPreview();

    // 타이핑 인디케이터
    const typing = document.createElement("div");
    typing.className = "chat-typing";
    typing.textContent = "AI 답변 중";
    messages.appendChild(typing);
    messages.scrollTop = messages.scrollHeight;

    try {
      const r = await fetch("/api/chat/send", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      typing.remove();
      if (data.reply) renderMessage(data.reply);

      // 워크스페이스 데이터 변경됐으면 새로고침 이벤트 발행 (격리 통신)
      if (data.changed && data.changed.length) {
        window.dispatchEvent(new CustomEvent("workspace-refresh", {
          detail: { kinds: data.changed }
        }));
      }
    } catch (e) {
      typing.textContent = "에러: " + e.message;
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn?.addEventListener("click", sendMessage);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 자동 높이 조절
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
})();
