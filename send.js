// ====== Gửi ảnh cho tiệm in (qua Wi-Fi, sang máy tính của tiệm) ======
// Web chạy HTTPS không được phép gọi thẳng địa chỉ http trong mạng nội bộ (trình duyệt chặn),
// nên mở một cửa sổ nhỏ tới trang /send của máy tiệm rồi chuyển ảnh sang đó bằng postMessage.
// Cửa sổ nhỏ (cùng nguồn gốc với máy tiệm) tự tải ảnh lên và tự đóng.
(function () {
  "use strict";
  const CFG = window.TUNIA_CONFIG || {};
  const LS_KEY = "tunia-shop";
  const q = new URLSearchParams(location.search);
  const forceBridge = q.get("bridge") === "1";

  // ---- Địa chỉ máy tính tiệm: chỉ nhận địa chỉ trong mạng nội bộ (tránh gửi ảnh ra ngoài) ----
  function isPrivateHost(h) {
    h = h.toLowerCase();
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const o = m.slice(1).map(Number);
      if (o.some(n => n > 255)) return false;
      const [a, b] = o;
      return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    }
    return h === "localhost" || /\.local$/.test(h) || /^[a-z][a-z0-9-]*$/.test(h);   // tên máy trong mạng, ví dụ tunia-pc
  }
  function normalizeAddr(s) {
    s = String(s || "").trim().replace(/^https?:\/\//i, "").replace(/[\/?#].*$/, "");
    const m = s.match(/^([A-Za-z0-9.\-]+)(?::(\d{2,5}))?$/);
    if (!m) return "";
    const port = m[2] || "8765";
    if (+port > 65535 || !isPrivateHost(m[1])) return "";
    return m[1].toLowerCase() + ":" + port;
  }
  const getStored = () => { try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } };
  const setStored = v => { try { localStorage.setItem(LS_KEY, v); } catch (e) { /* bỏ qua */ } };

  // Mã QR trên máy tiệm mở web kèm ?shop=địa-chỉ: ghi nhớ rồi gỡ khỏi thanh địa chỉ
  if (q.has("shop")) {
    const a = normalizeAddr(q.get("shop"));
    if (a) setStored(a);
    q.delete("shop");
    try { history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash); } catch (e) { /* bỏ qua */ }
  }
  const shopAddr = () => normalizeAddr(getStored()) || normalizeAddr(CFG.shopAddress);

  const $ = id => document.getElementById(id);
  const btn = $("sendShop");
  if (!btn) return;
  if (CFG.sendEnabled === false) { btn.hidden = true; return; }

  // ---- Trạng thái hộp thoại ----
  let blob = null, blobSig = "", cancelled = false, popup = null, active = false, finished = false;

  const sig = () => set.id + JSON.stringify(entries.map(e => e.slots.map(s => [
    s.photo ? (s.file ? s.file.name + s.file.size + s.file.lastModified : "p") : 0, +s.zoom.toFixed(3), s.rot, Math.round(s.px), Math.round(s.py), s.flip])));
  const mbText = n => (n / 1048576).toFixed(1) + " MB";

  function ui(state, text) {
    $("sendBar").style.display = state === "sending" ? "block" : "none";
    $("sendSpin").hidden = !["prep", "connecting", "sending"].includes(state);
    $("sendStatus").textContent = text || "";
    $("sendStatus").className = "send-status" + (state === "error" ? " err" : state === "done" ? " ok" : "");
    $("sendForm").hidden = state === "done";
    $("sendIntro").hidden = state === "done";
    $("sendTick").hidden = state !== "done";
    $("sendGo").hidden = state === "done";
    $("sendGo").disabled = !(state === "ready" || state === "error");
    $("sendGo").textContent = state === "error" ? "Thử gửi lại" : "Gửi cho tiệm";
    $("sendCancel").textContent = state === "done" ? "Đóng" : "Hủy";
    ["sendAddr", "sendName", "sendNote"].forEach(id => { $(id).disabled = ["connecting", "sending"].includes(state); });
  }
  const bar = p => { $("sendBarFill").style.width = Math.round(p * 100) + "%"; };

  function openModal() {
    cancelled = false; finished = false; active = true;
    $("sendAddr").value = shopAddr();
    $("sendAddrErr").textContent = "";
    $("sendModal").hidden = false;
    document.body.classList.add("modal-open");
    prepare();
  }
  function closeModal() {
    cancelled = true; active = false;
    try { if (popup && !popup.closed && !finished) popup.close(); } catch (e) { /* bỏ qua */ }
    popup = null;
    $("sendModal").hidden = true;
    document.body.classList.remove("modal-open");
  }

  // ---- Chuẩn bị ảnh A4 (dùng đúng ảnh chất lượng in như nút tải) ----
  async function prepare() {
    const s = sig();
    if (blob && blobSig === s) { ui("ready", `Ảnh in đã sẵn sàng (${mbText(blob.size)}). Nối Wi-Fi của tiệm rồi bấm Gửi.`); return; }
    blob = null;
    ui("prep", "Đang chuẩn bị ảnh in chất lượng cao…");
    while (typeof exporting !== "undefined" && exporting) await new Promise(r => setTimeout(r, 300));
    let err = null;
    await runExport(async () => {
      try { blob = await buildSheetBlob((n, t) => { if (active) $("sendStatus").textContent = `Đang chuẩn bị ảnh in chất lượng cao… (${n}/${t})`; }); blobSig = s; }
      catch (e) { err = e; throw e; }
    });
    if (!active) return;
    if (err || !blob) { ui("error", "Không chuẩn bị được ảnh in. Hãy thử lại giúp mình nhé."); return; }
    ui("ready", `Ảnh in đã sẵn sàng (${mbText(blob.size)}). Nối Wi-Fi của tiệm rồi bấm Gửi.`);
  }

  // ---- Gửi trực tiếp (khi web chạy http, không bị chặn) ----
  function sendDirect(addr, meta) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", `http://${addr}/upload`);
      x.setRequestHeader("Content-Type", "image/png");
      x.setRequestHeader("X-Name", encodeURIComponent(meta.name));
      x.setRequestHeader("X-Note", encodeURIComponent(meta.note));
      x.setRequestHeader("X-Set", encodeURIComponent(meta.set));
      x.setRequestHeader("X-Kind", "A4");
      x.timeout = 120000;
      x.upload.onprogress = e => { if (e.lengthComputable) { bar(e.loaded / e.total); $("sendStatus").textContent = `Đang gửi ảnh cho tiệm… ${Math.round(e.loaded / e.total * 100)}%`; } };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) { /* bỏ qua */ } x.status === 200 && j.ok ? resolve(j) : reject(new Error(j.error || `Máy tiệm không nhận được ảnh (mã ${x.status}).`)); };
      x.onerror = x.ontimeout = () => reject(new Error("noconnect"));
      x.send(blob);
    });
  }

  // ---- Gửi qua cửa sổ cầu nối (khi web chạy HTTPS) ----
  function sendBridge(win, addr, meta) {
    const origin = "http://" + addr;
    return new Promise((resolve, reject) => {
      let stage = "wait", t1, t2, poll;
      const end = (fn, v) => { clearTimeout(t1); clearTimeout(t2); clearInterval(poll); window.removeEventListener("message", onMsg); fn(v); };
      function onMsg(e) {
        if (e.source !== win || e.origin !== origin) return;
        const d = e.data || {};
        if (d.type === "tunia-bridge-ready" && stage === "wait") {
          stage = "sending"; clearTimeout(t1);
          $("sendBar").style.display = "none";
          ui("sending", "Đang gửi ảnh cho tiệm… (cửa sổ nhỏ vừa mở sẽ tự đóng)");
          try { win.postMessage({ type: "tunia-photo", blob, name: meta.name, note: meta.note, set: meta.set, kind: "A4" }, origin); }
          catch (err) { return end(reject, new Error("Không chuyển được ảnh sang máy tiệm.")); }
          t2 = setTimeout(() => end(reject, new Error("Máy tiệm không phản hồi khi nhận ảnh. Hãy thử lại.")), 120000);
        } else if (d.type === "tunia-sent") { stage = "done"; end(resolve, d); }
        else if (d.type === "tunia-error") end(reject, new Error(d.message || "Máy tiệm báo lỗi khi nhận ảnh."));
      }
      window.addEventListener("message", onMsg);
      t1 = setTimeout(() => end(reject, new Error("noconnect")), CFG.bridgeTimeoutMs || 15000);
      poll = setInterval(() => { if (win.closed && stage !== "done") end(reject, new Error(stage === "wait" ? "noconnect" : "Cửa sổ gửi ảnh đã đóng trước khi gửi xong.")); }, 500);
    });
  }

  const NO_CONNECT = addr => `Không kết nối được máy tính của tiệm (${addr}). Hãy kiểm tra: (1) đã nối Wi-Fi của tiệm chưa, (2) chương trình nhận ảnh trên máy tiệm đang mở, (3) địa chỉ đúng như trên màn hình máy tiệm.`;

  // ---- Bấm "Gửi cho tiệm" ----
  function go() {
    const addr = normalizeAddr($("sendAddr").value);
    if (!addr) {
      $("sendAddrErr").textContent = "Nhập địa chỉ máy tính của tiệm (hiện trên màn hình máy tiệm), ví dụ 192.168.1.50:8765";
      $("sendAddr").focus();
      return;
    }
    if (!blob) return;
    $("sendAddrErr").textContent = "";
    $("sendAddr").value = addr; setStored(addr);
    const meta = { name: $("sendName").value.trim(), note: $("sendNote").value.trim(), set: set.name };
    cancelled = false;
    const viaBridge = location.protocol === "https:" || forceBridge;
    // Phải mở cửa sổ ngay trong lúc bấm, nếu không trình duyệt sẽ chặn
    if (viaBridge) {
      popup = window.open(`http://${addr}/send?bridge=1`, "tunia-send");
      if (!popup) { ui("error", "Trình duyệt đã chặn cửa sổ gửi ảnh. Hãy cho phép cửa sổ bật lên (pop-up) cho trang này rồi bấm Thử gửi lại."); return; }
    }
    ui("connecting", "Đang kết nối máy tính của tiệm…");
    bar(0);
    (viaBridge ? sendBridge(popup, addr, meta) : (ui("sending", "Đang gửi ảnh cho tiệm…"), sendDirect(addr, meta)))
      .then(() => { if (cancelled) return; finished = true; ui("done", "Tiệm đã nhận ảnh và sẽ in cho bạn."); })
      .catch(err => {
        if (cancelled) return;
        try { if (popup && !popup.closed) popup.close(); } catch (e) { /* bỏ qua */ }
        ui("error", err.message === "noconnect" ? NO_CONNECT(addr) : err.message);
      });
  }

  btn.onclick = openModal;
  $("sendGo").onclick = go;
  $("sendCancel").onclick = closeModal;
  $("sendModal").addEventListener("click", e => { if (e.target === $("sendModal") && !["connecting", "sending"].includes(currentState())) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && active && !$("sendModal").hidden) closeModal(); });
  const currentState = () => $("sendGo").hidden ? "done" : ($("sendAddr").disabled ? "sending" : "idle");
})();
