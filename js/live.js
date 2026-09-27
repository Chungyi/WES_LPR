// 即時辨識畫面：開啟相機，持續辨識畫面中的車牌，在車牌上方疊加結果標籤

import { $, h, renderResult, toast } from './ui.js';
import {
  loadModels, modelsReady, recognizePlates, getBackend, setPreferCpu, loadFastDetector, fastDetectorReady,
} from './recognizer.js';
import { PlateTracker } from './tracker.js';

// 省電設定：沒必要時少算一點，避免手機（特別是用 CPU 的 iPhone）發燙
const ACTIVE_INTERVAL_MS = 60;   // 畫面中有車牌：兩次辨識間隔
const IDLE_INTERVAL_MS = 400;    // 沒看到車牌：放慢到約每秒 2 次
const STATIC_CHECK_MS = 150;     // 畫面沒變時，多久檢查一次畫面
const STATIC_REFRESH_MS = 1500;  // 畫面沒變時，最久多久重新辨識一次
const PIXEL_CHANGE = 16;         // 縮圖上亮度差超過這個值（0～255）的像素，算是「有變化」
const STATIC_RATIO = 0.015;      // 有變化的像素少於 1.5%，視為畫面沒變
const AUTO_PAUSE_MS = 30000;     // 連續多久沒看到車牌就自動暫停並關閉相機

// 即時辨識進行中的標記：網頁若在辨識中被系統關掉（記憶體不足），下次會看到這個標記，
// 自動改用 CPU 並記在這支手機上（使用 GPU 或 CPU 的預設規則見 recognizer.js）。
const RUNNING_KEY = 'wes-lpr-live-running';

let deps = null;     // 由 app.js 提供：getIndex, isUsable, showView, showMain, openOwner
let stream = null;
let active = false;  // 是否在即時辨識畫面
let paused = false;
let loopId = 0;      // 每次重新啟動就換一個編號，舊的迴圈會自動結束
let torchOn = false;
let frameCount = 0;
let autoPaused = false;
let saving = false;         // 最近是否因為畫面沒變而略過辨識
let lastThumb = null;
let lastInferAt = 0;
let lastPlateAt = 0;
const inferTimes = [];      // 最近 3 秒內每次辨識的時間，用來算每秒幾次
let crashNotice = false;
const tracker = new PlateTracker();
const labels = new Map(); // track id → { box, label }

export function initLive(d) {
  deps = d;
  $('btn-live').addEventListener('click', open);
  $('btn-live-back').addEventListener('click', close);
  $('btn-live-pause').addEventListener('click', onPauseClick);
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
    else if (!autoPaused) startCamera();
  });
  window.addEventListener('resize', () => active && layoutLabels());

  if (storage('get', RUNNING_KEY)) {
    // 上次即時辨識時網頁被系統關掉，很可能是記憶體不足：改用 CPU
    storage('remove', RUNNING_KEY);
    // 使用者這次明確用 ?gpu=1 開啟時，尊重使用者的選擇
    crashNotice = !new URLSearchParams(location.search).has('gpu');
  }
}

/** localStorage 可能被瀏覽器封鎖（私密瀏覽等），一律包在 try 裡 */
function storage(op, key, value) {
  try {
    if (op === 'get') return localStorage.getItem(key);
    if (op === 'set') localStorage.setItem(key, value);
    if (op === 'remove') localStorage.removeItem(key);
  } catch {
    return null;
  }
}

async function open() {
  if (!deps.isUsable()) return;
  active = true;
  paused = false;
  autoPaused = false;
  deps.showView('view-live');
  updatePauseButton();
  clearLabels();
  if (crashNotice) {
    crashNotice = false;
    await setPreferCpu(true, { remember: true });
    toast('上次即時辨識時網頁記憶體不足，已改用 CPU 模式');
  }
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
  // 用 CPU 時（iPhone）改用小一號的偵測模型，速度約快 2.7 倍
  if (getBackend() === 'CPU' && !fastDetectorReady()) {
    setBusy(true);
    try {
      await loadFastDetector((p) => setStatus(p < 1 ? `下載快速辨識模型… ${Math.round(p * 100)}%（第一次使用需要下載）` : '準備 AI 模型中…'));
    } catch (err) {
      console.warn('快速辨識模型載入失敗，改用一般模型', err);
    }
    setBusy(false);
    if (!active || !stream) return;
  }
  setStatus('對準車牌，保持手機穩定…');
  frameCount = 0;
  lastThumb = null;
  lastInferAt = 0;
  lastPlateAt = performance.now();
  inferTimes.length = 0;
  storage('set', RUNNING_KEY, String(Date.now()));
  runLoop(++loopId);
}

function stopCamera() {
  loopId++;
  storage('remove', RUNNING_KEY);
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

function onPauseClick() {
  if (autoPaused) {
    autoPaused = false;
    paused = false;
    updatePauseButton();
    startCamera();
  } else {
    setPaused(!paused);
  }
}

/** 太久沒看到車牌：關閉相機（相機本身也很耗電），等使用者按「繼續」 */
function autoPause() {
  autoPaused = true;
  paused = true;
  stopCamera();
  clearLabels();
  updatePauseButton();
  setStatus(`${AUTO_PAUSE_MS / 1000} 秒沒有看到車牌，已自動暫停，避免手機發燙。按「繼續」恢復。`);
}

function setPaused(on) {
  paused = on;
  if (!on) lastPlateAt = performance.now();
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
    if (t0 - lastPlateAt > AUTO_PAUSE_MS) {
      autoPause();
      break;
    }

    // 畫面幾乎沒變（手機對著同一個地方）：沿用上次結果，每 1.5 秒才重新確認一次
    const thumb = sampleThumb(video);
    if (lastThumb && changedRatio(thumb, lastThumb) < STATIC_RATIO && t0 - lastInferAt < STATIC_REFRESH_MS) {
      saving = true;
      updateLiveStatus();
      await sleep(STATIC_CHECK_MS);
      continue;
    }
    saving = false;

    // 先拍一張快照，偵測和讀文字都用同一張（影片一直在變，否則裁切位置會偏掉）。
    // 用 ImageBitmap 而不是畫布：用完立刻 close() 釋放記憶體，不必等瀏覽器回收；
    // iPhone 回收很慢，每秒複製好幾張 1080×1920 畫面會在一分鐘內用光記憶體而被系統重新載入。
    let plates;
    let snapshot = null;
    try {
      snapshot = await grabFrame(video);
      plates = await recognizePlates(snapshot, { fast: useFast() });
    } catch (err) {
      console.error(err);
      setStatus('辨識發生錯誤：' + (err.message || '未知錯誤'), 'error');
      await sleep(1000);
      continue;
    } finally {
      if (snapshot !== video) snapshot?.close?.();
    }
    if (id !== loopId) break;
    frameCount += 1;
    lastThumb = thumb;
    lastInferAt = t0;
    inferTimes.push(t0);

    tracker.update(plates);
    renderLabels();

    const seen = visibleTracks().length > 0;
    if (seen) lastPlateAt = t0;
    updateLiveStatus();
    const ms = performance.now() - t0;
    await sleep(Math.max(0, (seen ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS) - ms));
  }
}

function updateLiveStatus() {
  if (paused) return;
  const now = performance.now();
  while (inferTimes.length && now - inferTimes[0] > 3000) inferTimes.shift();
  const n = visibleTracks().length;
  const rate = `每秒 ${(inferTimes.length / 3).toFixed(1)} 次`;
  const mode = useFast() ? `${getBackend()}・快速` : getBackend();
  setStatus(`${n ? `畫面中 ${n} 個車牌` : '對準車牌，保持手機穩定…'}｜${saving ? '畫面沒變，省電中' : rate}（${mode}）｜第 ${frameCount} 張`);
}

// 用很小的縮圖（32×24 灰階）判斷畫面有沒有變，幾乎不耗電
const thumbCtx = Object.assign(document.createElement('canvas'), { width: 32, height: 24 })
  .getContext('2d', { willReadFrequently: true });

function sampleThumb(video) {
  thumbCtx.drawImage(video, 0, 0, 32, 24);
  const d = thumbCtx.getImageData(0, 0, 32, 24).data;
  const g = new Uint8Array(32 * 24);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  return g;
}

/** 有明顯變化的像素比例。不用平均差異：車子移動時只有邊緣會變，平均下來差異很小 */
function changedRatio(a, b) {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_CHANGE) changed++;
  return changed / a.length;
}

/** 用 CPU 時使用快速偵測模型；GPU 中途出錯改用 CPU 時，在背景下載快速模型 */
function useFast() {
  if (getBackend() !== 'CPU') return false;
  if (!fastDetectorReady()) loadFastDetector().catch(() => {});
  return fastDetectorReady();
}

let bitmapSupported = typeof createImageBitmap === 'function';
async function grabFrame(video) {
  if (bitmapSupported) {
    try {
      return await createImageBitmap(video);
    } catch (err) {
      console.warn('createImageBitmap 無法使用，改為直接讀取影片', err);
      bitmapSupported = false;
    }
  }
  return video;
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
