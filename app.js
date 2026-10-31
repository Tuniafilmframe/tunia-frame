// ====== TUNIA · Ghép ảnh vào bộ khung ======
// Một "bộ" gồm nhiều khung PNG (ô trong suốt = chỗ đặt ảnh).
// Khách ghép từng khung ở chế độ phóng to; khi đủ ảnh mọi ô, web ghép
// tất cả khung vào đúng vị trí trên tấm A4 để xem và tải bản in 300 dpi.

const $ = id => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const fileInput = $("file");

const PREVIEW_MAX = 1400;  // cạnh ngang tối đa của khung đang ghép
const PHOTO_MAX = 1600;    // bản xem trước cho mượt; khi in sẽ đọc lại ảnh gốc
const DPI = 300;
const MIN_PRINT_DPI = 150;  // dưới mức này: cảnh báo ảnh có thể mờ khi in

let set = null;            // bộ khung đang dùng (từ manifest)
let entries = [];          // [{ meta, img, FW, FH, slots }]
let cur = null, sel = -1, K = 1;
let drag = null;
let wasComplete = false;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Không tải được " + src));
    im.src = src;
  });
}

function loadPhoto(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, PHOTO_MAX / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k);
      c.height = Math.round(im.naturalHeight * k);
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(im, 0, 0, c.width, c.height);
      res({ preview: c, ow: im.naturalWidth, oh: im.naturalHeight });
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("File này không phải ảnh hợp lệ.")); };
    im.src = url;
  });
}

// Tìm các vùng trong suốt nằm bên trong khung (không chạm mép) => danh sách ô
function detectSlots(img, FW, FH) {
  const sc = Math.min(1, 2600 / Math.max(FW, FH));
  const w = Math.round(FW * sc), h = Math.round(FH * sc), n = w * h;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(img, 0, 0, w, h);
  const data = tctx.getImageData(0, 0, w, h).data;

  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) open[i] = data[i * 4 + 3] < 128 ? 1 : 0;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const boxes = [];

  for (let start = 0; start < n; start++) {
    if (!open[start] || seen[start]) continue;
    let sp = 0, area = 0, touch = false;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    seen[start] = 1; stack[sp++] = start;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p - px) / w;
      area++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touch = true;
      if (px > 0     && open[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < w - 1 && open[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0     && open[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (py < h - 1 && open[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (!touch && area > n * 0.0005) {
      boxes.push({ x: x0 / sc, y: y0 / sc, w: (x1 - x0 + 1) / sc, h: (y1 - y0 + 1) / sc });
    }
  }
  boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return boxes;
}

const blankSlot = b => ({ ...b, photo: null, file: null, ow: 0, oh: 0, zoom: 1, rot: 0, px: 0, py: 0, flip: false });
const RESET = { zoom: 1, rot: 0, px: 0, py: 0, flip: false };

// ----- Tải bộ khung -----
async function init() {
  let manifest;
  try {
    const res = await fetch("frames/manifest.json?t=" + Date.now(), { cache: "no-store" });
    manifest = await res.json();
  } catch (e) {
    $("hint").textContent = "Chưa có bộ khung nào. Kiểm tra lại frames/manifest.json.";
    return;
  }
  const sets = manifest.sets || [];
  if (!sets.length) { $("hint").textContent = "Chưa có bộ khung nào."; return; }
  await loadSet(sets[0]);
}

async function loadSet(s) {
  set = s;
  $("setName").textContent = s.name;
  $("loading").hidden = false;
  try {
    entries = await Promise.all(s.frames.map(async meta => {
      const img = await loadImage("frames/" + meta.file);
      const FW = img.naturalWidth, FH = img.naturalHeight;
      return { meta, img, FW, FH, slots: detectSlots(img, FW, FH).map(blankSlot) };
    }));
  } catch (e) {
    $("loading").hidden = true;
    $("hint").textContent = e.message;
    return;
  }
  $("loading").hidden = true;
  renderFrameList();
  selectFrame(0);
}

function renderFrameList() {
  const box = $("frames");
  box.innerHTML = "";
  entries.forEach((e, i) => {
    const b = document.createElement("button");
    b.className = "frame-btn";
    b.dataset.i = i;
    const im = document.createElement("img");
    im.src = "frames/" + e.meta.file;
    im.alt = "";
    const txt = document.createElement("span");
    txt.className = "frame-txt";
    const nm = document.createElement("span");
    nm.textContent = e.meta.name;
    const pg = document.createElement("span");
    pg.className = "frame-progress";
    txt.append(nm, pg);
    b.append(im, txt);
    b.onclick = () => selectFrame(i);
    box.appendChild(b);
  });
  updateFrameList();
}

function updateFrameList() {
  document.querySelectorAll(".frame-btn").forEach(b => {
    const e = entries[+b.dataset.i];
    const filled = e.slots.filter(s => s.photo).length;
    b.classList.toggle("active", e === cur);
    b.classList.toggle("done", filled === e.slots.length);
    b.querySelector(".frame-progress").textContent =
      filled === e.slots.length ? `✓ Đủ ${filled} ảnh` : `${filled}/${e.slots.length} ảnh`;
  });
}

function selectFrame(i) {
  cur = entries[i];
  K = Math.min(1, PREVIEW_MAX / cur.FW);
  sel = cur.slots.findIndex(s => !s.photo);
  if (sel < 0) sel = cur.slots.length ? 0 : -1;
  renderPreview();
}

// ----- Hình học -----
function clampSlot(s) {
  const a = s.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  let mx = 0, my = 0;
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = dx * s.w / 2, y = dy * s.h / 2;
    mx = Math.max(mx, Math.abs(x * c + y * sn));
    my = Math.max(my, Math.abs(-x * sn + y * c));
  }
  const pw = s.photo.width, ph = s.photo.height;
  const S = Math.max(2 * mx / pw, 2 * my / ph) * s.zoom;
  let lx = s.px * c + s.py * sn, ly = -s.px * sn + s.py * c;
  const bx = pw * S / 2 - mx, by = ph * S / 2 - my;
  lx = clamp(lx, -bx, bx);
  ly = clamp(ly, -by, by);
  s.px = lx * c - ly * sn;
  s.py = lx * sn + ly * c;
  return S;
}

// ----- Vẽ -----
function drawPhoto(c, s, src) {
  const S = clampSlot(s);
  src = src || s.photo;
  c.save();
  c.beginPath();
  c.rect(s.x, s.y, s.w, s.h);
  c.clip();
  c.translate(s.x + s.w / 2 + s.px, s.y + s.h / 2 + s.py);
  c.rotate(s.rot * Math.PI / 180);
  c.scale(s.flip ? -1 : 1, 1);
  const dw = s.photo.width * S, dh = s.photo.height * S;   // kích thước hiển thị (đơn vị khung)
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  c.restore();
}

// Độ phân giải in thực tế của ảnh trong ô (dpi), dựa trên ảnh gốc
function slotDpi(s) {
  if (!s.photo || !s.ow) return Infinity;
  const dw = s.photo.width * clampSlot(s);   // số pixel khung (300 dpi) mà ảnh chiếm
  return s.ow / dw * DPI;
}

function drawOverlay(c, e, s, i, active) {
  const lw = Math.min(e.FW, e.FH) * 0.004;
  const fs = Math.min(s.w, s.h) * 0.12;
  c.save();
  if (!s.photo) {
    c.fillStyle = "rgba(241,236,225,0.92)";
    c.fillRect(s.x, s.y, s.w, s.h);
  }
  c.lineWidth = lw;
  c.setLineDash(active ? [lw * 4, lw * 3] : []);
  c.strokeStyle = active ? "#3D4530" : "rgba(61,69,48,0.45)";
  c.strokeRect(s.x, s.y, s.w, s.h);
  if (!s.photo) {
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    c.fillStyle = "#3D4530";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `600 ${fs * 0.6}px "Be Vietnam Pro", system-ui, sans-serif`;
    c.fillText(`Ô ${i + 1}`, cx, cy - fs * 0.4);
    c.font = `${fs * 0.4}px "Be Vietnam Pro", system-ui, sans-serif`;
    c.fillText("Bấm để thêm ảnh", cx, cy + fs * 0.4);
  } else if (slotDpi(s) < MIN_PRINT_DPI) {
    const t = Math.max(fs * 0.38, 12);
    c.font = `600 ${t}px "Be Vietnam Pro", system-ui, sans-serif`;
    const label = "Ảnh có thể mờ khi in";
    const tw = c.measureText(label).width + t * 1.2;
    c.fillStyle = "rgba(122,59,46,0.92)";
    c.fillRect(s.x + t * 0.5, s.y + t * 0.5, tw, t * 1.7);
    c.fillStyle = "#F1ECE1";
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(label, s.x + t * 1.1, s.y + t * 1.35);
  }
  c.restore();
}

// Vẽ một khung (ảnh + khung) tại vị trí (ox, oy) với tỉ lệ k, không xóa nền.
function drawEntry(c, e, k, ox, oy, preview, sources) {
  c.setTransform(k, 0, 0, k, ox * k, oy * k);
  e.slots.forEach(s => { if (s.photo) drawPhoto(c, s, sources && sources.get(s)); });
  c.drawImage(e.img, 0, 0, e.FW, e.FH);
  if (preview) e.slots.forEach((s, i) => drawOverlay(c, e, s, i, e === cur && i === sel));
  c.setTransform(1, 0, 0, 1, 0, 0);
}

// Ghép cả bộ lên tấm A4. k = tỉ lệ so với kích thước in thật.
function drawSheet(c, k, sources) {
  const sh = set.sheet;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = sh.bg || "#ffffff";
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  entries.forEach(e => drawEntry(c, e, k, e.meta.x, e.meta.y, false, sources));
}

function renderPreview() {
  if (!cur) return;
  canvas.width = Math.round(cur.FW * K);
  canvas.height = Math.round(cur.FH * K);
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawEntry(ctx, cur, K, 0, 0, true);
  syncControls();
  scheduleSheet();
}

// Bản xem trước A4 nhỏ (cập nhật nhẹ nhàng, không vẽ lại mỗi lần di chuột)
let sheetQueued = false;
function scheduleSheet() {
  if (sheetQueued) return;
  sheetQueued = true;
  requestAnimationFrame(() => {
    sheetQueued = false;
    const mini = $("sheetMini");
    const k = 360 / set.sheet.w;
    mini.width = Math.round(set.sheet.w * k);
    mini.height = Math.round(set.sheet.h * k);
    drawSheet(mini.getContext("2d"), k);
    updateResult();
  });
}

function totals() {
  let filled = 0, total = 0;
  entries.forEach(e => e.slots.forEach(s => { total++; if (s.photo) filled++; }));
  return { filled, total };
}

// Khi đủ ảnh: hiện tấm A4 lớn
function updateResult() {
  const { filled, total } = totals();
  const done = total > 0 && filled === total;
  $("result").hidden = !done;
  $("download").disabled = !done;
  $("download2").disabled = !done;
  if (done) {
    const big = $("sheetBig");
    const k = 1400 / set.sheet.w;
    big.width = Math.round(set.sheet.w * k);
    big.height = Math.round(set.sheet.h * k);
    drawSheet(big.getContext("2d"), k);
    if (!wasComplete) $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  wasComplete = done;
}

function curSlot() {
  return cur && sel >= 0 ? cur.slots[sel] : null;
}

function syncControls() {
  const s = curSlot();
  const on = !!(s && s.photo);
  ["zoom", "rot", "flipBtn", "resetBtn", "clearBtn"].forEach(id => $(id).disabled = !on);
  if (on) {
    $("zoom").value = s.zoom;
    $("rot").value = s.rot;
  }
  $("zoomVal").textContent = s ? Math.round(s.zoom * 100) + "%" : "";
  $("rotVal").textContent = s ? Math.round(s.rot) + "°" : "";
  updateFrameList();

  const { filled, total } = totals();
  const here = cur.slots.filter(x => x.photo).length;
  const blurry = s && s.photo && slotDpi(s) < MIN_PRINT_DPI;
  $("progress").textContent = `${filled}/${total} ảnh`;
  $("hint").textContent = filled === total
    ? "Đã đủ ảnh cho cả bộ. Xem bản in A4 bên dưới và bấm “Tải bản in A4”."
    : `${cur.meta.name}: ${here}/${cur.slots.length} ảnh · Cả bộ: ${filled}/${total}. Bấm vào ô để chọn, kéo ảnh để căn vị trí.`;
  if (blurry) $("hint").textContent = `Ảnh ở ô này hơi nhỏ (khoảng ${Math.round(slotDpi(s))} dpi) nên in ra có thể mờ. Hãy thu nhỏ lại hoặc chọn ảnh gốc rõ hơn.`;
}

// ----- Đưa ảnh vào ô -----
async function putPhoto(file, e, i) {
  if (!file || !file.type.startsWith("image/") || !e || i < 0) return;
  let loaded;
  try {
    loaded = await loadPhoto(file);
  } catch (err) {
    $("hint").textContent = err.message;
    return;
  }
  Object.assign(e.slots[i], { photo: loaded.preview, file, ow: loaded.ow, oh: loaded.oh }, RESET);
  if (e === cur) sel = i;
  renderPreview();
}

fileInput.onchange = () => {
  const f = fileInput.files[0];
  fileInput.value = "";
  if (f && cur && sel >= 0) putPhoto(f, cur, sel);
};

// Thêm nhiều ảnh: điền lần lượt vào ô trống, khung đang mở trước rồi tới các khung sau
$("fileMulti").onchange = async () => {
  const files = [...$("fileMulti").files].filter(f => f.type.startsWith("image/"));
  $("fileMulti").value = "";
  if (!cur) return;
  const start = entries.indexOf(cur);
  const order = entries.slice(start).concat(entries.slice(0, start));
  const targets = [];
  order.forEach(e => e.slots.forEach((s, i) => { if (!s.photo) targets.push([e, i]); }));
  $("hint").textContent = "Đang thêm ảnh…";
  for (let n = 0; n < files.length && n < targets.length; n++) {
    await putPhoto(files[n], targets[n][0], targets[n][1]);
  }
  // mở khung tiếp theo còn ô trống (nếu có)
  const next = entries.findIndex(e => e.slots.some(s => !s.photo));
  if (next >= 0 && !cur.slots.some(s => !s.photo)) selectFrame(next);
  else renderPreview();
};

// ----- Chuột / cảm ứng -----
function toFrame(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * cur.FW, y: (e.clientY - r.top) / r.height * cur.FH };
}

function hit(x, y) {
  let best = -1, bestArea = Infinity;
  cur.slots.forEach((s, i) => {
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      const a = s.w * s.h;
      if (a < bestArea) { bestArea = a; best = i; }
    }
  });
  return best;
}

// Một ngón: kéo ảnh. Hai ngón: chụm/mở để phóng to, xoay hai ngón để xoay, di chuyển để kéo.
const pointers = new Map();   // pointerId -> { x, y }
let pinch = null;

const wrapDeg = d => ((d + 180) % 360 + 360) % 360 - 180;
function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    ang: Math.atan2(b.y - a.y, b.x - a.x),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}
function startPinch() {
  const st = pinchState();
  const r = canvas.getBoundingClientRect();
  const i = hit((st.mx - r.left) / r.width * cur.FW, (st.my - r.top) / r.height * cur.FH);
  const idx = i >= 0 ? i : (drag && drag.i >= 0 ? drag.i : sel);
  const s = idx >= 0 ? cur.slots[idx] : null;
  if (!s || !s.photo) { pinch = null; return; }
  if (idx !== sel) sel = idx;
  pinch = { s, ...st, zoom0: s.zoom, rot0: s.rot };
}

canvas.addEventListener("pointerdown", e => {
  if (!cur) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 1) {
    const p = toFrame(e), i = hit(p.x, p.y);
    drag = { i, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
    if (i >= 0 && i !== sel) { sel = i; renderPreview(); }
  } else if (pointers.size === 2) {
    if (drag) drag.moved = true;   // không coi là bấm để mở chọn ảnh
    startPinch();
    renderPreview();
  }
});

canvas.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {
    if (!pinch) return;
    const st = pinchState();
    const s = pinch.s;
    const r = canvas.getBoundingClientRect();
    if (pinch.dist > 0) s.zoom = clamp(pinch.zoom0 * st.dist / pinch.dist, 1, 4);
    s.rot = Math.round(wrapDeg(pinch.rot0 + (st.ang - pinch.ang) * 180 / Math.PI) * 10) / 10;
    s.px += (st.mx - pinch.mx) * cur.FW / r.width;
    s.py += (st.my - pinch.my) * cur.FH / r.height;
    pinch.mx = st.mx; pinch.my = st.my;
    renderPreview();
    return;
  }

  if (!drag) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  const s = drag.i >= 0 ? cur.slots[drag.i] : null;
  if (drag.moved && s && s.photo) {
    const r = canvas.getBoundingClientRect();
    s.px += (e.clientX - drag.lx) * cur.FW / r.width;
    s.py += (e.clientY - drag.ly) * cur.FH / r.height;
    renderPreview();
  }
  drag.lx = e.clientX;
  drag.ly = e.clientY;
});

function endPointer(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    // còn một ngón: tiếp tục kéo từ vị trí hiện tại, không bị giật
    pinch = null;
    const [p] = [...pointers.values()];
    if (drag) { drag.lx = p.x; drag.ly = p.y; drag.moved = true; }
    return;
  }
  if (pointers.size === 0) {
    if (!cancelled && drag && !drag.moved && drag.i >= 0 && !cur.slots[drag.i].photo) {
      sel = drag.i;
      fileInput.click();  // bấm vào ô trống => mở chọn ảnh
    }
    drag = null;
    pinch = null;
  }
}
canvas.addEventListener("pointerup", e => endPointer(e, false));
canvas.addEventListener("pointercancel", e => endPointer(e, true));

// Bàn di chuột Mac (Safari): chụm/xoay hai ngón
let gesture = null;
canvas.addEventListener("gesturestart", e => {
  if (pointers.size || !cur) return;   // trên điện thoại đã xử lý bằng cảm ứng
  const s = curSlot();
  if (!s || !s.photo) return;
  e.preventDefault();
  gesture = { s, zoom0: s.zoom, rot0: s.rot };
});
canvas.addEventListener("gesturechange", e => {
  if (!gesture) return;
  e.preventDefault();
  gesture.s.zoom = clamp(gesture.zoom0 * e.scale, 1, 4);
  gesture.s.rot = Math.round(wrapDeg(gesture.rot0 + e.rotation) * 10) / 10;
  renderPreview();
});
canvas.addEventListener("gestureend", () => { gesture = null; });

canvas.addEventListener("wheel", e => {
  if (!cur) return;
  const p = toFrame(e), i = hit(p.x, p.y);
  if (i < 0) return;
  e.preventDefault();
  sel = i;
  const s = cur.slots[i];
  if (s.photo) s.zoom = clamp(s.zoom * (e.deltaY < 0 ? 1.05 : 1 / 1.05), 1, 4);
  renderPreview();
}, { passive: false });

canvas.addEventListener("dragover", e => e.preventDefault());
canvas.addEventListener("drop", e => {
  e.preventDefault();
  if (!cur) return;
  const f = e.dataTransfer.files[0];
  const p = toFrame(e), i = hit(p.x, p.y);
  putPhoto(f, cur, i >= 0 ? i : cur.slots.findIndex(s => !s.photo));
});

// ----- Thanh chỉnh -----
$("zoom").oninput = e => { const s = curSlot(); if (s && s.photo) { s.zoom = +e.target.value; renderPreview(); } };
$("rot").oninput = e => { const s = curSlot(); if (s && s.photo) { s.rot = +e.target.value; renderPreview(); } };
$("flipBtn").onclick = () => { const s = curSlot(); if (s) { s.flip = !s.flip; renderPreview(); } };
$("resetBtn").onclick = () => { const s = curSlot(); if (s) { Object.assign(s, RESET); renderPreview(); } };
$("clearBtn").onclick = () => { const s = curSlot(); if (s) { Object.assign(s, { photo: null, file: null, ow: 0, oh: 0 }, RESET); renderPreview(); } };
$("editAgain").onclick = () => $("ghep").scrollIntoView({ behavior: "smooth", block: "start" });

// ----- Tải bản in A4 (PNG, gắn 300 dpi) -----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// Chèn khối pHYs (độ phân giải) ngay sau IHDR của file PNG
async function withDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);   // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33;                              // 8 byte chữ ký + 25 byte IHDR
  const out = new Uint8Array(src.length + 21);
  out.set(src.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(src.subarray(at), at + 21);
  return new Blob([out], { type: "image/png" });
}

// Thu nhỏ chất lượng cao: giảm một nửa nhiều lần rồi mới về đúng kích thước
function resizeHQ(src, w, h, tw, th) {
  while (w / 2 >= tw && h / 2 >= th) {
    const c = document.createElement("canvas");
    c.width = Math.round(w / 2); c.height = Math.round(h / 2);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, c.width, c.height);
    src = c; w = c.width; h = c.height;
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, tw); c.height = Math.max(1, th);
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Đọc lại ảnh gốc của khách ở đúng độ phân giải cần cho ô (mỗi lần một ảnh để nhẹ máy)
async function printSource(s) {
  if (!s.file) return s.photo;
  const S = clampSlot(s);
  const tw = Math.ceil(s.photo.width * S), th = Math.ceil(s.photo.height * S);
  const url = URL.createObjectURL(s.file);
  try {
    const im = await loadImage(url);
    const W0 = im.naturalWidth, H0 = im.naturalHeight;
    // ảnh gốc lớn hơn cần: thu nhỏ chuẩn; nhỏ hơn: giữ nguyên toàn bộ điểm ảnh gốc
    return W0 > tw ? resizeHQ(im, W0, H0, tw, th) : resizeHQ(im, W0, H0, W0, H0);
  } catch (e) {
    return s.photo;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadSheet() {
  if (!set) return;
  ["download", "download2"].forEach(id => $(id).disabled = true);
  const slots = [];
  entries.forEach(e => e.slots.forEach(s => { if (s.photo) slots.push(s); }));
  try {
    const sources = new Map();
    for (let n = 0; n < slots.length; n++) {
      $("hint").textContent = `Đang tạo bản in A4 chất lượng cao… (${n + 1}/${slots.length})`;
      sources.set(slots[n], await printSource(slots[n]));
    }
    const off = document.createElement("canvas");
    off.width = set.sheet.w;
    off.height = set.sheet.h;
    drawSheet(off.getContext("2d"), 1, sources);
    sources.clear();
    const blob = await new Promise(res => off.toBlob(res, "image/png"));
    const file = await withDpi(blob, DPI);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = `TUNIA-${set.id}-A4.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    $("hint").textContent = "Không tạo được bản in, thử lại giúp mình nhé.";
  } finally {
    syncControls();
    updateResult();
  }
}
$("download").onclick = downloadSheet;
$("download2").onclick = downloadSheet;

init();
