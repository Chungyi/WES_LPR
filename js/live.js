// 即時辨識畫面：開啟相機，持續辨識畫面中的車牌，在車牌上方疊加結果標籤

import { $, h, renderResult, toast } from './ui.js';
import { loadModels, modelsReady, recognizePlates, getBackend } from './recognizer.js';
import { PlateTracker } from './tracker.js';

const MAX_FRAME_SIDE = 1920; // 送去辨識的畫面最長邊
const MIN_INTERVAL_MS = 60;  // 兩次辨識之間至少間隔，讓畫面保持流暢、手機不會太燙

let deps = null;     // 由 app.js 提供：getIndex, isUsable, showView, showMain, openOwner
let stream = null;
let active = false;  // 是否在即時辨識畫面
let paused = false;
let loopId = 0;      // 每次重新啟動就換一個編號，舊的迴圈會自動結束
let torchOn = false;
let avgMs = 0;
const tracker = new PlateTracker();
const labels = new Map(); // track id → { box, label }
const frame = document.createElement('canvas');
let frameCtx = null;

export function initLive(d) {
  deps = d;
  $('btn-live').addEventListener('click', open);
  $('btn-live-back').addEventListener('click', close);
  $('btn-live-pause').addEventListener('click', () => setPaused(!paused));
  $('btn-live-torch').addEventListener('click', toggleTorch);
  $('live-item-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('live-item-input').value;
    renderResult($('live-item-results'), q, deps.getIndex().search(q));
  });
  // 切到背景時關閉相機（省電、釋放相機），回來時再打開
  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.visibilityState === 'hidden') stopCamera();
    else startCamera();
  });
  window.addEventListener('resize', () => active && layoutLabels());
}

async function open() {
  if (!deps.isUsable()) return;
  active = true;
  paused = false;
  deps.showView('view-live');
  updatePauseButton();
  clearLabels();
  loadModels().catch(() => {});
  await startCamera();
}

function close() {
  active = false;
  stopCamera();
  clearLabels();
  deps.showMain();
}

// ---------- 相機 ----------

async function startCamera() {
  if (stream) return;
  setStatus('開啟相機中…');
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('這個瀏覽器不支援相機，請改用「拍照辨識」。', 'error');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    console.error(err);
    const msg = err.name === 'NotAllowedError'
      ? '沒有相機權限。請在瀏覽器設定中允許這個網站使用相機，再重新進入。'
      : '無法開啟相機：' + (err.message || err.name);
    setStatus(msg, 'error');
    return;
  }
  if (!active) return stopCamera(); // 開相機的過程中使用者已經離開

  const video = $('live-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  torchOn = false;
  updateTorchButton();

  if (!modelsReady()) {
    setBusy(true);
    try {
      await loadModels((p) => setStatus(p < 1 ? `下載 AI 模型… ${Math.round(p * 100)}%（第一次使用需要下載）` : '準備 AI 模型中…'));
    } catch (err) {
      setBusy(false);
      setStatus('AI 模型下載失敗，請確認網路後重新進入。', 'error');
      return;
    }
    setBusy(false);
  }
  setStatus('對準車牌，保持手機穩定…');
  runLoop(++loopId);
}

function stopCamera() {
  loopId++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('live-video').srcObject = null;
  tracker.reset();
}

function setBusy(on) {
  $('live-busy').hidden = !on;
}

function setStatus(text, type = 'info') {
  const el = $('live-status');
  el.textContent = text;
  el.dataset.type = type;
}

// ---------- 手電筒 ----------

function videoTrack() {
  return stream?.getVideoTracks()[0];
}

function torchSupported() {
  const track = videoTrack();
  return !!track?.getCapabilities?.().torch;
}

function updateTorchButton() {
  const btn = $('btn-live-torch');
  btn.classList.toggle('is-on', torchOn);
  btn.textContent = torchOn ? '🔦 關燈' : '🔦 手電筒';
}

async function toggleTorch() {
  if (!torchSupported()) {
    toast('這支手機的瀏覽器無法控制手電筒，請從控制中心開啟');
    return;
  }
  try {
    await videoTrack().applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
  } catch (err) {
    console.error(err);
    toast('無法切換手電筒');
  }
  updateTorchButton();
}

// ---------- 暫停 ----------

function setPaused(on) {
  paused = on;
  const video = $('live-video');
  if (on) video.pause();
  else video.play().catch(() => {});
  updatePauseButton();
  setStatus(on ? '已暫停。點標籤可以查看詳細資料。' : '對準車牌，保持手機穩定…');
}

function updatePauseButton() {
  $('btn-live-pause').textContent = paused ? '▶ 繼續' : '⏸ 暫停';
}

// ---------- 辨識迴圈 ----------

async function runLoop(id) {
  const video = $('live-video');
  while (id === loopId) {
    const t0 = performance.now();
    // 暫停、開著對話框、相機還沒準備好時，先不辨識
    if (paused || document.querySelector('dialog[open]') || video.readyState < 2 || !video.videoWidth) {
      await sleep(200);
      continue;
    }

    const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const fw = Math.round(video.videoWidth * scale);
    const fh = Math.round(video.videoHeight * scale);
    // 只有尺寸改變時才重設畫布：每次設定 width/height 都會重新配置畫布記憶體，
    // iPhone 回收得慢，每秒好幾次會在十幾秒內用光記憶體而當掉
    if (frame.width !== fw || frame.height !== fh) {
      frame.width = fw;
      frame.height = fh;
    }
    frameCtx ??= frame.getContext('2d');
    frameCtx.drawImage(video, 0, 0, fw, fh);

    let plates;
    try {
      plates = await recognizePlates(frame);
    } catch (err) {
      console.error(err);
      setStatus('辨識發生錯誤：' + (err.message || '未知錯誤'), 'error');
      await sleep(1000);
      continue;
    }
    if (id !== loopId) break;

    // 座標換回原始畫面尺寸，交給追蹤器投票
    const inv = 1 / scale;
    tracker.update(plates.map((p) => ({
      ...p,
      box: { x1: p.box.x1 * inv, y1: p.box.y1 * inv, x2: p.box.x2 * inv, y2: p.box.y2 * inv },
    })));
    renderLabels();

    const ms = performance.now() - t0;
    avgMs = avgMs ? avgMs * 0.8 + ms * 0.2 : ms;
    if (!paused) {
      const n = visibleTracks().length;
      const rate = avgMs < 1000 ? `每秒 ${(1000 / avgMs).toFixed(1)} 次` : `每 ${(avgMs / 1000).toFixed(1)} 秒一次`;
      setStatus(`${n ? `畫面中 ${n} 個車牌` : '對準車牌，保持手機穩定…'}｜${rate}（${getBackend()}）`);
    }
    await sleep(Math.max(0, MIN_INTERVAL_MS - ms));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 疊加標籤 ----------

function statusOf(r) {
  if (r.kind === 'exact') return 'found';
  if (r.kind === 'none') return 'none';
  return 'candidate';
}

function firstRecord(r) {
  if (r.kind === 'fuzzy') return r.candidates[0].record;
  return r.records?.[0];
}

/** 名單中完全相符的車牌，看到一次就立刻顯示；其他的要多看幾次確認 */
function visibleTracks() {
  const index = deps.getIndex();
  return tracker.visible((t) => index.search(t.text).kind === 'exact');
}

function clearLabels() {
  labels.clear();
  $('live-overlay').replaceChildren();
}

function renderLabels() {
  const overlay = $('live-overlay');
  const index = deps.getIndex();
  const seen = new Set();

  for (const t of visibleTracks()) {
    seen.add(t.id);
    const r = index.search(t.text);
    const status = statusOf(r);
    const rec = firstRecord(r);
    let text;
    if (status === 'found') {
      text = [rec.unit, rec.title, rec.name].filter(Boolean).join('｜');
      if (r.records.length > 1) text += ` 等 ${r.records.length} 筆`;
    } else if (status === 'candidate') {
      text = `可能是 ${rec.plate}？`;
    } else {
      text = `查無資料｜${t.text}`;
    }

    let item = labels.get(t.id);
    if (!item) {
      const box = h('div', { class: 'pbox live-box' });
      const label = h('button', { type: 'button', class: 'plabel live-label' });
      label.addEventListener('click', () => onLabelClick(item));
      overlay.append(box, label);
      item = { box, label };
      labels.set(t.id, item);
    }
    Object.assign(item, { track: t, result: r, status, record: rec });
    item.box.className = `pbox live-box pbox-${status}`;
    item.label.className = `plabel live-label plabel-${status}`;
    item.label.textContent = text;
  }

  // 已經離開畫面的車牌
  for (const [id, item] of labels) {
    if (!seen.has(id)) {
      item.box.remove();
      item.label.remove();
      labels.delete(id);
    }
  }
  layoutLabels();
}

/** 影片以 object-fit: cover 顯示，要把畫面座標換算成螢幕上的位置 */
function layoutLabels() {
  const video = $('live-video');
  if (!video.videoWidth) return;
  const rect = video.getBoundingClientRect();
  const s = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const ox = (rect.width - video.videoWidth * s) / 2;
  const oy = (rect.height - video.videoHeight * s) / 2;

  for (const { box, label, track } of labels.values()) {
    const x1 = ox + track.box.x1 * s;
    const y1 = oy + track.box.y1 * s;
    const x2 = ox + track.box.x2 * s;
    const y2 = oy + track.box.y2 * s;
    Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });

    // 標籤放在框的上方；太靠上緣時放下方；靠右時改成向左對齊
    const below = y1 < 90;
    Object.assign(label.style, {
      top: below ? `${y2 + 6}px` : `${y1 - 6}px`,
      transform: below ? 'none' : 'translateY(-100%)',
      left: x1 > rect.width * 0.55 ? 'auto' : `${Math.max(4, x1)}px`,
      right: x1 > rect.width * 0.55 ? `${Math.max(4, rect.width - x2)}px` : 'auto',
    });
  }
}

function onLabelClick(item) {
  if (!item) return;
  if (item.status === 'found') {
    deps.openOwner(item.record);
    return;
  }
  // 不確定或查無資料：顯示辨識文字，可以修改後重新查詢
  $('live-item-input').value = item.track.text;
  renderResult($('live-item-results'), item.track.text, item.result);
  $('dlg-live-item').showModal();
}
