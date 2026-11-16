// PDF Studio – mobile Web-App (PWA)
// Anzeige: pdf.js · Schreiben: pdf-lib · alles lokal im Browser
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, PDFName, PDFBool,
         PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } from './vendor/pdf-lib.esm.min.js';

const VERSION = '1.0.0';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
const abs = (p) => new URL(p, location.href).href;  // absolut, sonst löst der Worker relativ zu sich auf
const DOC_OPTS = {
  cMapUrl: abs('./vendor/pdfjs/cmaps/'), cMapPacked: true,
  standardFontDataUrl: abs('./vendor/pdfjs/standard_fonts/'),
  wasmUrl: abs('./vendor/pdfjs/wasm/'), iccUrl: abs('./vendor/pdfjs/iccs/'),
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const viewer = $('#viewer'), pagesEl = $('#pages');
const PALETTE = ['#000000', '#0b57d0', '#d1242f', '#1a7f37', '#ffd400', '#ff7a00', '#ffffff'];
const TOOL_DEFAULT = {
  text: { color: '#000000', width: 0 }, check: { color: '#0b57d0', width: 2 }, cross: { color: '#0b57d0', width: 2 },
  ink: { color: '#0b57d0', width: 2 }, marker: { color: '#ffd400', width: 12 },
  rect: { color: '#d1242f', width: 2 }, ellipse: { color: '#d1242f', width: 2 },
  arrow: { color: '#d1242f', width: 2 }, line: { color: '#d1242f', width: 2 },
};
const toolOpts = JSON.parse(localStorage.getItem('toolOpts') || 'null') || structuredClone(TOOL_DEFAULT);
const MARK_COLOR = { highlight: '#ffe94d', underline: '#1a7f37', strike: '#d1242f' };

// ------------------------------------------------------------------ Zustand
let S = null;          // aktuelles Dokument
let tool = 'view';
let selId = null;      // ausgewähltes Element
let clipItem = null;   // interne Zwischenablage
let uid = 1;
let dragging = false;
const views = new Map();  // page.id -> {el, canvas, textDiv, formLayer, itemLayer, capture, ...}

/* Seite: { id, src, idx, base, rot, vb:[x0,y0,x1,y1], items:[] }  (src -1 = leere Seite)
   Elemente liegen in ungedrehten Seitenkoordinaten (Punkt, Ursprung oben links). */

// ================================================================= Hilfen
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const pageW = (p) => p.vb[2] - p.vb[0];
const pageH = (p) => p.vb[3] - p.vb[1];
const totalRot = (p) => ((p.base + p.rot) % 360 + 360) % 360;
const pageById = (id) => S.pages.find((p) => p.id === id);
const itemById = (id) => { for (const p of S.pages) { const it = p.items.find((i) => i.id === id); if (it) return [p, it]; } return [null, null]; };

function dialog({ title, html, ok = 'OK', cancel = 'Abbrechen', onOpen }) {
  const d = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html || '';
  $('#dlgOk').textContent = ok;
  $('#dlgCancel').textContent = cancel || '';
  $('#dlgCancel').hidden = !cancel;
  onOpen && onOpen($('#dlgBody'));
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}

function colorRow(container, current, onPick) {
  container.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button'; b.style.background = c; b.title = c;
    if (c.toLowerCase() === (current || '').toLowerCase()) b.classList.add('on');
    b.onclick = () => { $$('button', container).forEach((x) => x.classList.remove('on')); b.classList.add('on'); onPick(c); };
    container.appendChild(b);
  }
}

// IndexedDB (Sitzung überlebt, wenn Android die App im Hintergrund beendet)
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('pdfstudio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async get(k) { const db = await this.open(); return new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); },
  async del(k) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); },
};

// ============================================================ Laden
async function openPdfJs(bytes) {
  const task = pdfjsLib.getDocument({ ...DOC_OPTS, data: bytes.slice() });
  let tries = 0;
  task.onPassword = async (update, reason) => {
    tries++;
    let pw = '';
    const ok = await dialog({
      title: 'Passwortgeschützte PDF',
      html: `<p>${reason === 2 ? 'Falsches Passwort. ' : ''}Bitte Passwort eingeben:</p><input type="password" id="pw" autocomplete="off">`,
      onOpen: (b) => setTimeout(() => b.querySelector('#pw').focus(), 50),
    });
    pw = $('#pw')?.value || '';
    if (!ok || tries > 5) { task.destroy(); return; }
    update(pw);
  };
  const pdf = await task.promise;
  pdf._password = tries > 0;
  return pdf;
}

async function loadFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadBytes(bytes, file.name || 'Dokument.pdf');
}

async function loadBytes(bytes, name, restore = null) {
  let pdf;
  try { pdf = await openPdfJs(bytes); } catch (e) {
    toast('PDF konnte nicht geöffnet werden: ' + (e.message || e)); return;
  }
  closeDoc(true);
  S = { name, sources: [{ bytes, pdf }], pages: [], forms: {}, formsInit: {}, fields: {}, images: {},
        undo: [], redo: [], zoom: 1, fit: true, dirty: false, encrypted: !!pdf._password };
  if (restore) {
    for (let i = 1; i < restore.sources.length; i++) S.sources.push({ bytes: restore.sources[i], pdf: await openPdfJs(restore.sources[i]) });
    Object.assign(S, { pages: restore.pages, forms: restore.forms, formsInit: restore.formsInit, images: restore.images || {}, dirty: true });
    uid = Math.max(uid, ...S.pages.map((p) => p.id), ...S.pages.flatMap((p) => p.items.map((i) => i.id))) + 1;
  } else {
    S.pages = await pagesFromSource(0);
  }
  await loadFormFields();
  document.body.classList.add('hasdoc');
  $('#docTitle').textContent = name;
  $('#zoombox').hidden = false; $('#pageIndicator').hidden = false;
  $('#btnSave').disabled = false;
  buildPages();
  fitWidth();
  viewer.scrollTop = 0;
  updateUndo();
  if (!restore) persist();
  if (Object.keys(S.fields).length) toast('Dieses Dokument hat ausfüllbare Felder – einfach antippen.', 3500);
}

async function pagesFromSource(si) {
  const pdf = S.sources[si].pdf, out = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    out.push({ id: uid++, src: si, idx: i, base: pg.rotate || 0, rot: 0, vb: [...pg.view], items: [] });
  }
  return out;
}

async function loadFormFields() {
  // Formularfelder nur aus der Original-PDF (Quelle 0)
  const pdf = S.sources[0].pdf;
  S.widgets = {};
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    const anns = await pg.getAnnotations({ intent: 'display' });
    const list = [];
    for (const a of anns) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.hidden) continue;
      if (a.fieldType === 'Sig' || a.pushButton) continue;
      const f = {
        name: a.fieldName, type: a.fieldType, rect: a.rect, ro: !!a.readOnly, multi: !!a.multiLine,
        checkBox: !!a.checkBox, radio: !!a.radioButton, on: a.exportValue || a.buttonValue || 'Yes',
        options: (a.options || []).map((o) => ({ v: o.exportValue, d: o.displayValue })),
        maxLen: a.maxLen || 0, fontSize: a.defaultAppearanceData?.fontSize || 0, combo: !!a.combo,
        align: a.textAlignment || 0,
      };
      list.push(f);
      if (!(f.name in S.fields)) {
        S.fields[f.name] = f;
        let v = a.fieldValue;
        if (f.type === 'Btn') {
          v = f.checkBox ? (v && v !== 'Off') : (v && v !== 'Off' ? v : null);
        } else if (Array.isArray(v)) v = v[0] ?? '';
        else v = v ?? '';
        if (!(f.name in S.formsInit)) S.formsInit[f.name] = v;
        if (!(f.name in S.forms)) S.forms[f.name] = v;
      }
      if (f.radio && a.fieldValue === f.on && S.forms[f.name] == null) S.forms[f.name] = f.on;
    }
    S.widgets[i] = list;
  }
}

function closeDoc(silent) {
  for (const v of views.values()) v.task?.cancel?.();
  views.clear(); pagesEl.innerHTML = '';
  if (S) for (const s of S.sources) s.pdf.destroy?.();
  S = null; selId = null;
  document.body.classList.remove('hasdoc');
  $('#docTitle').textContent = 'PDF Studio';
  $('#zoombox').hidden = true; $('#pageIndicator').hidden = true; $('#btnSave').disabled = true;
  hideBars();
  if (!silent) idb.del('session');
  updateUndo();
}

// ============================================================ Layout/Rendern
function dispSize(p) {
  const r = totalRot(p), z = S.zoom;
  return r % 180 ? [pageH(p) * z, pageW(p) * z] : [pageW(p) * z, pageH(p) * z];
}

let observer;
function buildPages() {
  for (const v of views.values()) v.task?.cancel?.();
  views.clear(); pagesEl.innerHTML = '';
  observer?.disconnect();
  observer = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: '150% 0px' });
  S.pages.forEach((p, n) => {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.pid = p.id;
    el.innerHTML = '<canvas class="pdf"></canvas><div class="textLayer"></div><div class="layer formLayer"></div>' +
      '<div class="layer itemLayer"></div><div class="capture"><svg></svg></div>';
    pagesEl.appendChild(el);
    $('canvas', el).width = 0; $('canvas', el).height = 0;
    const v = { el, p, canvas: $('canvas', el), textDiv: $('.textLayer', el), formLayer: $('.formLayer', el),
                itemLayer: $('.itemLayer', el), capture: $('.capture', el), rendered: 0, visible: false };
    views.set(p.id, v);
    sizePage(v);
    observer.observe(el);
    bindCapture(v);
    bindItemLayer(v);
  });
  updateIndicator();
}

function sizePage(v) {
  const p = v.p, [w, h] = dispSize(p), z = S.zoom;
  v.el.style.width = w + 'px'; v.el.style.height = h + 'px';
  v.el.style.setProperty('--scale-factor', z);
  v.el.style.setProperty('--total-scale-factor', z);
  for (const L of [v.formLayer, v.itemLayer]) {
    L.style.width = pageW(p) * z + 'px'; L.style.height = pageH(p) * z + 'px';
    L.dataset.mainRotation = totalRot(p);
  }
  const maxW = Math.max(...S.pages.map((q) => dispSize(q)[0]));
  pagesEl.style.width = Math.max(maxW + 16, 0) + 'px';
}

function relayout() {
  for (const v of views.values()) { sizePage(v); v.rendered = 0; }
  for (const v of views.values()) if (v.visible) renderPage(v);
}

function onIntersect(entries) {
  for (const e of entries) {
    const v = views.get(+e.target.dataset.pid);
    if (!v) continue;
    v.visible = e.isIntersecting;
    if (v.visible) renderPage(v);
  }
  // Speicher sparen: weit entfernte Seiten freigeben
  const vis = [...views.values()].filter((v) => v.visible).map((v) => S.pages.indexOf(v.p));
  if (vis.length) {
    const lo = Math.min(...vis) - 3, hi = Math.max(...vis) + 3;
    for (const v of views.values()) {
      const k = S.pages.indexOf(v.p);
      if ((k < lo || k > hi) && v.rendered) { v.task?.cancel?.(); v.canvas.width = v.canvas.height = 0; v.rendered = 0; v.textDiv.innerHTML = ''; v.text = null; }
    }
  }
}

async function renderPage(v) {
  const z = S.zoom;
  if (v.rendered === z || v.busy === z) return;
  v.busy = z;
  const p = v.p;
  renderForms(v); renderItems(v);
  try {
    if (p.src < 0) {
      const c = v.canvas; c.width = 2; c.height = 2;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 2, 2);
      v.textDiv.innerHTML = '';
    } else {
      const page = await S.sources[p.src].pdf.getPage(p.idx + 1);
      if (v.busy !== z) return;
      const rot = totalRot(p);
      let scale = z * Math.min(window.devicePixelRatio || 1, 2);
      const px = pageW(p) * pageH(p) * scale * scale;
      if (px > 9e6) scale *= Math.sqrt(9e6 / px);
      const vp = page.getViewport({ scale, rotation: rot });
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
      v.task?.cancel?.();
      const mode = p.src === 0 && (S.widgets[p.idx] || []).length ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE;
      v.task = page.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: mode });
      await v.task.promise;
      if (v.busy !== z) return;
      // erst nach fertigem Rendern tauschen -> kein Flackern
      v.canvas.width = off.width; v.canvas.height = off.height;
      v.canvas.getContext('2d').drawImage(off, 0, 0);
      off.width = off.height = 0;
      // Textebene
      v.textDiv.innerHTML = '';
      const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: v.textDiv,
                                          viewport: page.getViewport({ scale: z, rotation: rot }) });
      await tl.render();
      v.text = tl;
      applyHits(v);
    }
    v.rendered = z;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
  } finally { if (v.busy === z) v.busy = 0; }
}

function rerenderPage(p) {
  const v = views.get(p.id);
  if (v) { sizePage(v); v.rendered = 0; if (v.visible) renderPage(v); }
}

// ======================================================= Koordinaten
// Bildschirm -> ungedrehte Seitenpunkte
function toPage(v, clientX, clientY) {
  const r = v.el.getBoundingClientRect(), p = v.p, z = S.zoom;
  const scaleCss = r.width / dispSize(p)[0] || 1;   // bei Pinch-Vorschau
  const x = (clientX - r.left) / scaleCss, y = (clientY - r.top) / scaleCss;
  const w = pageW(p) * z, h = pageH(p) * z;
  let u, vv;
  switch (totalRot(p)) {
    case 90: u = y; vv = h - x; break;
    case 180: u = w - x; vv = h - y; break;
    case 270: u = w - y; vv = x; break;
    default: u = x; vv = y;
  }
  return [u / z, vv / z];
}
// ungedrehte Seitenpunkte -> Bildschirm
function toScreen(v, u, vv) {
  const r = v.el.getBoundingClientRect(), p = v.p, z = S.zoom;
  const w = pageW(p) * z, h = pageH(p) * z;
  u *= z; vv *= z;
  let x, y;
  switch (totalRot(p)) {
    case 90: x = h - vv; y = u; break;
    case 180: x = w - u; y = h - vv; break;
    case 270: x = vv; y = w - u; break;
    default: x = u; y = vv;
  }
  return [r.left + x, r.top + y];
}
function rotPt(x, y, deg) { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; }

// ======================================================= Formulare
function renderForms(v) {
  const L = v.formLayer, p = v.p, z = S.zoom;
  L.innerHTML = '';
  if (p.src !== 0) return;
  for (const f of S.widgets[p.idx] || []) {
    const [x1, y1, x2, y2] = f.rect;
    const u = x1 - p.vb[0], top = p.vb[3] - y2, w = x2 - x1, h = y2 - y1;
    let el;
    const val = S.forms[f.name];
    if (f.type === 'Btn') {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'fld chk' + (f.radio ? ' radio' : '');
      const on = f.radio ? val === f.on : !!val;
      el.innerHTML = on ? (f.radio ? '<span class="dot"></span>' : '<svg viewBox="0 0 24 24"><path d="m4 12 5 5L20 6"/></svg>') : '';
      el.onclick = () => {
        if (f.ro) return;
        S.forms[f.name] = f.radio ? f.on : !S.forms[f.name];
        changedForms(f.name);
      };
    } else if (f.type === 'Ch') {
      el = document.createElement('select');
      el.className = 'fld';
      if (!f.options.some((o) => o.v === val)) el.add(new Option('', ''));
      for (const o of f.options) el.add(new Option(o.d, o.v));
      el.value = val ?? '';
      el.onchange = () => { S.forms[f.name] = el.value; changedForms(f.name, v); };
    } else {
      el = document.createElement(f.multi ? 'textarea' : 'input');
      el.className = 'fld';
      el.value = val ?? '';
      if (f.maxLen) el.maxLength = f.maxLen;
      el.style.textAlign = ['left', 'center', 'right'][f.align] || 'left';
      el.oninput = () => { S.forms[f.name] = el.value; changedForms(f.name, v, true); };
      el.onfocus = () => { el._before = el.value; };
    }
    const fs = f.fontSize || (f.multi ? 10 : Math.min(h * 0.68, 12));
    if (f.type !== 'Btn') el.style.fontSize = Math.max(fs * z, 6) + 'px';
    if (f.ro) { el.disabled = true; el.classList.add('ro'); }
    Object.assign(el.style, { left: u * z + 'px', top: top * z + 'px', width: w * z + 'px', height: h * z + 'px' });
    el.dataset.field = f.name;
    L.appendChild(el);
  }
}

function changedForms(name, srcView, typing) {
  S.dirty = true;
  // gleiche Felder auf anderen Seiten / Optionsgruppen aktualisieren
  for (const v of views.values()) {
    if (v.p.src !== 0) continue;
    if (typing && v === srcView) {
      $$(`[data-field="${CSS.escape(name)}"]`, v.formLayer).forEach((el) => { if (el !== document.activeElement) el.value = S.forms[name]; });
      continue;
    }
    if ((S.widgets[v.p.idx] || []).some((f) => f.name === name)) renderForms(v);
  }
  persistSoon();
}

// ======================================================= Elemente zeichnen
const SVGNS = 'http://www.w3.org/2000/svg';
const measureCtx = document.createElement('canvas').getContext('2d');
function textSize(it) {
  measureCtx.font = `${it.size}px Helvetica, Arial, Roboto, sans-serif`;
  const lines = it.text.split('\n');
  return [Math.max(...lines.map((l) => measureCtx.measureText(l).width), it.size * 0.5) + 2, lines.length * it.size * 1.2];
}

function bbox(it) {
  switch (it.t) {
    case 'text': case 'image': {
      const [w, h] = it.t === 'text' ? textSize(it) : [it.w, it.h];
      const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => rotPt(x, y, it.rot || 0));
      const xs = pts.map((q) => q[0] + it.u), ys = pts.map((q) => q[1] + it.v);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    }
    case 'line': case 'arrow': case 'ink': case 'marker': case 'check': case 'cross': {
      const pts = it.t === 'line' || it.t === 'arrow' ? it.pts : it.strokes.flat();
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]), pad = (it.width || 2) / 2;
      return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
    }
    case 'highlight': case 'underline': case 'strike': {
      const xs = it.rects.flatMap((r) => [r[0], r[0] + r[2]]), ys = it.rects.flatMap((r) => [r[1], r[1] + r[3]]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    }
    default: return [it.u, it.v, it.w, it.h];
  }
}

function translateItem(it, du, dv) {
  if ('u' in it) { it.u += du; it.v += dv; }
  if (it.pts) it.pts = it.pts.map(([a, b]) => [a + du, b + dv]);
  if (it.strokes) it.strokes = it.strokes.map((s) => s.map(([a, b]) => [a + du, b + dv]));
  if (it.rects) it.rects = it.rects.map(([a, b, c, d]) => [a + du, b + dv, c, d]);
}

function scaleItem(it, sx, sy, ox, oy) {
  const f = ([a, b]) => [ox + (a - ox) * sx, oy + (b - oy) * sy];
  if (it.t === 'text') { const s = (sx + sy) / 2; it.size = Math.max(4, it.size * s); [it.u, it.v] = f([it.u, it.v]); return; }
  if ('u' in it) { [it.u, it.v] = f([it.u, it.v]); it.w *= sx; it.h *= sy; }
  if (it.pts) it.pts = it.pts.map(f);
  if (it.strokes) it.strokes = it.strokes.map((s) => s.map(f));
  if (it.rects) it.rects = it.rects.map(([a, b, c, d]) => { const [x, y] = f([a, b]); return [x, y, c * sx, d * sy]; });
}

function pathD(stroke) {
  if (!stroke.length) return '';
  if (stroke.length === 1) { const [x, y] = stroke[0]; return `M${x} ${y}L${x + 0.01} ${y}`; }
  return 'M' + stroke.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L');
}
function arrowHead(it) {
  const [[x1, y1], [x2, y2]] = it.pts, a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(8, it.width * 4);
  return [[x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], [x2, y2], [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)]];
}

function svgFor(it) {
  const g = document.createElementNS(SVGNS, 'g');
  g.dataset.id = it.id;
  const add = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); g.appendChild(e); return e; };
  const st = { fill: 'none', stroke: it.color, 'stroke-width': it.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const hitW = Math.max(14 / S.zoom, (it.width || 2) + 8 / S.zoom);
  switch (it.t) {
    case 'rect': add('rect', { x: it.u, y: it.v, width: it.w, height: it.h, ...st }); add('rect', { x: it.u, y: it.v, width: it.w, height: it.h, class: 'hitbox', 'stroke-width': hitW }); break;
    case 'ellipse': { const e = { cx: it.u + it.w / 2, cy: it.v + it.h / 2, rx: it.w / 2, ry: it.h / 2 }; add('ellipse', { ...e, ...st }); add('ellipse', { ...e, class: 'hitbox', 'stroke-width': hitW }); break; }
    case 'whiteout': case 'redact':
      add('rect', { x: it.u, y: it.v, width: it.w, height: it.h, fill: it.t === 'redact' ? '#000' : '#fff', style: 'pointer-events:fill' });
      if (it.t === 'whiteout') add('rect', { x: it.u, y: it.v, width: it.w, height: it.h, fill: 'none', stroke: '#bbb', 'stroke-width': 0.6 / S.zoom, 'stroke-dasharray': `${3 / S.zoom} ${3 / S.zoom}`, class: 'guide' });
      break;
    case 'line': case 'arrow': {
      const d = pathD(it.pts) + (it.t === 'arrow' ? pathD(arrowHead(it)) : '');
      add('path', { d, ...st }); add('path', { d, class: 'hitbox', 'stroke-width': hitW }); break;
    }
    case 'ink': case 'marker': case 'check': case 'cross': {
      const d = it.strokes.map(pathD).join('');
      const p = add('path', { d, ...st });
      if (it.t === 'marker') { p.setAttribute('stroke-opacity', 0.45); p.style.mixBlendMode = 'multiply'; p.setAttribute('stroke-linecap', 'butt'); }
      add('path', { d, class: 'hitbox', 'stroke-width': hitW }); break;
    }
    case 'highlight':
      for (const [x, y, w, h] of it.rects) add('rect', { x, y, width: w, height: h, fill: it.color, style: 'mix-blend-mode:multiply;pointer-events:fill', 'fill-opacity': 0.75 });
      break;
    case 'underline': case 'strike':
      for (const [x, y, w, h] of it.rects) {
        const yy = it.t === 'underline' ? y + h * 0.95 : y + h * 0.55;
        add('path', { d: `M${x} ${yy}L${x + w} ${yy}`, stroke: it.color, 'stroke-width': Math.max(0.8, h * 0.07) });
        add('rect', { x, y, width: w, height: h, fill: 'transparent', style: 'pointer-events:fill' });
      }
      break;
  }
  return g;
}

function renderItems(v) {
  const L = v.itemLayer, p = v.p, z = S.zoom;
  L.innerHTML = '';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'draw');
  svg.setAttribute('viewBox', `0 0 ${pageW(p)} ${pageH(p)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  L.appendChild(svg);
  for (const it of p.items) {
    if (it.t === 'text') {
      const d = document.createElement('div');
      d.className = 'it text'; d.dataset.id = it.id;
      d.textContent = it.text;
      Object.assign(d.style, { left: it.u * z + 'px', top: it.v * z + 'px', fontSize: it.size * z + 'px', color: it.color,
                               transform: `rotate(${it.rot || 0}deg)` });
      L.appendChild(d);
    } else if (it.t === 'image') {
      const d = document.createElement('div');
      d.className = 'it img'; d.dataset.id = it.id;
      d.innerHTML = `<img src="${S.images[it.img]}" alt="">`;
      Object.assign(d.style, { left: it.u * z + 'px', top: it.v * z + 'px', width: it.w * z + 'px', height: it.h * z + 'px',
                               transform: `rotate(${it.rot || 0}deg)` });
      L.appendChild(d);
    } else {
      svg.appendChild(svgFor(it));
    }
  }
  const pv = document.createElementNS(SVGNS, 'g'); pv.setAttribute('class', 'preview'); svg.appendChild(pv);
  v.preview = pv;
  // Auswahlrahmen
  const it = p.items.find((i) => i.id === selId);
  if (it) {
    const [x, y, w, h] = bbox(it);
    const b = document.createElement('div');
    b.className = 'it selbox sel'; b.dataset.id = it.id;
    Object.assign(b.style, { left: x * z + 'px', top: y * z + 'px', width: Math.max(w * z, 8) + 'px', height: Math.max(h * z, 8) + 'px' });
    b.innerHTML = '<div class="handle"></div>';
    L.appendChild(b);
    requestAnimationFrame(() => placeItemBar(v, it));
  }
}

function refreshItems(p) { const v = views.get(p.id); if (v) renderItems(v); }

// ======================================================= Undo / Sitzung
function snapshot() { return JSON.stringify({ pages: S.pages, forms: S.forms }); }
function pushUndo() {
  S.undo.push(snapshot()); if (S.undo.length > 60) S.undo.shift();
  S.redo = []; S.dirty = true; updateUndo(); persistSoon();
}
function restoreSnap(js) {
  const o = JSON.parse(js);
  const structural = o.pages.length !== S.pages.length || o.pages.some((p, i) => p.id !== S.pages[i].id || p.rot !== S.pages[i].rot);
  S.pages = o.pages; S.forms = o.forms; selId = null; hideBars();
  if (structural) { buildPages(); for (const v of views.values()) if (v.visible) renderPage(v); }
  else for (const v of views.values()) { v.p = pageById(v.p.id); renderItems(v); renderForms(v); }
}
function undo() { if (!S?.undo.length) return; S.redo.push(snapshot()); restoreSnap(S.undo.pop()); updateUndo(); persistSoon(); }
function redo() { if (!S?.redo.length) return; S.undo.push(snapshot()); restoreSnap(S.redo.pop()); updateUndo(); persistSoon(); }
function updateUndo() { $('#btnUndo').disabled = !S?.undo.length; $('#btnRedo').disabled = !S?.redo.length; }

let persistTimer;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 1200); }
async function persist() {
  if (!S) return;
  try {
    await idb.set('session', { name: S.name, sources: S.sources.map((s) => s.bytes), pages: S.pages, forms: S.forms,
                               formsInit: S.formsInit, images: S.images, time: Date.now() });
  } catch (e) { console.warn('persist', e); }
}

// ======================================================= Werkzeuge
function setTool(t) {
  if (t === 'image') { $('#imageInput').click(); return; }
  if (t === 'sign') { signature(); return; }
  tool = t;
  document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim() + ' tool-' + t;
  $$('#toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  select(null);
  if (t === 'view') $('#toast').hidden = true;
  const o = toolOpts[t];
  const showOpts = !!o && t !== 'view';
  $('#toolopts').hidden = !showOpts;
  document.body.classList.toggle('opts', showOpts);
  if (showOpts) {
    colorRow($('#colorRow'), o.color, (c) => { o.color = c; saveToolOpts(); });
    $('#widthRange').parentElement.style.display = t === 'text' ? 'none' : '';
    $('#widthRange').value = o.width;
    $('#widthRange').max = t === 'marker' ? 30 : 12;
  }
  const hints = { text: 'Auf die Stelle tippen, an der Text stehen soll', check: 'Tippen setzt einen Haken', cross: 'Tippen setzt ein Kreuz',
                  ink: 'Mit dem Finger oder Stift zeichnen', marker: 'Über den Text streichen', rect: 'Rahmen aufziehen', ellipse: 'Rahmen aufziehen',
                  arrow: 'Von Anfang bis Spitze ziehen', line: 'Linie ziehen', whiteout: 'Bereich aufziehen – wird weiß überdeckt',
                  redact: 'Bereich aufziehen – Inhalt wird beim Speichern endgültig entfernt' };
  if (hints[t]) toast(hints[t] + ' · Zwei Finger: scrollen/zoomen');
}
function saveToolOpts() { localStorage.setItem('toolOpts', JSON.stringify(toolOpts)); }
$('#widthRange').oninput = (e) => { if (toolOpts[tool]) { toolOpts[tool].width = +e.target.value; saveToolOpts(); } };

function addItem(p, it, selectIt = false) {
  pushUndo();
  it.id = uid++;
  p.items.push(it);
  if (selectIt) selId = it.id;
  refreshItems(p);
  return it;
}

function bindCapture(v) {
  const cap = v.capture;
  let st = null;
  cap.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (!e.isPrimary) { cancel(); return; }
    e.preventDefault();
    const [u, vv] = toPage(v, e.clientX, e.clientY);
    const p = v.p;
    if (tool === 'text') { addTextAt(v, u, vv); return; }
    if (tool === 'check' || tool === 'cross') { addMark(v, e.clientX, e.clientY); return; }
    cap.setPointerCapture(e.pointerId);
    st = { start: [u, vv], cur: [u, vv], pts: [[u, vv]], pid: e.pointerId };
    drawPreview();
  });
  cap.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const pt = toPage(v, e.clientX, e.clientY);
    st.cur = pt;
    if (tool === 'ink' || tool === 'marker') {
      // auch zwischengespeicherte Punkte (Stift) nutzen
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of evs) st.pts.push(toPage(v, ce.clientX, ce.clientY));
    }
    drawPreview();
  });
  const finish = (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const s = st; st = null; v.preview.innerHTML = '';
    const p = v.p, [x0, y0] = s.start, [x1, y1] = s.cur;
    const o = toolOpts[tool] || {};
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), u = Math.min(x0, x1), vv = Math.min(y0, y1);
    if (['rect', 'ellipse', 'whiteout', 'redact'].includes(tool)) {
      if (w < 3 && h < 3) return;
      addItem(p, { t: tool, u, v: vv, w, h, color: o.color, width: o.width });
    } else if (tool === 'line' || tool === 'arrow') {
      if (w < 3 && h < 3) return;
      addItem(p, { t: tool, pts: [s.start, s.cur], color: o.color, width: o.width });
    } else if (tool === 'ink' || tool === 'marker') {
      if (s.pts.length < 2) s.pts.push([s.pts[0][0] + 0.3, s.pts[0][1]]);
      addItem(p, { t: tool, strokes: [simplify(s.pts, 0.35)], color: o.color, width: o.width });
    }
  };
  const cancel = () => { if (st) { st = null; v.preview.innerHTML = ''; } };
  cap.addEventListener('pointerup', finish);
  cap.addEventListener('pointercancel', cancel);
  v.cancelDraw = cancel;

  function drawPreview() {
    const g = v.preview; if (!g) return;
    const o = toolOpts[tool] || { color: '#000', width: 1 };
    const [x0, y0] = st.start, [x1, y1] = st.cur;
    const u = Math.min(x0, x1), vv = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    let it;
    if (['rect', 'ellipse', 'whiteout', 'redact'].includes(tool)) it = { t: tool, u, v: vv, w, h, color: o.color, width: o.width };
    else if (tool === 'line' || tool === 'arrow') it = { t: tool, pts: [st.start, st.cur], color: o.color, width: o.width };
    else it = { t: tool, strokes: [st.pts], color: o.color, width: o.width };
    g.innerHTML = ''; const el = svgFor(it);
    if (tool === 'redact') el.setAttribute('opacity', 0.6);
    g.appendChild(el);
  }
}

function simplify(pts, tol) {
  // Punkte ausdünnen (Radial-Distanz)
  const out = [pts[0]];
  for (const q of pts.slice(1)) { const l = out[out.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= tol) out.push(q); }
  if (out.length === 1 && pts.length > 1) out.push(pts[pts.length - 1]);
  return out.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
}

// Haken/Kreuz: in Bildschirmausrichtung aufrecht
function addMark(v, cx, cy) {
  const o = toolOpts[tool], s = 7 * S.zoom; // halbe Größe in px
  const shape = tool === 'check'
    ? [[[-s, 0], [-s * 0.3, s * 0.75], [s, -s * 0.8]]]
    : [[[-s * 0.8, -s * 0.8], [s * 0.8, s * 0.8]], [[s * 0.8, -s * 0.8], [-s * 0.8, s * 0.8]]];
  const strokes = shape.map((st) => st.map(([dx, dy]) => toPage(v, cx + dx, cy + dy)));
  addItem(v.p, { t: tool, strokes, color: o.color, width: o.width });
}

function uprightRot(p) { return (360 - totalRot(p)) % 360; }

async function textDialog(title, it) {
  let color = it.color;
  const ok = await dialog({
    title,
    html: `<textarea id="tx" placeholder="Text eingeben …">${esc(it.text || '')}</textarea>
      <div class="row"><label>Größe</label><input type="number" id="tsz" min="4" max="96" step="1" value="${Math.round(it.size)}"><div class="colors" id="tcol"></div></div>`,
    onOpen: (b) => { colorRow($('#tcol', b), color, (c) => (color = c)); setTimeout(() => $('#tx', b).focus(), 60); },
  });
  if (!ok) return null;
  const text = $('#tx').value.replace(/\s+$/, '');
  if (!text) return null;
  return { text, size: Math.min(96, Math.max(4, +$('#tsz').value || 12)), color };
}

async function addTextAt(v, u, vv) {
  const o = toolOpts.text;
  const r = await textDialog('Text hinzufügen', { text: '', size: o.size || 12, color: o.color });
  if (!r) return;
  o.size = r.size; o.color = r.color; saveToolOpts();
  const it = addItem(v.p, { t: 'text', u, v: vv, text: r.text, size: r.size, color: r.color, rot: uprightRot(v.p) });
  setTool('view'); select(it.id);
}

// Bild / Unterschrift im sichtbaren Bereich platzieren
function currentView() {
  const vr = viewer.getBoundingClientRect(), cy = vr.top + vr.height / 2;
  let best = null, bd = Infinity;
  for (const v of views.values()) {
    const r = v.el.getBoundingClientRect();
    const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
function placeImage(dataUrl, natW, natH, widthFrac = 0.45) {
  const v = currentView(); if (!v) return;
  const p = v.p;
  const imgId = 'i' + uid++;
  S.images[imgId] = dataUrl;
  const r = totalRot(p);
  const dispW = r % 180 ? pageH(p) : pageW(p);
  const w = dispW * widthFrac, h = (w * natH) / natW;
  // Mitte des sichtbaren Bereichs
  const vr = viewer.getBoundingClientRect(), er = v.el.getBoundingClientRect();
  const cx = Math.min(Math.max(vr.left + vr.width / 2, er.left + 20), er.right - 20);
  const cy = Math.min(Math.max(vr.top + vr.height / 2, er.top + 20), er.bottom - 20);
  const [cu, cv] = toPage(v, cx, cy);
  const rot = uprightRot(p);
  const [ox, oy] = rotPt(-w / 2, -h / 2, rot);
  const it = addItem(p, { t: 'image', img: imgId, u: cu + ox, v: cv + oy, w, h, rot });
  setTool('view'); select(it.id);
  toast('Zum Verschieben ziehen, blauer Punkt ändert die Größe');
}
function readImageFile(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        // große Fotos verkleinern und als JPEG/PNG normalisieren
        const max = 2000, s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
        const png = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
        res({ url: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), w: c.width, h: c.height });
      };
      img.onerror = rej; img.src = fr.result;
    };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
}
$('#imageInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !S) return;
  try { const r = await readImageFile(f); placeImage(r.url, r.w, r.h); } catch { toast('Bild konnte nicht geladen werden'); }
};

// ======================================================= Unterschrift
async function signature() {
  if (!S) return;
  const saved = JSON.parse(localStorage.getItem('signatures') || '[]');
  let pad, strokes = [], picked = null;
  const ok = await dialog({
    title: 'Unterschrift',
    ok: 'Platzieren',
    html: `${saved.length ? '<p>Gespeicherte Unterschrift antippen oder neu unterschreiben:</p><div class="saved-sigs" id="ss"></div>' : ''}
      <canvas class="sigpad" id="pad"></canvas>
      <div class="sigtools"><button type="button" id="padClear">Löschen</button>
      <label class="wlabel"><input type="checkbox" id="padSave" checked> Für später merken</label></div>`,
    onOpen: (b) => {
      const ss = $('#ss', b);
      saved.forEach((url, k) => {
        const btn = document.createElement('button'); btn.type = 'button';
        btn.innerHTML = `<img src="${url}" alt="Unterschrift ${k + 1}">`;
        btn.onclick = () => { picked = url; $('#dlg').close('ok'); };
        btn.oncontextmenu = (ev) => { ev.preventDefault(); if (confirm('Diese gespeicherte Unterschrift löschen?')) { saved.splice(k, 1); localStorage.setItem('signatures', JSON.stringify(saved)); btn.remove(); } };
        ss.appendChild(btn);
      });
      pad = $('#pad', b);
      requestAnimationFrame(() => {
        const r = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        pad.width = r.width * dpr; pad.height = r.height * dpr;
        const ctx = pad.getContext('2d'); ctx.scale(dpr, dpr);
        const redraw = () => {
          ctx.clearRect(0, 0, r.width, r.height);
          ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(16, r.height - 36); ctx.lineTo(r.width - 16, r.height - 36); ctx.stroke();
          ctx.strokeStyle = '#10206b'; ctx.lineWidth = 2.6; ctx.lineCap = ctx.lineJoin = 'round';
          for (const s of strokes) { ctx.beginPath(); s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]); ctx.stroke(); }
        };
        redraw();
        let cur = null;
        pad.onpointerdown = (e) => { pad.setPointerCapture(e.pointerId); cur = [[e.offsetX, e.offsetY]]; strokes.push(cur); redraw(); };
        pad.onpointermove = (e) => { if (!cur) return; for (const ce of e.getCoalescedEvents?.() || [e]) cur.push([ce.offsetX, ce.offsetY]); redraw(); };
        pad.onpointerup = pad.onpointercancel = () => (cur = null);
        $('#padClear', b).onclick = () => { strokes = []; redraw(); };
      });
    },
  });
  if (!ok) return;
  let url = picked;
  if (!url) {
    const pts = strokes.flat();
    if (!pts.length) return;
    const pad2 = 6, x0 = Math.min(...pts.map((q) => q[0])) - pad2, y0 = Math.min(...pts.map((q) => q[1])) - pad2;
    const x1 = Math.max(...pts.map((q) => q[0])) + pad2, y1 = Math.max(...pts.map((q) => q[1])) + pad2;
    const k = 3, c = document.createElement('canvas'); c.width = (x1 - x0) * k; c.height = (y1 - y0) * k;
    const ctx = c.getContext('2d'); ctx.scale(k, k); ctx.translate(-x0, -y0);
    ctx.strokeStyle = '#10206b'; ctx.lineWidth = 2.6; ctx.lineCap = ctx.lineJoin = 'round';
    for (const s of strokes) { ctx.beginPath(); s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]); ctx.stroke(); }
    url = c.toDataURL('image/png');
    if ($('#padSave').checked) { saved.unshift(url); localStorage.setItem('signatures', JSON.stringify(saved.slice(0, 3))); }
  }
  const img = new Image();
  img.onload = () => placeImage(url, img.width, img.height, 0.32);
  img.src = url;
}

// ======================================================= Auswählen / Verschieben
function select(id) {
  const old = selId; selId = id;
  for (const p of S?.pages || []) if (p.items.some((i) => i.id === old || i.id === id)) refreshItems(p);
  if (!id) $('#itembar').hidden = true;
}

function bindItemLayer(v) {
  const L = v.itemLayer;
  L.addEventListener('pointerdown', (e) => {
    if (tool !== 'view') return;
    const t = e.target.closest('[data-id]');
    if (!t) return;
    const id = +t.dataset.id;
    const [p, it] = itemById(id);
    if (!it) return;
    e.preventDefault(); e.stopPropagation();
    const resize = e.target.classList.contains('handle');
    if (selId !== id) select(id);
    hideSelBar();
    const start = toPage(v, e.clientX, e.clientY);
    const orig = clone(it), bb = bbox(orig);
    let moved = false;
    const pid = e.pointerId;
    $('#itembar').hidden = true;
    dragging = true;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const [u, vv] = toPage(v, ev.clientX, ev.clientY);
      const du = u - start[0], dv = vv - start[1];
      if (!moved && Math.hypot(du, dv) * S.zoom < 4) return;
      if (!moved) { moved = true; pushUndo(); }
      const cur = itemById(id)[1];
      Object.keys(cur).forEach((k) => delete cur[k]); Object.assign(cur, clone(orig));
      if (resize) {
        let sx = Math.max(0.05, (bb[2] + du) / Math.max(bb[2], 1)), sy = Math.max(0.05, (bb[3] + dv) / Math.max(bb[3], 1));
        if (['text', 'image', 'check', 'cross', 'ink', 'marker'].includes(cur.t)) sx = sy = (sx + sy) / 2;
        scaleItem(cur, sx, sy, bb[0], bb[1]);
      } else translateItem(cur, du, dv);
      renderItems(v);
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = false;
      renderItems(v);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  L.addEventListener('dblclick', (e) => { const t = e.target.closest('[data-id]'); if (t && tool === 'view') editItem(+t.dataset.id); });
}

function placeItemBar(v, it) {
  if (selId !== it.id || dragging) return;
  const bar = $('#itembar');
  bar.hidden = false;
  $('#itEdit').hidden = it.t !== 'text';
  $('#itColor').hidden = ['image', 'whiteout', 'redact'].includes(it.t);
  const [x, y, w, h] = bbox(it);
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([a, b]) => toScreen(v, a, b));
  const top = Math.min(...pts.map((q) => q[1])), bottom = Math.max(...pts.map((q) => q[1]));
  const cx = (Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[0]))) / 2;
  const br = bar.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
  let ty = top - br.height - 12;
  if (ty < vr.top + 4) ty = bottom + 18;
  if (ty + br.height > vr.bottom - 4) ty = vr.top + 8;
  bar.style.top = ty + 'px';
  bar.style.left = Math.min(Math.max(8, cx - br.width / 2), window.innerWidth - br.width - 8) + 'px';
}

async function editItem(id) {
  const [p, it] = itemById(id); if (!it) return;
  if (it.t === 'text') {
    const r = await textDialog('Text bearbeiten', it);
    if (!r) return;
    pushUndo(); Object.assign(it, r); refreshItems(p);
  } else if (!['image', 'whiteout', 'redact'].includes(it.t)) colorItem(id);
}
async function colorItem(id) {
  const [p, it] = itemById(id); if (!it) return;
  let color = it.color, width = it.width;
  const hasW = !['text', 'highlight', 'underline', 'strike'].includes(it.t);
  const ok = await dialog({
    title: 'Farbe', html: `<div class="colors" id="cc"></div>${hasW ? `<div class="row"><label>Stärke</label><input type="range" id="cw" min="0.5" max="${it.t === 'marker' ? 30 : 12}" step="0.5" value="${width}"></div>` : ''}`,
    onOpen: (b) => colorRow($('#cc', b), color, (c) => (color = c)),
  });
  if (!ok) return;
  pushUndo(); it.color = color; if (hasW) it.width = +$('#cw').value; refreshItems(p);
}
function deleteItem(id) {
  const [p, it] = itemById(id); if (!it) return;
  pushUndo(); p.items = p.items.filter((i) => i !== it); selId = null; $('#itembar').hidden = true; refreshItems(p);
}
function duplicateItem(id, page = null, offset = 12) {
  const [p, it] = itemById(id); if (!it) return;
  const c = clone(it); translateItem(c, offset, offset);
  delete c.id; addItem(page || p, c, true); refreshItems(page || p);
}
$('#itEdit').onclick = () => editItem(selId);
$('#itColor').onclick = () => colorItem(selId);
$('#itDel').onclick = () => deleteItem(selId);
$('#itDup').onclick = () => duplicateItem(selId);
$('#itCopy').onclick = () => {
  const [, it] = itemById(selId); if (!it) return;
  clipItem = { item: clone(it), image: it.img ? S.images[it.img] : null, at: Date.now() };
  if (it.t === 'text') navigator.clipboard?.writeText(it.text).catch(() => {});
  toast('Kopiert – über Menü → Einfügen auf jeder Seite einfügen');
};

// Tippen ins Leere hebt die Auswahl auf
viewer.addEventListener('pointerdown', (e) => {
  if (!S || tool !== 'view') return;
  if (!e.target.closest('[data-id]') && !e.target.closest('#itembar') && selId) select(null);
});

// ======================================================= Text markieren
function hideSelBar() { $('#selbar').hidden = true; }
function hideBars() { hideSelBar(); $('#itembar').hidden = true; }
let selTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const sel = document.getSelection();
    if (!S || !sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) { hideSelBar(); return; }
    const r = sel.getRangeAt(0);
    const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    if (!node?.closest('#pages')) { hideSelBar(); return; }
    const rects = [...r.getClientRects()].filter((q) => q.width > 0.5);
    if (!rects.length) return;
    const bar = $('#selbar'); bar.hidden = false;
    const br = bar.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
    const top = Math.min(...rects.map((q) => q.top)), bottom = Math.max(...rects.map((q) => q.bottom));
    const cx = (Math.min(...rects.map((q) => q.left)) + Math.max(...rects.map((q) => q.right))) / 2;
    // Android zeigt eigenes Menü oberhalb – unsere Leiste unterhalb der Auswahl
    let ty = bottom + 26;
    if (ty + br.height > vr.bottom - 4) ty = Math.max(vr.top + 4, top - br.height - 60);
    bar.style.top = ty + 'px';
    bar.style.left = Math.min(Math.max(8, cx - br.width / 2), window.innerWidth - br.width - 8) + 'px';
  }, 120);
});

function markSelection(kind) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return;
  let rects = [...sel.getRangeAt(0).getClientRects()].filter((q) => q.width > 0.5 && q.height > 0.5);
  const hs = rects.map((q) => q.height).sort((a, b) => a - b), med = hs[Math.floor(hs.length / 2)] || 0;
  rects = rects.filter((q) => q.height <= med * 2.5);
  const byPage = new Map();
  for (const q of rects) {
    const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
    for (const v of views.values()) {
      const pr = v.el.getBoundingClientRect();
      if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
        const a = toPage(v, q.left, q.top), b = toPage(v, q.right, q.bottom);
        const r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
        if (!byPage.has(v)) byPage.set(v, []);
        byPage.get(v).push(r);
        break;
      }
    }
  }
  if (!byPage.size) return;
  pushUndo();
  for (const [v, rs] of byPage) {
    const merged = mergeRects(rs);
    const it = { t: kind, rects: merged.map((r) => r.map((n) => Math.round(n * 100) / 100)), color: MARK_COLOR[kind], id: uid++ };
    v.p.items.push(it); refreshItems(v.p);
  }
  sel.removeAllRanges(); hideSelBar();
}
function mergeRects(rs) {
  // Rechtecke derselben Zeile zusammenfassen, Überlappungen entfernen
  rs = rs.filter((r) => r[2] > 0.3 && r[3] > 0.3).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of rs) {
    const L = lines.find((l) => Math.abs((l[1] + l[3] / 2) - (r[1] + r[3] / 2)) < Math.min(l[3], r[3]) * 0.5 && r[0] <= l[0] + l[2] + r[3]);
    if (L) { const x0 = Math.min(L[0], r[0]), y0 = Math.min(L[1], r[1]), x1 = Math.max(L[0] + L[2], r[0] + r[2]), y1 = Math.max(L[1] + L[3], r[1] + r[3]); L.splice(0, 4, x0, y0, x1 - x0, y1 - y0); }
    else lines.push([...r]);
  }
  // Rechtecke, die vollständig in anderen liegen (Container-Spans), entfernen
  return lines.filter((a, i) => !lines.some((b, j) => j !== i && b[2] * b[3] > a[2] * a[3] && a[0] >= b[0] - 0.5 && a[1] >= b[1] - 0.5 && a[0] + a[2] <= b[0] + b[2] + 0.5 && a[1] + a[3] <= b[1] + b[3] + 0.5));
}
$$('#selbar [data-mark]').forEach((b) => b.addEventListener('click', () => markSelection(b.dataset.mark)));
$('#selCopy').onclick = async () => {
  const t = document.getSelection().toString();
  try { await navigator.clipboard.writeText(t); } catch { document.execCommand('copy'); }
  toast('Text kopiert'); document.getSelection().removeAllRanges(); hideSelBar();
};
// Leisten beim Mausklick nicht die Auswahl verlieren lassen
$$('#selbar button, #itembar button').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));

// ======================================================= Zoom (Buttons, Pinch, Strg+Rad)
function setZoom(z, cx, cy) {
  if (!S) return;
  z = Math.min(6, Math.max(0.2, z));
  const vr = viewer.getBoundingClientRect();
  cx ??= vr.left + vr.width / 2; cy ??= vr.top + vr.height / 2;
  const pr = pagesEl.getBoundingClientRect();
  const px = (cx - pr.left) / S.zoom, py = (cy - pr.top) / S.zoom;
  S.zoom = z;
  relayout();
  const pr2 = pagesEl.getBoundingClientRect();
  viewer.scrollLeft += pr2.left + px * z - cx;
  viewer.scrollTop += pr2.top + py * z - cy;
  $('#zoomFit').textContent = Math.round((z / fitZoom()) * 100) + '%';
  hideBars(); if (selId) select(selId);
}
function fitZoom() {
  if (!S?.pages.length) return 1;
  const v = currentView(); const p = v ? v.p : S.pages[0];
  const r = totalRot(p), w = r % 180 ? pageH(p) : pageW(p);
  return (viewer.clientWidth - 16) / w;
}
function fitWidth() { if (!S) return; S.fit = true; const cur = currentView(); S.zoom = fitZoom(); relayout(); cur && cur.el.scrollIntoView({ block: 'start' }); $('#zoomFit').textContent = '100%'; }
$('#zoomIn').onclick = () => { S.fit = false; setZoom(S.zoom * 1.25); };
$('#zoomOut').onclick = () => { S.fit = false; setZoom(S.zoom / 1.25); };
$('#zoomFit').onclick = fitWidth;
viewer.addEventListener('wheel', (e) => {
  if (!S || !e.ctrlKey) return;
  e.preventDefault(); S.fit = false;
  setZoom(S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
}, { passive: false });

let pinch = null;
viewer.addEventListener('touchstart', (e) => {
  if (!S || e.touches.length !== 2) return;
  for (const v of views.values()) v.cancelDraw?.();
  const [a, b] = e.touches;
  const pr = pagesEl.getBoundingClientRect();
  const c = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), c0: c, c, s: 1, origin: [c[0] - pr.left, c[1] - pr.top] };
  pagesEl.style.transformOrigin = `${pinch.origin[0]}px ${pinch.origin[1]}px`;
}, { passive: true });
viewer.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  pinch.s = Math.min(6 / S.zoom, Math.max(0.2 / S.zoom, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0));
  pinch.c = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  pagesEl.style.transform = `translate(${pinch.c[0] - pinch.c0[0]}px, ${pinch.c[1] - pinch.c0[1]}px) scale(${pinch.s})`;
}, { passive: false });
const endPinch = (e) => {
  if (!pinch || e.touches.length >= 2) return;
  const P = pinch; pinch = null;
  pagesEl.style.transform = ''; pagesEl.style.transformOrigin = '';
  const z = Math.min(6, Math.max(0.2, S.zoom * P.s));
  if (Math.abs(P.s - 1) > 0.02) S.fit = false;
  S.zoom = z; relayout();
  const pr = pagesEl.getBoundingClientRect();
  viewer.scrollLeft += pr.left + P.origin[0] * P.s - P.c[0];
  viewer.scrollTop += pr.top + P.origin[1] * P.s - P.c[1];
  $('#zoomFit').textContent = Math.round((z / fitZoom()) * 100) + '%';
  hideBars(); if (selId) select(selId);
};
viewer.addEventListener('touchend', endPinch);
viewer.addEventListener('touchcancel', endPinch);

let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S?.fit) fitWidth(); }, 200); });

function updateIndicator() {
  if (!S) return;
  const v = currentView();
  if (v) $('#pageIndicator').textContent = `${S.pages.indexOf(v.p) + 1} / ${S.pages.length}`;
}
viewer.addEventListener('scroll', () => {
  updateIndicator();
  if (!$('#itembar').hidden && selId) { const [p, it] = itemById(selId); const v = p && views.get(p.id); if (v) placeItemBar(v, it); }
}, { passive: true });

// ======================================================= Suche
let hits = [], hitIdx = -1;
const textCache = new Map();
async function pageText(p) {
  const key = p.src + ':' + p.idx;
  if (!textCache.has(key)) {
    const pg = await S.sources[p.src].pdf.getPage(p.idx + 1);
    textCache.set(key, (await pg.getTextContent()).items.map((i) => i.str || ''));
  }
  return textCache.get(key);
}
async function runSearch(q) {
  hits = []; hitIdx = -1;
  q = q.trim().toLowerCase();
  if (q) for (const p of S.pages) {
    if (p.src < 0) continue;
    const items = await pageText(p);
    items.forEach((s, k) => { if (s.toLowerCase().includes(q)) hits.push({ pid: p.id, k }); });
  }
  $('#searchInfo').textContent = q ? (hits.length ? `0/${hits.length}` : 'keine') : '';
  for (const v of views.values()) applyHits(v);
  if (hits.length) gotoHit(0);
}
function applyHits(v) {
  if (!v.text) return;
  const divs = v.text.textDivs || [];
  divs.forEach((d) => d.classList?.remove('hit', 'cur'));
  hits.forEach((h, n) => { if (h.pid === v.p.id && divs[h.k]) { divs[h.k].classList.add('hit'); if (n === hitIdx) divs[h.k].classList.add('cur'); } });
}
async function gotoHit(n) {
  if (!hits.length) return;
  hitIdx = (n + hits.length) % hits.length;
  $('#searchInfo').textContent = `${hitIdx + 1}/${hits.length}`;
  const h = hits[hitIdx], v = views.get(h.pid);
  v.el.scrollIntoView({ block: 'center' });
  await renderPage(v);
  for (const w of views.values()) applyHits(w);
  v.text?.textDivs?.[h.k]?.scrollIntoView({ block: 'center', inline: 'center' });
}
$('#btnSearch').onclick = () => {
  if (!S) return;
  const sb = $('#searchbar'); sb.hidden = !sb.hidden;
  document.body.classList.toggle('searching', !sb.hidden);
  if (!sb.hidden) $('#searchInput').focus(); else { hits = []; for (const v of views.values()) applyHits(v); }
};
$('#searchClose').onclick = () => $('#btnSearch').click();
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (hits.length && e.target.value === runSearch._q) gotoHit(hitIdx + 1); else { runSearch._q = e.target.value; runSearch(e.target.value); } } });
$('#searchNext').onclick = () => { const q = $('#searchInput').value; if (q !== runSearch._q) { runSearch._q = q; runSearch(q); } else gotoHit(hitIdx + 1); };
$('#searchPrev').onclick = () => gotoHit(hitIdx - 1);

// ======================================================= Seiten verwalten
async function openPagesSheet() {
  if (!S) return;
  $('#pagesheet').hidden = false;
  drawPageGrid();
}
let gridToken = 0;
async function drawPageGrid() {
  const grid = $('#pagegrid'); grid.innerHTML = '';
  const cur = currentView()?.p.id;
  const token = ++gridToken;
  const ic = {
    l: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    r: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>', dn: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  };
  S.pages.forEach((p, n) => {
    const d = document.createElement('div');
    d.className = 'pg' + (p.id === cur ? ' cur' : '');
    d.innerHTML = `<div class="thumb"><canvas></canvas></div><div class="lbl">Seite ${n + 1}</div>
      <div class="acts"><button data-a="up" title="Nach vorne">${ic.up}</button><button data-a="l" title="Links drehen">${ic.l}</button>
      <button data-a="r" title="Rechts drehen">${ic.r}</button><button data-a="del" title="Löschen">${ic.del}</button><button data-a="dn" title="Nach hinten">${ic.dn}</button></div>`;
    $('.thumb', d).onclick = () => { $('#pagesheet').hidden = true; views.get(p.id)?.el.scrollIntoView({ block: 'start' }); };
    $$('.acts button', d).forEach((b) => (b.onclick = () => pageAction(p.id, b.dataset.a)));
    grid.appendChild(d);
  });
  // Vorschaubilder nacheinander rendern
  for (let n = 0; n < S.pages.length; n++) {
    if (token !== gridToken) return;
    const p = S.pages[n], c = $$('.pg canvas', grid)[n];
    await renderThumb(p, c, 150);
  }
}
async function renderThumb(p, c, size) {
  const rot = totalRot(p);
  const w = rot % 180 ? pageH(p) : pageW(p), h = rot % 180 ? pageW(p) : pageH(p);
  const s = Math.min(size / w, size * 1.15 / h) * Math.min(2, window.devicePixelRatio || 1);
  c.width = w * s; c.height = h * s; c.style.width = (w * s) / Math.min(2, window.devicePixelRatio || 1) + 'px';
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (p.src >= 0) {
    const pg = await S.sources[p.src].pdf.getPage(p.idx + 1);
    await pg.render({ canvasContext: ctx, viewport: pg.getViewport({ scale: s, rotation: rot }) }).promise;
  }
}
function pageAction(id, a) {
  const n = S.pages.findIndex((p) => p.id === id); if (n < 0) return;
  const p = S.pages[n];
  if (a === 'del' && S.pages.length === 1) { toast('Die letzte Seite kann nicht gelöscht werden'); return; }
  if (a === 'del' && !confirm(`Seite ${n + 1} löschen?`)) return;
  pushUndo();
  if (a === 'l') p.rot = (p.rot + 270) % 360;
  if (a === 'r') p.rot = (p.rot + 90) % 360;
  if (a === 'del') S.pages.splice(n, 1);
  if (a === 'up' && n > 0) [S.pages[n - 1], S.pages[n]] = [S.pages[n], S.pages[n - 1]];
  if (a === 'dn' && n < S.pages.length - 1) [S.pages[n + 1], S.pages[n]] = [S.pages[n], S.pages[n + 1]];
  buildPages(); if (S.fit) fitWidth();
  drawPageGrid();
}
$('#pagesClose').onclick = () => ($('#pagesheet').hidden = true);
$('#pgBlank').onclick = () => {
  const cur = currentView()?.p || S.pages[S.pages.length - 1];
  const n = S.pages.indexOf(cur);
  const r = totalRot(cur), w = r % 180 ? pageH(cur) : pageW(cur), h = r % 180 ? pageW(cur) : pageH(cur);
  pushUndo();
  S.pages.splice(n + 1, 0, { id: uid++, src: -1, idx: 0, base: 0, rot: 0, vb: [0, 0, w, h], items: [] });
  buildPages(); drawPageGrid(); toast('Leere Seite eingefügt');
};
$('#pgMerge').onclick = () => $('#mergeInput').click();
$('#mergeInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !S) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  let pdf; try { pdf = await openPdfJs(bytes); } catch { toast('PDF konnte nicht geöffnet werden'); return; }
  S.sources.push({ bytes, pdf });
  const si = S.sources.length - 1, newPages = await pagesFromSource(si);
  pushUndo();
  S.pages.push(...newPages);
  buildPages(); if (S.fit) fitWidth();
  if (!$('#pagesheet').hidden) drawPageGrid();
  toast(`${newPages.length} Seite(n) aus „${f.name}“ angehängt`);
};

// ======================================================= Speichern (pdf-lib)
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const clean = (s) => [...s.replace(/\r\n?/g, '\n')].map((ch) => { const c = ch.codePointAt(0); return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || ch === '\n' || WINANSI_EXTRA.includes(ch) ? ch : (ch === '\t' ? ' ' : '?'); }).join('');
function dataUrlBytes(url) { const b64 = url.split(',')[1]; const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

async function rasterPage(p, scale = 2.5) {
  // Seite als Bild (für echtes Schwärzen / geschützte PDFs)
  const pg = await S.sources[p.src].pdf.getPage(p.idx + 1);
  const vp = pg.getViewport({ scale, rotation: 0 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext('2d');
  await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  ctx.fillStyle = '#000';
  for (const it of p.items) if (it.t === 'redact') ctx.fillRect(it.u * scale, it.v * scale, it.w * scale, it.h * scale);
  const url = c.toDataURL('image/jpeg', 0.92); c.width = c.height = 0;
  return url;
}

async function drawItems(out, page, p, vb, font) {
  const X = (u) => vb[0] + u, Y = (v) => vb[3] - v;
  for (const it of p.items) {
    const col = it.color ? hexToRgb(it.color) : rgb(0, 0, 0);
    switch (it.t) {
      case 'rect': page.drawRectangle({ x: X(it.u), y: Y(it.v + it.h), width: it.w, height: it.h, borderColor: col, borderWidth: it.width }); break;
      case 'whiteout': page.drawRectangle({ x: X(it.u), y: Y(it.v + it.h), width: it.w, height: it.h, color: rgb(1, 1, 1) }); break;
      case 'redact': page.drawRectangle({ x: X(it.u), y: Y(it.v + it.h), width: it.w, height: it.h, color: rgb(0, 0, 0) }); break;
      case 'ellipse': page.drawEllipse({ x: X(it.u + it.w / 2), y: Y(it.v + it.h / 2), xScale: it.w / 2, yScale: it.h / 2, borderColor: col, borderWidth: it.width }); break;
      case 'line': case 'arrow': case 'ink': case 'marker': case 'check': case 'cross': {
        let strokes = it.strokes || [it.pts];
        if (it.t === 'arrow') strokes = [it.pts, arrowHead(it)];
        for (const s of strokes) {
          const pts = s.length === 1 ? [s[0], [s[0][0] + 0.01, s[0][1]]] : s;
          page.drawSvgPath(pathD(pts), { x: vb[0], y: vb[3], borderColor: col, borderWidth: it.width,
            borderLineCap: it.t === 'marker' ? LineCapStyle.Butt : LineCapStyle.Round,
            ...(it.t === 'marker' ? { borderOpacity: 0.45, blendMode: BlendMode.Multiply } : {}) });
        }
        break;
      }
      case 'highlight':
        for (const [x, y, w, h] of it.rects) page.drawRectangle({ x: X(x), y: Y(y + h), width: w, height: h, color: col, opacity: 0.75, blendMode: BlendMode.Multiply });
        break;
      case 'underline': case 'strike':
        for (const [x, y, w, h] of it.rects) {
          const yy = it.t === 'underline' ? y + h * 0.95 : y + h * 0.55;
          page.drawLine({ start: { x: X(x), y: Y(yy) }, end: { x: X(x + w), y: Y(yy) }, thickness: Math.max(0.8, h * 0.07), color: col });
        }
        break;
      case 'text': {
        const lines = it.text.split('\n'), rot = it.rot || 0;
        lines.forEach((line, k) => {
          const b = it.size * 0.96 + k * it.size * 1.2;
          const [dx, dy] = rotPt(0, b, rot);
          page.drawText(clean(line), { x: X(it.u + dx), y: Y(it.v + dy), size: it.size, font, color: col, rotate: degrees(-rot) });
        });
        break;
      }
      case 'image': {
        const url = S.images[it.img]; if (!url) break;
        const bytes = dataUrlBytes(url);
        const img = url.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const rot = it.rot || 0, [dx, dy] = rotPt(0, it.h, rot);
        page.drawImage(img, { x: X(it.u + dx), y: Y(it.v + dy), width: it.w, height: it.h, rotate: degrees(-rot) });
        break;
      }
    }
  }
}

function applyForms(out) {
  const form = out.getForm();
  let n = 0;
  for (const [name, val] of Object.entries(S.forms)) {
    if (JSON.stringify(val) === JSON.stringify(S.formsInit[name])) continue;
    try {
      const f = form.getField(name);
      if (f instanceof PDFTextField) {
        const def = S.fields[name];
        // Schriftgröße wie im Formular vorgesehen; mehrzeilig ohne Vorgabe: 10 pt statt Riesenschrift
        if (def?.fontSize) f.setFontSize(def.fontSize); else if (def?.multi || f.isMultiline()) f.setFontSize(10);
        f.setText(clean(String(val ?? '')));
      }
      else if (f instanceof PDFCheckBox) val ? f.check() : f.uncheck();
      else if (f instanceof PDFRadioGroup) { if (val) { const opts = f.getOptions(); f.select(opts.includes(val) ? val : opts[0]); } else f.clear(); }
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        const opts = f.getOptions(), def = S.fields[name]?.options.find((o) => o.v === val);
        const pick = opts.includes(val) ? val : def && opts.includes(def.d) ? def.d : null;
        if (pick) f.select(pick); else if (f instanceof PDFDropdown && f.isEditable?.()) f.select(String(val));
      }
      n++;
    } catch (e) { console.warn('Feld', name, e); }
  }
  return n;
}

async function buildPdf() {
  let out, raster = false;
  try { out = await PDFDocument.load(S.sources[0].bytes, { updateMetadata: false }); }
  catch (e) { raster = true; out = await PDFDocument.create(); }
  if (S.encrypted) { raster = true; out = await PDFDocument.create(); }
  const font = await out.embedFont(StandardFonts.Helvetica);
  if (!raster) applyForms(out);
  const orig = raster ? [] : out.getPages();
  const copied = new Map();
  for (let si = 1; si < S.sources.length; si++) {
    const idxs = [...new Set(S.pages.filter((p) => p.src === si).map((p) => p.idx))];
    if (!idxs.length) continue;
    const src = await PDFDocument.load(S.sources[si].bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, idxs);
    idxs.forEach((ix, k) => copied.set(si + ':' + ix, pages[k]));
  }
  const used = new Set(), final = [];
  for (const p of S.pages) {
    let page, vb = p.vb;
    const needRaster = p.src >= 0 && (raster || p.items.some((i) => i.t === 'redact'));
    if (needRaster) {
      const jpg = await out.embedJpg(dataUrlBytes(await rasterPage(p)));
      page = out.addPage([pageW(p), pageH(p)]);
      page.drawImage(jpg, { x: 0, y: 0, width: pageW(p), height: pageH(p) });
      vb = [0, 0, pageW(p), pageH(p)];
    } else if (p.src === 0) {
      page = orig[p.idx];
      if (used.has(page)) { const [cp] = await out.copyPages(out, [p.idx]); page = cp; }
    } else if (p.src > 0) {
      page = copied.get(p.src + ':' + p.idx);
      if (used.has(page)) { const src = await PDFDocument.load(S.sources[p.src].bytes, { ignoreEncryption: true }); [page] = await out.copyPages(src, [p.idx]); }
    } else {
      page = out.addPage([pageW(p), pageH(p)]);
    }
    used.add(page);
    await drawItems(out, page, p, vb, font);
    page.setRotation(degrees(totalRot(p)));
    final.push(page);
  }
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  for (const pg of final) out.addPage(pg);
  try { return { bytes: await out.save(), raster }; }
  catch (e) {
    // Notfall: Feld-Darstellung dem Betrachter überlassen
    console.warn('save fallback', e);
    try { out.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True); } catch {}
    return { bytes: await out.save({ updateFieldAppearances: false }), raster };
  }
}

function outName() { return S.name.toLowerCase().endsWith('.pdf') ? S.name : S.name + '.pdf'; }

async function saveDoc(share = false) {
  if (!S) return;
  document.activeElement?.blur?.();
  toast('PDF wird erstellt …', 10000);
  let res;
  try { res = await buildPdf(); } catch (e) { console.error(e); toast('Fehler beim Speichern: ' + (e.message || e), 6000); return; }
  const file = new File([res.bytes], outName(), { type: 'application/pdf' });
  if (res.raster) toast(S.encrypted ? 'Geschützte PDF: Seiten wurden als Bild gespeichert' : 'Gespeichert (geschwärzte Seiten als Bild)', 4000);
  if (share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); toast('Geteilt'); } catch (e) { if (e.name !== 'AbortError') toast('Teilen nicht möglich'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  S.dirty = false;
  if (!res.raster) toast('Gespeichert in „Downloads“: ' + file.name, 4000);
  window.__lastSaved = res.bytes; // für Tests
}

async function printDoc() {
  if (!S) return;
  toast('Druckansicht wird vorbereitet …', 15000);
  const { bytes } = await buildPdf();
  const pdf = await pdfjsLib.getDocument({ ...DOC_OPTS, data: bytes }).promise;
  const imgs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    imgs.push(c.toDataURL('image/jpeg', 0.9)); c.width = c.height = 0;
  }
  const fr = document.createElement('iframe');
  fr.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(fr);
  fr.contentDocument.write(`<!DOCTYPE html><html><head><style>@page{margin:0}body{margin:0}img{width:100%;display:block;page-break-after:always}</style></head><body>${imgs.map((u) => `<img src="${u}">`).join('')}</body></html>`);
  fr.contentDocument.close();
  await new Promise((r) => setTimeout(r, 400));
  $('#toast').hidden = true;
  fr.contentWindow.focus(); fr.contentWindow.print();
  setTimeout(() => fr.remove(), 60000);
}

// ======================================================= Einfügen
async function paste() {
  if (!S) return;
  const v = currentView(); if (!v) return;
  if (clipItem && Date.now() - clipItem.at < 10 * 60 * 1000) {
    const c = clone(clipItem.item);
    if (c.img && clipItem.image && !S.images[c.img]) S.images[c.img] = clipItem.image;
    const [x, y, w, h] = bbox(c);
    const vr = viewer.getBoundingClientRect();
    const [cu, cv] = toPage(v, vr.left + vr.width / 2, Math.max(vr.top + vr.height / 2, v.el.getBoundingClientRect().top + 30));
    translateItem(c, cu - (x + w / 2), cv - (y + h / 2));
    delete c.id; const it = addItem(v.p, c); setTool('view'); select(it.id);
    return;
  }
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const ci of items) {
        const type = ci.types.find((t) => t.startsWith('image/'));
        if (type) { const blob = await ci.getType(type); const r = await readImageFile(new File([blob], 'x', { type })); placeImage(r.url, r.w, r.h); return; }
      }
    }
    const text = await navigator.clipboard.readText();
    if (text?.trim()) {
      const vr = viewer.getBoundingClientRect();
      const [u, vv] = toPage(v, vr.left + 30, Math.max(vr.top + vr.height / 3, v.el.getBoundingClientRect().top + 30));
      const it = addItem(v.p, { t: 'text', u, v: vv, text: text.trim(), size: toolOpts.text.size || 12, color: toolOpts.text.color, rot: uprightRot(v.p) });
      setTool('view'); select(it.id);
      return;
    }
    toast('Zwischenablage ist leer');
  } catch { toast('Kein Zugriff auf die Zwischenablage'); }
}

// ======================================================= Menü & Verdrahtung
$('#btnMenu').onclick = () => ($('#menu').hidden = false);
$('#menu').onclick = (e) => { if (e.target === $('#menu')) $('#menu').hidden = true; };
$$('#menu [data-act]').forEach((b) => (b.onclick = async () => {
  $('#menu').hidden = true;
  const a = b.dataset.act;
  if (a === 'open') $('#fileInput').click();
  if (a === 'save') saveDoc(false);
  if (a === 'share') saveDoc(true);
  if (a === 'paste') paste();
  if (a === 'pages') openPagesSheet();
  if (a === 'merge') $('#mergeInput').click();
  if (a === 'print') printDoc();
  if (a === 'close') { if (!S.dirty || confirm('Dokument schließen? Nicht gespeicherte Änderungen gehen verloren.')) closeDoc(); }
  if (a === 'install') installPrompt?.prompt();
  if (a === 'about') dialog({ title: 'PDF Studio ' + VERSION, cancel: null,
    html: '<p>Eigene PDF-App – kostenlos, ohne Abo und ohne Werbung. Deine Dateien verlassen das Gerät nicht.</p><p>Technik: pdf.js (Mozilla) zum Anzeigen, pdf-lib zum Speichern.</p>' });
}));
$('#btnOpenWelcome').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (S?.dirty && !confirm('Aktuelles Dokument schließen? Nicht gespeicherte Änderungen gehen verloren.')) return;
  await loadFile(f);
};
$('#btnSave').onclick = async () => {
  if (!S) return;
  if (navigator.canShare?.({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] }) && matchMedia('(pointer:coarse)').matches) {
    const ok = await dialog({ title: 'Speichern', html: '<p><b>Speichern</b> legt die PDF im Ordner „Downloads“ ab.<br><b>Teilen</b> öffnet das Android-Menü (z.&nbsp;B. Google Drive, E-Mail, WhatsApp, Drucken).</p>', ok: 'Speichern', cancel: 'Teilen' });
    if (ok) saveDoc(false);
    else if ($('#dlg').returnValue === 'cancel') saveDoc(true);
  } else saveDoc(false);
};
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnPages').onclick = openPagesSheet;
$$('#toolbar [data-tool]').forEach((b) => (b.onclick = () => { if (!S) { toast('Bitte zuerst eine PDF öffnen'); return; } setTool(b.dataset.tool); }));

document.addEventListener('keydown', (e) => {
  if (!S) return;
  const inField = e.target.closest('input, textarea, select, [contenteditable]');
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !inField) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z')) && !inField) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDoc(false); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); if ($('#searchbar').hidden) $('#btnSearch').click(); else $('#searchInput').focus(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !inField) { e.preventDefault(); paste(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !inField && selId) { $('#itCopy').click(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selId && !inField) { e.preventDefault(); deleteItem(selId); }
  else if (e.key === 'Escape') { select(null); if (tool !== 'view') setTool('view'); }
});

// Drag & Drop (Tablet/PC)
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'));
  if (f) await loadFile(f);
});

window.addEventListener('beforeunload', (e) => { if (S?.dirty) { persist(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });

// Installation / Service Worker / Teilen-Ziel
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#menuInstall').hidden = false; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
if ('launchQueue' in window) window.launchQueue.setConsumer(async (lp) => { if (lp.files?.length) loadFile(await lp.files[0].getFile()); });

(async function start() {
  setTool('view');
  $('#toolopts').hidden = true;
  const params = new URLSearchParams(location.search);
  if (params.has('shared')) {
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('shared-files');
      const res = await cache.match('shared.pdf');
      if (res) { const name = decodeURIComponent(res.headers.get('x-name') || 'Geteilt.pdf'); await loadBytes(new Uint8Array(await res.arrayBuffer()), name); await cache.delete('shared.pdf'); return; }
    } catch (e) { console.warn(e); }
  }
  const sess = await idb.get('session').catch(() => null);
  if (sess?.sources?.length) {
    const b = $('#btnResume'); b.hidden = false; b.textContent = `Weiterarbeiten: ${sess.name}`;
    b.onclick = () => loadBytes(new Uint8Array(sess.sources[0]), sess.name, { ...sess, sources: sess.sources.map((s) => new Uint8Array(s)) });
  }
})();

// Testzugriff
window.__app = { get S() { return S; }, setTool, markSelection, saveDoc, buildPdf, views, select, paste, undo, redo, pageAction, loadBytes, toPage, toScreen, setZoom };
