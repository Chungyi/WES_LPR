// 拍照辨識畫面：選照片 → 辨識 → 在照片上的車牌旁標示結果，並列出每個車牌的查詢結果

import { $, h, renderResult } from './ui.js';
import { loadModels, modelsReady, readPhoto, recognizePlates, readPlateAt } from './recognizer.js';

const LOW_CONFIDENCE = 0.6;

let deps = null;   // 由 app.js 提供：getIndex, isUsable, showView, showMain, openOwner
let photo = null;  // 目前照片（canvas，原始解析度，最長邊 1920）
let items = [];    // [{ box, text, confidence, source: 'auto' | 'manual', query? }]
let marking = false;
let drag = null;

export function initPhoto(d) {
  deps = d;
  $('btn-photo-camera').addEventListener('click', () => pick('file-camera'));
  $('btn-photo-album').addEventListener('click', () => pick('file-album'));
  $('btn-retake').addEventListener('click', () => pick('file-camera'));
  $('btn-album2').addEventListener('click', () => pick('file-album'));
  $('btn-mark').addEventListener('click', () => setMarking(!marking));
  $('btn-photo-back').addEventListener('click', () => {
    setMarking(false);
    deps.showMain();
  });
  for (const id of ['file-camera', 'file-album']) {
    $(id).addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) onPhoto(file);
    });
  }

  const overlay = $('photo-overlay');
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', () => endDrag());
}

function pick(inputId) {
  if (!deps.isUsable()) return;
  const input = $(inputId);
  input.value = '';
  input.click();
  // 使用者拍照的同時，先在背景下載模型
  loadModels().catch(() => {});
}

// ---------- 辨識流程 ----------

async function onPhoto(file) {
  setMarking(false);
  deps.showView('view-photo');
  items = [];
  photo = null;
  render();
  setBusy('讀取照片…');

  try {
    photo = await readPhoto(file);
    const view = $('photo-canvas');
    view.width = photo.width;
    view.height = photo.height;
    view.getContext('2d').drawImage(photo, 0, 0);

    if (!modelsReady()) {
      await loadModels((p) => setBusy(p < 1 ? `下載 AI 模型… ${Math.round(p * 100)}%\n（第一次使用需要下載，之後不用）` : '準備 AI 模型中…'));
    }
    setBusy('辨識中…');
    await nextFrame();
    const t = performance.now();
    const plates = await recognizePlates(photo);
    items = plates.map((p) => ({ ...p, source: 'auto' }));
    console.info(`辨識 ${items.length} 個車牌，耗時 ${Math.round(performance.now() - t)} ms`);
    setBusy(null);
    render();
  } catch (err) {
    console.error(err);
    setBusy(null);
    setSummary(photo
      ? '辨識失敗：' + (err.message || '未知錯誤') + '。請確認網路後重新拍照。'
      : '無法讀取這張照片，請重新拍照或換一張照片。', 'error');
  }
}

function setBusy(text) {
  $('photo-busy').hidden = !text;
  $('photo-busy-text').textContent = text || '';
}

function setSummary(text, type = 'info') {
  const el = $('photo-summary');
  el.textContent = text;
  el.dataset.type = type;
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

// ---------- 顯示結果 ----------

function statusOf(r) {
  if (r.kind === 'exact') return 'found';
  if (r.kind === 'none') return 'none';
  return 'candidate';
}

function firstRecord(r) {
  if (r.kind === 'fuzzy') return r.candidates[0].record;
  return r.records?.[0];
}

function render() {
  const overlay = $('photo-overlay');
  const list = $('photo-results');
  overlay.replaceChildren();
  list.replaceChildren();
  if (!photo) return setSummary('');

  const index = deps.getIndex();
  const n = items.length;
  setSummary(n
    ? `找到 ${n} 個車牌。沒被框到的車牌，可以按「框選車牌」手動框出來。`
    : '沒有找到車牌。請按「框選車牌」，在照片上拖曳框出車牌位置，或重新拍照。', n ? 'info' : 'warn');

  items.forEach((item, i) => {
    const query = item.query ?? item.text;
    const r = index.search(query);
    const status = statusOf(r);
    overlay.append(...overlayFor(item, i, r, status));
    list.append(listItemFor(item, i, r, query));
  });
}

function overlayFor(item, i, r, status) {
  const W = photo.width;
  const H = photo.height;
  const { x1, y1, x2, y2 } = item.box;
  const pct = (v, total) => `${(v / total) * 100}%`;

  const box = h('div', { class: `pbox pbox-${status}` }, h('span', { class: 'pnum' }, i + 1));
  Object.assign(box.style, { left: pct(x1, W), top: pct(y1, H), width: pct(x2 - x1, W), height: pct(y2 - y1, H) });

  const rec = firstRecord(r);
  let text;
  if (status === 'found') {
    text = [rec.unit, rec.title, rec.name].filter(Boolean).join('｜');
    if (r.records.length > 1) text += ` 等 ${r.records.length} 筆`;
  } else if (status === 'candidate') {
    text = `可能是 ${rec.plate}？`;
  } else {
    text = '查無資料';
  }

  const label = h('button', { type: 'button', class: `plabel plabel-${status}` }, text);
  // 靠近上緣時標籤改放在框的下方；靠右時改成向左對齊，避免超出照片
  if (y1 / H < 0.08) label.style.top = pct(y2, H);
  else Object.assign(label.style, { top: pct(y1, H), transform: 'translateY(-100%)' });
  if (x1 / W > 0.55) label.style.right = `${100 - (x2 / W) * 100}%`;
  else label.style.left = pct(x1, W);

  label.addEventListener('click', (e) => {
    e.stopPropagation();
    if (status === 'found') deps.openOwner(rec);
    else focusItem(i);
  });
  return [box, label];
}

function listItemFor(item, i, r, query) {
  const results = h('div', { class: 'results' });
  renderResult(results, query, r);

  const input = h('input', {
    type: 'text', value: query, 'aria-label': `第 ${i + 1} 個車牌的文字`,
    autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search',
  });
  const form = h('form', { class: 'search search-sm', autocomplete: 'off' },
    input, h('button', { type: 'submit', class: 'btn btn-primary' }, '查詢'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    item.query = input.value;
    render();
    focusItem(i);
  });

  const conf = item.source === 'manual' ? '手動框選' : `信心 ${Math.round(item.confidence * 100)}%`;
  const low = item.text && item.confidence < LOW_CONFIDENCE;
  return h('section', { class: 'pitem', id: `pitem-${i}` },
    h('div', { class: 'pitem-head' },
      h('span', { class: 'pnum pnum-static' }, i + 1),
      h('span', {}, '辨識：', h('b', {}, item.text || '（沒有讀到文字）')),
      h('span', { class: 'muted' }, conf)),
    low ? h('p', { class: 'hint' }, '辨識不太確定，請核對照片上的車牌，必要時修改後重新查詢。') : null,
    form,
    results
  );
}

function focusItem(i) {
  const el = $(`pitem-${i}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------- 手動框選 ----------

function setMarking(on) {
  marking = on && !!photo;
  $('photo-stage').classList.toggle('marking', marking);
  $('btn-mark').textContent = marking ? '取消框選' : '✏️ 框選車牌';
  if (marking) setSummary('請在照片上用手指拖曳，框出車牌的範圍。', 'warn');
  else if (photo) render();
}

function toPhotoXY(e) {
  const rect = $('photo-canvas').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(photo.width, ((e.clientX - rect.left) / rect.width) * photo.width)),
    y: Math.max(0, Math.min(photo.height, ((e.clientY - rect.top) / rect.height) * photo.height)),
  };
}

function dragBox() {
  const { start, end } = drag;
  return {
    x1: Math.min(start.x, end.x), y1: Math.min(start.y, end.y),
    x2: Math.max(start.x, end.x), y2: Math.max(start.y, end.y),
  };
}

function onPointerDown(e) {
  if (!marking) return;
  e.preventDefault();
  $('photo-overlay').setPointerCapture(e.pointerId);
  const p = toPhotoXY(e);
  drag = { start: p, end: p, el: h('div', { class: 'pbox pbox-drawing' }) };
  $('photo-overlay').append(drag.el);
}

function onPointerMove(e) {
  if (!drag) return;
  drag.end = toPhotoXY(e);
  const b = dragBox();
  const pct = (v, total) => `${(v / total) * 100}%`;
  Object.assign(drag.el.style, {
    left: pct(b.x1, photo.width), top: pct(b.y1, photo.height),
    width: pct(b.x2 - b.x1, photo.width), height: pct(b.y2 - b.y1, photo.height),
  });
}

async function onPointerUp(e) {
  if (!drag) return;
  drag.end = toPhotoXY(e);
  const box = dragBox();
  endDrag();
  if (box.x2 - box.x1 < 12 || box.y2 - box.y1 < 6) return;

  setMarking(false);
  setBusy('辨識中…');
  try {
    await loadModels();
    const r = await readPlateAt(photo, box);
    items.push({ box, score: 1, ...r, source: 'manual' });
    setBusy(null);
    render();
    focusItem(items.length - 1);
  } catch (err) {
    console.error(err);
    setBusy(null);
    setSummary('辨識失敗：' + (err.message || '未知錯誤'), 'error');
  }
}

function endDrag() {
  drag?.el.remove();
  drag = null;
}
