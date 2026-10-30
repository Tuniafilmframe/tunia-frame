// ====== Ghép ảnh vào khung nhiều ô ======
// Khung là file PNG: vùng trong suốt = các ô để khách thêm ảnh.
// Các ô được tự động nhận diện, không cần khai báo tọa độ.

const $ = id => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const fileInput = $("file");

const PREVIEW_MAX = 1400;  // cạnh dài tối đa của bản xem trước
const PHOTO_MAX = 2400;    // thu nhỏ ảnh khách trước khi dùng, giúp nhanh hơn

let frames = [];
const cache = {};           // id -> { img, FW, FH, slots }
let curId = null, cur = null, sel = -1, K = 1;
let drag = null;

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
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      res(c);
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("File này không phải ảnh hợp lệ.")); };
    im.src = url;
  });
}

// Tìm các vùng trong suốt nằm bên trong khung (không chạm mép ảnh) => danh sách ô
function detectSlots(img, FW, FH) {
  const sc = Math.min(1, 2000 / Math.max(FW, FH));
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
    if (!touch && area > n * 0.002) {
      boxes.push({ x: x0 / sc, y: y0 / sc, w: (x1 - x0 + 1) / sc, h: (y1 - y0 + 1) / sc });
    }
  }
  // Sắp xếp từ trên xuống, trái sang phải
  boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return boxes;
}

function initSlot(b) {
  return { ...b, photo: null, zoom: 1, rot: 0, px: 0, py: 0, flip: false, bri: 100, con: 100, sat: 100 };
}

// ----- Danh sách khung -----
async function init() {
  try {
    const res = await fetch("frames/manifest.json?t=" + Date.now(), { cache: "no-store" });
    frames = await res.json();
  } catch (e) {
    frames = [];
  }
  if (!frames.length) {
    $("hint").textContent = "Chưa có khung nào. Thêm file PNG vào thư mục frames/ rồi chạy make_manifest.py.";
    return;
  }
  renderFrameList();
  selectFrame(frames[0].id);
}

function renderFrameList() {
  const box = $("frames");
  box.innerHTML = "";
  frames.forEach(f => {
    const b = document.createElement("button");
    b.className = "frame-btn";
    b.dataset.id = f.id;
    const im = document.createElement("img");
    im.src = "frames/" + f.file;
    im.alt = "";
    const sp = document.createElement("span");
    sp.textContent = f.name;
    b.append(im, sp);
    b.onclick = () => selectFrame(f.id);
    box.appendChild(b);
  });
}

async function selectFrame(id) {
  curId = id;
  document.querySelectorAll(".frame-btn").forEach(b => b.classList.toggle("active", b.dataset.id === id));
  const meta = frames.find(f => f.id === id);
  if (!cache[id]) {
    $("loading").hidden = false;
    try {
      const img = await loadImage("frames/" + meta.file);
      const FW = img.naturalWidth, FH = img.naturalHeight;
      cache[id] = { img, FW, FH, slots: detectSlots(img, FW, FH).map(initSlot) };
    } catch (e) {
      $("loading").hidden = true;
      $("hint").textContent = e.message;
      return;
    }
    $("loading").hidden = true;
  }
  if (curId !== id) return;  // đã chuyển sang khung khác trong lúc tải
  cur = cache[id];
  K = Math.min(1, PREVIEW_MAX / cur.FW);
  sel = cur.slots.length ? 0 : -1;
  renderPreview();
}

// ----- Vẽ -----
function geometry(s) {
  const a = s.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  let mx = 0, my = 0;
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = dx * s.w / 2, y = dy * s.h / 2;
    mx = Math.max(mx, Math.abs(x * c + y * sn));
    my = Math.max(my, Math.abs(-x * sn + y * c));
  }
  return { c, sn, mx, my };
}

// Giữ ảnh luôn phủ kín ô khi kéo/xoay; trả về tỉ lệ hiển thị của ảnh.
function clampSlot(s) {
  const { c, sn, mx, my } = geometry(s);
  const pw = s.photo.width, ph = s.photo.height;
  const smin = Math.max(2 * mx / pw, 2 * my / ph);
  const S = smin * s.zoom;
  let lx = s.px * c + s.py * sn, ly = -s.px * sn + s.py * c;
  const bx = pw * S / 2 - mx, by = ph * S / 2 - my;
  lx = clamp(lx, -bx, bx);
  ly = clamp(ly, -by, by);
  s.px = lx * c - ly * sn;
  s.py = lx * sn + ly * c;
  return S;
}

function drawPhoto(c, s) {
  const S = clampSlot(s);
  c.save();
  c.beginPath();
  c.rect(s.x, s.y, s.w, s.h);
  c.clip();
  c.filter = `saturate(${s.sat}%)`;
  c.translate(s.x + s.w / 2 + s.px, s.y + s.h / 2 + s.py);
  c.rotate(s.rot * Math.PI / 180);
  c.scale(s.flip ? -1 : 1, 1);
  const pw = s.photo.width, ph = s.photo.height;
  c.drawImage(s.photo, -pw * S / 2, -ph * S / 2, pw * S, ph * S);
  c.restore();
}

function drawOverlay(c, s, i, active, FW, FH) {
  const lw = Math.min(FW, FH) * 0.004;
  const fs = Math.min(s.w, s.h) * 0.12;
  c.save();
  if (!s.photo) {
    c.fillStyle = "rgba(61,69,48,0.14)";
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
  }
  c.restore();
}

// Vẽ cả khung. preview=true thì có viền chọn ô; xuất file thì không có.
function draw(c, k, preview) {
  const { FW, FH, img, slots } = cur;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  c.setTransform(k, 0, 0, k, 0, 0);
  slots.forEach(s => { if (s.photo) drawPhoto(c, s); });
  c.drawImage(img, 0, 0, FW, FH);
  if (preview) slots.forEach((s, i) => drawOverlay(c, s, i, i === sel, FW, FH));
}

function renderPreview() {
  if (!cur) return;
  canvas.width = Math.round(cur.FW * K);
  canvas.height = Math.round(cur.FH * K);
  draw(ctx, K, true);
  syncControls();
}

function curSlot() {
  return cur && sel >= 0 ? cur.slots[sel] : null;
}

function syncControls() {
  const s = curSlot();
  const on = !!(s && s.photo);
  ["zoom", "rot", "sat", "flipBtn", "resetBtn", "clearBtn"]
    .forEach(id => $(id).disabled = !on);
  $("download").disabled = !(cur && cur.slots.some(x => x.photo));
  if (on) {
    $("zoom").value = s.zoom;
    $("rot").value = s.rot;
    $("sat").value = s.sat;
  }
  $("zoomVal").textContent = s ? Math.round(s.zoom * 100) + "%" : "";
  $("rotVal").textContent = s ? s.rot + "°" : "";
  $("satVal").textContent = s ? s.sat : "";

  if (!cur) return;
  const total = cur.slots.length;
  const filled = cur.slots.filter(x => x.photo).length;
  $("hint").textContent = total === 0
    ? "Khung này không có ô trong suốt. Kiểm tra lại file PNG."
    : `Đã thêm ${filled}/${total} ảnh. Bấm vào ô để chọn, kéo ảnh để căn vị trí. Shoot · Print · Keep.`;
}

// ----- Đưa ảnh vào ô -----
function firstEmpty() {
  return cur ? cur.slots.findIndex(s => !s.photo) : -1;
}

async function putPhoto(file, i) {
  if (!file || !file.type.startsWith("image/") || !cur || i < 0) return;
  const entry = cur;
  let photo;
  try {
    photo = await loadPhoto(file);
  } catch (e) {
    $("hint").textContent = e.message;
    return;
  }
  if (cur !== entry) return;  // đã đổi khung trong lúc tải
  Object.assign(entry.slots[i], { photo, zoom: 1, rot: 0, px: 0, py: 0, flip: false, bri: 100, con: 100, sat: 100 });
  sel = i;
  renderPreview();
}

fileInput.onchange = () => {
  const f = fileInput.files[0];
  fileInput.value = "";
  if (f && sel >= 0) putPhoto(f, sel);
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

canvas.addEventListener("pointerdown", e => {
  if (!cur) return;
  const p = toFrame(e), i = hit(p.x, p.y);
  drag = { i, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
  if (i >= 0 && i !== sel) { sel = i; renderPreview(); }
});

canvas.addEventListener("pointermove", e => {
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

canvas.addEventListener("pointerup", () => {
  if (drag && !drag.moved && drag.i >= 0 && !cur.slots[drag.i].photo) {
    sel = drag.i;
    fileInput.click();  // bấm vào ô trống => mở chọn ảnh
  }
  drag = null;
});
canvas.addEventListener("pointercancel", () => { drag = null; });

canvas.addEventListener("wheel", e => {
  if (!cur) return;
  e.preventDefault();
  const p = toFrame(e), i = hit(p.x, p.y);
  if (i < 0) return;
  sel = i;
  const s = cur.slots[i];
  if (!s.photo) { renderPreview(); return; }
  s.zoom = clamp(s.zoom * (e.deltaY < 0 ? 1.05 : 1 / 1.05), 1, 4);
  renderPreview();
}, { passive: false });

// Kéo ảnh từ máy vào ô
canvas.addEventListener("dragover", e => e.preventDefault());
canvas.addEventListener("drop", e => {
  e.preventDefault();
  if (!cur) return;
  const f = e.dataTransfer.files[0];
  const p = toFrame(e), i = hit(p.x, p.y);
  const target = i >= 0 ? i : firstEmpty();
  putPhoto(f, target);
});

// ----- Thanh chỉnh -----
function bind(id, key) {
  $(id).oninput = e => {
    const s = curSlot();
    if (!s || !s.photo) return;
    s[key] = +e.target.value;
    renderPreview();
  };
}
bind("zoom", "zoom");
bind("rot", "rot");
bind("sat", "sat");

$("flipBtn").onclick = () => {
  const s = curSlot();
  if (!s) return;
  s.flip = !s.flip;
  renderPreview();
};

$("resetBtn").onclick = () => {
  const s = curSlot();
  if (!s) return;
  Object.assign(s, { zoom: 1, rot: 0, px: 0, py: 0, flip: false, bri: 100, con: 100, sat: 100 });
  renderPreview();
};

$("clearBtn").onclick = () => {
  const s = curSlot();
  if (!s) return;
  s.photo = null;
  Object.assign(s, { zoom: 1, rot: 0, px: 0, py: 0, flip: false, bri: 100, con: 100, sat: 100 });
  renderPreview();
};

// ----- Tải khung đã ghép về máy -----
$("download").onclick = () => {
  if (!cur) return;
  const off = document.createElement("canvas");
  off.width = cur.FW;
  off.height = cur.FH;
  draw(off.getContext("2d"), 1, false);
  off.toBlob(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${curId}-ghep-anh.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
};

init();
