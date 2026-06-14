/*
 * 미팅 녹음 — MediaRecorder API.
 * 진행 예정 셀러 디테일 모달의 [🎙] 버튼 클릭 시 녹음 시작/중지.
 * 중지 시 webm Blob → multipart 업로드 → audio_file 박힘.
 */
(function () {
  if (!window.api) return;

  let mediaRecorder = null;
  let chunks = [];
  let currentInfId = null;
  let currentIdx = null;
  let recStartedAt = 0;
  let timerInterval = null;

  async function start(iid, idx, btn) {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("브라우저가 녹음 지원 안 함 (HTTPS 필요)");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 적절한 포맷 자동 선택
      const opts = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } :
                   MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } :
                   MediaRecorder.isTypeSupported("audio/mp4") ? { mimeType: "audio/mp4" } : {};
      mediaRecorder = new MediaRecorder(stream, opts);
      chunks = [];
      currentInfId = iid;
      currentIdx = idx;
      recStartedAt = Date.now();

      mediaRecorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        await upload();
      };
      mediaRecorder.start(1000); // 1초마다 chunk

      btn.classList.add("rec-active");
      btn.innerHTML = "⏹";
      btn.title = "녹음 중지";

      // 타이머 표시
      timerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - recStartedAt) / 1000);
        const m = Math.floor(sec / 60).toString().padStart(2, "0");
        const s = (sec % 60).toString().padStart(2, "0");
        btn.dataset.timer = `${m}:${s}`;
        // 카드 상단에 시간 표시
        const card = btn.closest(".pipe-meeting-card");
        let badge = card?.querySelector(".rec-timer-badge");
        if (card && !badge) {
          badge = document.createElement("span");
          badge.className = "rec-timer-badge";
          card.querySelector(".pmc-head")?.appendChild(badge);
        }
        if (badge) badge.textContent = `🔴 ${m}:${s}`;
      }, 500);

      window.showToast?.({ icon: "🎙", title: "녹음 시작", body: "다시 클릭 = 중지 + 업로드" });
    } catch (err) {
      alert("마이크 권한 거부: " + err.message);
    }
  }

  function stop(btn) {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    btn.classList.remove("rec-active");
    btn.innerHTML = "🎙";
    btn.title = "녹음 시작";
    btn.closest(".pipe-meeting-card")?.querySelector(".rec-timer-badge")?.remove();
  }

  async function upload() {
    if (!chunks.length || currentInfId == null || currentIdx == null) return;
    const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
    const ext = blob.type.includes("mp4") ? "m4a" : (blob.type.includes("webm") ? "webm" : "ogg");
    const fd = new FormData();
    fd.append("file", blob, `recording_${Date.now()}.${ext}`);
    try {
      const res = await fetch(`/api/pipeline/${currentInfId}/meeting/${currentIdx}/audio`, {
        method: "POST",
        body: fd,
      });
      const j = await res.json();
      if (j.error) {
        alert("업로드 실패: " + j.error);
        return;
      }
      window.showToast?.({
        icon: "✅",
        title: "녹취 저장됨",
        body: `${j.size_kb} KB · ${Math.floor((Date.now() - recStartedAt) / 1000)}초`,
        accent: true,
      });
      // 모달 다시 로드
      if (typeof window.refreshPipelineDetail === "function") {
        window.refreshPipelineDetail(currentInfId);
      } else {
        document.querySelector(`[data-v2="pipe-detail"][data-id="${currentInfId}"]`)?.click();
      }
    } catch (err) {
      alert("업로드 실패: " + err.message);
    } finally {
      chunks = [];
      currentInfId = null;
      currentIdx = null;
    }
  }

  // 기존 pipe-meeting-upload 핸들러를 가로채서 녹음/중지로 바꿈
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-v2="pipe-meeting-upload"]');
    if (!btn) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    const iid = btn.dataset.id;
    const idx = parseInt(btn.dataset.idx);

    if (mediaRecorder && mediaRecorder.state === "recording") {
      stop(btn);
    } else {
      // 옵션: 녹음 vs 파일 업로드 선택
      const choice = confirm("확인 = 마이크 녹음 시작 · 취소 = 기존 파일 업로드");
      if (choice) {
        start(iid, idx, btn);
      } else {
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = ".m4a,.mp3,.wav,.ogg,.webm";
        fi.onchange = async () => {
          const f = fi.files[0]; if (!f) return;
          const fd = new FormData(); fd.append("file", f);
          try {
            const res = await fetch(`/api/pipeline/${iid}/meeting/${idx}/audio`, { method: "POST", body: fd });
            const j = await res.json();
            if (j.error) { alert("실패: " + j.error); return; }
            window.showToast?.({ icon: "📤", title: "업로드 완료", body: `${j.size_kb} KB`, accent: true });
            document.querySelector(`[data-v2="pipe-detail"][data-id="${iid}"]`)?.click();
          } catch (err) { alert("실패: " + err.message); }
        };
        fi.click();
      }
    }
  }, true);  // capture phase — 기존 dm-phase-d.js 핸들러 가로챔
})();
