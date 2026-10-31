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

// Tìm các ô: vùng trong suốt nằm bên trong khung (không chạm mép).
// Mỗi ô có hình dạng thật (chữ nhật, oval, góc khuyết...) và cả vùng mờ dần ở mép.
const MIN_SLOT_AREA = 6000;   // px² của khung; nhỏ hơn thì coi là chi tiết, không phải ô
function detectSlots(img, FW, FH) {
  const sc = Math.min(1, 2600 / Math.max(FW, FH));
  const w = Math.round(FW * sc), h = Math.round(FH * sc), n = w * h;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(img, 0, 0, w, h);
  const data = tctx.getImageData(0, 0, w, h).data;

  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3];
  const lab = new Int32Array(n);          // 0 = chưa xét, id = thuộc vùng trong suốt số id
  const stack = new Int32Array(n);
  const comps = [];

  // 1) Vùng trong suốt hẳn (alpha < 128)
  for (let start = 0; start < n; start++) {
    if (alpha[start] >= 128 || lab[start]) continue;
    const id = comps.length + 1;
    let sp = 0, area = 0, touch = false;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    lab[start] = id; stack[sp++] = start;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p - px) / w;
      area++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touch = true;
      if (px > 0     && alpha[p - 1] < 128 && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (px < w - 1 && alpha[p + 1] < 128 && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (py > 0     && alpha[p - w] < 128 && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
      if (py < h - 1 && alpha[p + w] < 128 && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ id, area, touch, x0, y0, x1, y1 });
  }

  const PAD = 60;
  const slots = [];
  for (const c of comps) {
    if (c.touch || c.area / (sc * sc) < MIN_SLOT_AREA) continue;
    // 2) Vùng làm việc quanh ô; mở rộng sang các điểm mờ (alpha < 250) nối liền với ô
    const rx0 = Math.max(0, c.x0 - PAD), ry0 = Math.max(0, c.y0 - PAD);
    const rx1 = Math.min(w - 1, c.x1 + PAD), ry1 = Math.min(h - 1, c.y1 + PAD);
    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1, rn = rw * rh;
    const grown = new Uint8Array(rn);
    const st = new Int32Array(rn);
    let sp = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (lab[y * w + x] === c.id) { const q = (y - ry0) * rw + (x - rx0); grown[q] = 1; st[sp++] = q; }
      }
    }
    // vùng trong suốt nhỏ (lỗ của chữ, hoa văn) nằm trong khung bao của ô: ảnh cũng phải hiện ra ở đó
    for (const t of comps) {
      if (t === c || t.touch || t.area / (sc * sc) >= MIN_SLOT_AREA) continue;
      if (t.x0 < c.x0 || t.x1 > c.x1 || t.y0 < c.y0 || t.y1 > c.y1) continue;
      for (let y = t.y0; y <= t.y1; y++) {
        for (let x = t.x0; x <= t.x1; x++) {
          if (lab[y * w + x] === t.id) grown[(y - ry0) * rw + (x - rx0)] = 1;
        }
      }
    }
    const canGrow = (q) => {
      const gx = rx0 + (q % rw), gy = ry0 + Math.floor(q / rw), g = gy * w + gx;
      return alpha[g] < 250 && (lab[g] === 0 || lab[g] === c.id);
    };
    while (sp > 0) {
      const q = st[--sp];
      const qx = q % rw, qy = (q - qx) / rw;
      if (qx > 0      && !grown[q - 1])  { if (canGrow(q - 1))  { grown[q - 1] = 1;  st[sp++] = q - 1; } }
      if (qx < rw - 1 && !grown[q + 1])  { if (canGrow(q + 1))  { grown[q + 1] = 1;  st[sp++] = q + 1; } }
      if (qy > 0      && !grown[q - rw]) { if (canGrow(q - rw)) { grown[q - rw] = 1; st[sp++] = q - rw; } }
      if (qy < rh - 1 && !grown[q + rw]) { if (canGrow(q + rw)) { grown[q + rw] = 1; st[sp++] = q + rw; } }
    }
    // 3) Lấp các lỗ bên trong (chữ, hoa văn nằm giữa ô): chỉ phần nối với mép vùng làm việc mới là "bên ngoài"
    const outside = new Uint8Array(rn);
    sp = 0;
    const seed = (q) => { if (!grown[q] && !outside[q]) { outside[q] = 1; st[sp++] = q; } };
    for (let x = 0; x < rw; x++) { seed(x); seed((rh - 1) * rw + x); }
    for (let y = 0; y < rh; y++) { seed(y * rw); seed(y * rw + rw - 1); }
    while (sp > 0) {
      const q = st[--sp];
      const qx = q % rw, qy = (q - qx) / rw;
      if (qx > 0)      seed(q - 1);
      if (qx < rw - 1) seed(q + 1);
      if (qy > 0)      seed(q - rw);
      if (qy < rh - 1) seed(q + rw);
    }
    const mask = new Uint8Array(rn);
    let mx0 = rw, my0 = rh, mx1 = 0, my1 = 0, mArea = 0, sx = 0, sy = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (!outside[y * rw + x]) {
          mask[y * rw + x] = 1; mArea++; sx += x; sy += y;
          if (x < mx0) mx0 = x;
          if (x > mx1) mx1 = x;
          if (y < my0) my0 = y;
          if (y > my1) my1 = y;
        }
      }
    }
    // 4) Đường cắt (Path2D) từ các đoạn ngang, gộp các hàng giống nhau
    const clip = new Path2D();
    let prev = new Map();
    const flush = (rect) => clip.rect((rx0 + rect.a) / sc, (ry0 + rect.y0) / sc, (rect.b - rect.a) / sc, (rect.y1 - rect.y0) / sc);
    for (let y = my0; y <= my1 + 1; y++) {
      const cur2 = new Map();
      if (y <= my1) {
        let x = mx0;
        while (x <= mx1) {
          if (!mask[y * rw + x]) { x++; continue; }
          const a = x;
          while (x <= mx1 && mask[y * rw + x]) x++;
          const key = a + ":" + x;
          const r = prev.get(key);
          if (r) { r.y1 = y + 1; cur2.set(key, r); prev.delete(key); }
          else cur2.set(key, { a, b: x, y0: y, y1: y + 1 });
        }
      }
      prev.forEach(flush);     // các đoạn không còn nối tiếp ở hàng này
      prev = cur2;
    }
    // 5) Hình dạng: chữ nhật hay không; nếu không thì lấy điểm viền để vẽ nét chấm
    const bw = mx1 - mx0 + 1, bh = my1 - my0 + 1;
    const isRect = mArea / (bw * bh) > 0.985;
    const outline = [];
    if (!isRect) {
      for (let y = my0; y <= my1; y++) {
        for (let x = mx0; x <= mx1; x++) {
          if (!mask[y * rw + x] || (x + y) % 18) continue;
          const edge = x === 0 || y === 0 || x === rw - 1 || y === rh - 1 ||
            !mask[y * rw + x - 1] || !mask[y * rw + x + 1] || !mask[(y - 1) * rw + x] || !mask[(y + 1) * rw + x];
          if (edge) outline.push((rx0 + x) / sc, (ry0 + y) / sc);
        }
      }
    }
    // dữ liệu để bấm trúng đúng hình dạng của ô
    const hm = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) hm[y * bw + x] = mask[(my0 + y) * rw + mx0 + x];
    slots.push({
      x: (rx0 + mx0) / sc, y: (ry0 + my0) / sc, w: bw / sc, h: bh / sc,
      cx: (rx0 + sx / mArea) / sc, cy: (ry0 + sy / mArea) / sc,
      clip, isRect, outline,
      hitmask: { x0: rx0 + mx0, y0: ry0 + my0, bw, bh, sc, data: hm },
    });
  }
  slots.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return slots;
}

const blankSlot = b => ({ ...b, photo: null, file: null, ow: 0, oh: 0, zoom: 1, rot: 0, px: 0, py: 0, flip: false });
const RESET = { zoom: 1, rot: 0, px: 0, py: 0, flip: false };

// ----- Tải bộ khung -----
let sets = [];
const setCache = {};        // id bộ -> entries (giữ ảnh đã chọn khi đổi bộ)
let loadToken = 0;

async function init() {
  let manifest;
  try {
    const res = await fetch("frames/manifest.json?t=" + Date.now(), { cache: "no-store" });
    manifest = await res.json();
  } catch (e) {
    $("hint").textContent = "Chưa có bộ khung nào. Kiểm tra lại frames/manifest.json.";
    return;
  }
  sets = manifest.sets || [];
  if (!sets.length) { $("hint").textContent = "Chưa có bộ khung nào."; return; }
  renderSetTabs();
  await loadSet(sets[0]);
}

function renderSetTabs() {
  const box = $("sets");
  box.innerHTML = "";
  box.hidden = sets.length < 2;
  sets.forEach(s => {
    const b = document.createElement("button");
    b.className = "set-tab";
    b.dataset.id = s.id;
    b.textContent = s.name;
    b.onclick = () => { if (s !== set) loadSet(s); };
    box.appendChild(b);
  });
}

function updateSetTabs() {
  document.querySelectorAll(".set-tab").forEach(b => {
    const s = sets.find(x => x.id === b.dataset.id);
    const list = setCache[s.id];
    let label = s.name;
    if (list) {
      let f = 0, t = 0;
      list.forEach(e => e.slots.forEach(x => { t++; if (x.photo) f++; }));
      label += t && f === t ? " ✓" : ` · ${f}/${t}`;
    }
    b.textContent = label;
    b.classList.toggle("active", s === set);
  });
}

async function loadSet(s) {
  const token = ++loadToken;
  set = s;
  $("setName").textContent = s.name;
  updateSetTabs();
  if (!setCache[s.id]) {
    $("loading").hidden = false;
    try {
      setCache[s.id] = await Promise.all(s.frames.map(async meta => {
        const img = await loadImage("frames/" + meta.file);
        const FW = img.naturalWidth, FH = img.naturalHeight;
        const view = meta.view || { x: 0, y: 0, w: FW, h: FH };   // phần nhìn thấy khi ghép (bỏ lề thừa)
        return { meta, img, FW, FH, view, slots: detectSlots(img, FW, FH).map(blankSlot) };
      }));
    } catch (e) {
      $("loading").hidden = true;
      $("hint").textContent = e.message;
      return;
    }
    $("loading").hidden = true;
  }
  if (token !== loadToken) return;      // đã chuyển sang bộ khác trong lúc tải
  entries = setCache[s.id];
  cur = null;
  wasComplete = isComplete();           // không tự cuộn xuống khi chỉ đổi bộ
  renderFrameList();
  const firstOpen = entries.findIndex(e => e.slots.some(x => !x.photo));
  selectFrame(firstOpen >= 0 ? firstOpen : 0);
}

function isComplete() {
  const { filled, total } = totals();
  return total > 0 && filled === total;
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
  K = Math.min(1, PREVIEW_MAX / cur.view.w);
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
  c.clip(s.clip);
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
  const lw = Math.min(e.view.w, e.view.h) * 0.004;
  const fs = Math.min(s.w, s.h) * 0.12;
  const cx = s.cx, cy = s.cy;
  c.save();
  if (!s.photo) {
    c.fillStyle = "rgba(241,236,225,0.92)";
    c.fill(s.clip);
  }
  const col = active ? "#3D4530" : "rgba(61,69,48,0.45)";
  if (s.isRect) {
    c.lineWidth = lw;
    c.setLineDash(active ? [lw * 4, lw * 3] : []);
    c.strokeStyle = col;
    c.strokeRect(s.x, s.y, s.w, s.h);
  } else {
    c.fillStyle = col;
    const d = lw * (active ? 1.5 : 1);
    for (let k = 0; k < s.outline.length; k += 2) c.fillRect(s.outline[k] - d / 2, s.outline[k + 1] - d / 2, d, d);
  }
  if (!s.photo) {
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
    c.fillRect(cx - tw / 2, cy - t * 0.85, tw, t * 1.7);
    c.fillStyle = "#F1ECE1";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(label, cx, cy);
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
  canvas.width = Math.round(cur.view.w * K);
  canvas.height = Math.round(cur.view.h * K);
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawEntry(ctx, cur, K, -cur.view.x, -cur.view.y, true);
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
  // nút tải riêng từng khung (dưới tấm A4)
  const row = $("frameDlRow");
  row.innerHTML = "";
  if (done) {
    entries.forEach((e, i) => {
      const b = document.createElement("button");
      b.className = "btn frame-dl-btn";
      b.textContent = `Tải ${e.meta.name}`;
      b.disabled = exporting;
      b.onclick = () => downloadFrame(e);
      row.appendChild(b);
    });
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
  updateSetTabs();

  const { filled, total } = totals();
  const here = cur.slots.filter(x => x.photo).length;
  const blurry = s && s.photo && slotDpi(s) < MIN_PRINT_DPI;
  $("downloadFrame").disabled = exporting || !frameDone(cur);
  $("progress").textContent = `${filled}/${total} ảnh`;
  $("hint").textContent = filled === total
    ? "Đã đủ ảnh cho cả bộ. Xem bản in A4 bên dưới và bấm “Tải bản in A4”, hoặc tải riêng từng khung."
    : frameDone(cur)
      ? `${cur.meta.name} đã đủ ảnh. Bấm “Tải khung này” để tải riêng, hoặc ghép tiếp các khung còn lại (cả bộ: ${filled}/${total}).`
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
  return { x: cur.view.x + (e.clientX - r.left) / r.width * cur.view.w, y: cur.view.y + (e.clientY - r.top) / r.height * cur.view.h };
}

function hit(x, y) {
  let best = -1, bestArea = Infinity, fb = -1, fbArea = Infinity;
  cur.slots.forEach((s, i) => {
    if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return;
    const a = s.w * s.h;
    const m = s.hitmask;
    const mx = Math.floor(x * m.sc) - m.x0, my = Math.floor(y * m.sc) - m.y0;
    if (mx >= 0 && my >= 0 && mx < m.bw && my < m.bh && m.data[my * m.bw + mx]) {
      if (a < bestArea) { bestArea = a; best = i; }
    } else if (a < fbArea) { fbArea = a; fb = i; }   // trong khung bao nhưng trúng chữ/hoa văn phủ trên ô
  });
  return best >= 0 ? best : fb;
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
  const i = hit(cur.view.x + (st.mx - r.left) / r.width * cur.view.w, cur.view.y + (st.my - r.top) / r.height * cur.view.h);
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
    s.px += (st.mx - pinch.mx) * cur.view.w / r.width;
    s.py += (st.my - pinch.my) * cur.view.h / r.height;
    pinch.mx = st.mx; pinch.my = st.my;
    renderPreview();
    return;
  }

  if (!drag) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  const s = drag.i >= 0 ? cur.slots[drag.i] : null;
  if (drag.moved && s && s.photo) {
    const r = canvas.getBoundingClientRect();
    s.px += (e.clientX - drag.lx) * cur.view.w / r.width;
    s.py += (e.clientY - drag.ly) * cur.view.h / r.height;
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

let exporting = false;

// Chuẩn bị ảnh gốc độ phân giải cao cho các ô (mỗi lần một ảnh để nhẹ máy)
async function prepareSources(slots, label) {
  const sources = new Map();
  for (let n = 0; n < slots.length; n++) {
    $("hint").textContent = `Đang tạo ${label} chất lượng cao… (${n + 1}/${slots.length})`;
    sources.set(slots[n], await printSource(slots[n]));
  }
  return sources;
}

async function saveCanvasPng(off, filename) {
  const blob = await new Promise(res => off.toBlob(res, "image/png"));
  const file = await withDpi(blob, DPI);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function runExport(job) {
  if (exporting) return;
  exporting = true;
  document.querySelectorAll("#download, #download2, #downloadFrame, .frame-dl-btn").forEach(b => b.disabled = true);
  try {
    await job();
  } catch (err) {
    $("hint").textContent = "Không tạo được file, thử lại giúp mình nhé.";
  } finally {
    exporting = false;
    syncControls();
    updateResult();
  }
}

// Tải cả tấm A4
function downloadSheet() {
  if (!set) return;
  return runExport(async () => {
    const slots = [];
    entries.forEach(e => e.slots.forEach(s => { if (s.photo) slots.push(s); }));
    const sources = await prepareSources(slots, "bản in A4");
    const off = document.createElement("canvas");
    off.width = set.sheet.w;
    off.height = set.sheet.h;
    drawSheet(off.getContext("2d"), 1, sources);
    sources.clear();
    await saveCanvasPng(off, `TUNIA-${set.id}-A4.png`);
  });
}

// Tải riêng một khung (đúng kích thước gốc của khung, 300 dpi)
function downloadFrame(e) {
  if (!set || !e) return;
  return runExport(async () => {
    const slots = e.slots.filter(s => s.photo);
    const sources = await prepareSources(slots, "khung");
    const v = e.view;
    const off = document.createElement("canvas");
    off.width = v.w;
    off.height = v.h;
    drawEntry(off.getContext("2d"), e, 1, -v.x, -v.y, false, sources);
    sources.clear();
    await saveCanvasPng(off, `TUNIA-${set.id}-khung${entries.indexOf(e) + 1}.png`);
  });
}

const frameDone = e => e.slots.length > 0 && e.slots.every(s => s.photo);
$("download").onclick = downloadSheet;
$("download2").onclick = downloadSheet;
$("downloadFrame").onclick = () => downloadFrame(cur);

init();
