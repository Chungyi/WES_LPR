// 車牌辨識（全部在手機上執行）：車牌偵測（YOLOv9）→ 文字辨識（fast-plate-ocr）
// 模型來源與授權見 models/README.md

// 手機支援 WebGPU 時，車牌偵測改用 GPU 執行（約快 5～6 倍）；不支援時用 CPU（WASM）
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const ORT_WASM_URL = ORT_CDN + 'ort.wasm.min.mjs';
const ORT_WEBGPU_URL = ORT_CDN + 'ort.webgpu.min.mjs';

const DETECTOR = {
  url: 'models/plate-detector-yolov9t-640.onnx',
  bytes: 7835770,
  size: 640,
  scoreThreshold: 0.35,
};

const OCR = {
  url: 'models/plate-ocr-cct-s-v2.onnx',
  bytes: 5262230,
  width: 128,
  height: 64,
  slots: 10,
  alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_',
  padChar: '_',
};

// 照片長邊超過這個尺寸就先縮小，避免手機記憶體不足
const MAX_PHOTO_SIDE = 1920;

let ort = null;
let detector = null;
let ocr = null;
let loading = null;
let backend = 'CPU';
let detModelBytes = null; // 保留偵測模型，GPU 出問題時用來改建 CPU 版
let detInput = null;      // 偵測模型的輸入資料，重複使用（每張約 4.9 MB）

const progressListeners = new Set();
let lastProgress = 0;

export function modelsReady() {
  return !!(detector && ocr);
}

/** 車牌偵測目前使用 'GPU' 或 'CPU' */
export function getBackend() {
  return backend;
}

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/**
 * 下載並載入模型。可以重複呼叫：已經在下載時會共用同一次下載，
 * onProgress(0~1) 會收到目前的下載進度。
 */
export function loadModels(onProgress) {
  if (onProgress) {
    progressListeners.add(onProgress);
    onProgress(lastProgress);
  }
  loading ??= (async () => {
    const total = DETECTOR.bytes + OCR.bytes;
    const received = { det: 0, ocr: 0 };
    const report = () => {
      lastProgress = Math.min(1, (received.det + received.ocr) / total);
      progressListeners.forEach((fn) => fn(lastProgress));
    };

    const useGpu = await hasWebGPU();
    const [ortModule, detBytes, ocrBytes] = await Promise.all([
      import(useGpu ? ORT_WEBGPU_URL : ORT_WASM_URL),
      fetchWithProgress(DETECTOR.url, (n) => { received.det = n; report(); }),
      fetchWithProgress(OCR.url, (n) => { received.ocr = n; report(); }),
    ]);
    ort = ortModule;
    detModelBytes = detBytes;
    ort.env.wasm.numThreads = 1; // GitHub Pages 無法開啟跨來源隔離，多執行緒不可用
    const cpu = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };

    detector = null;
    if (useGpu) {
      try {
        detector = await ort.InferenceSession.create(detBytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
        await warmUp(detector, 'float32', [1, 3, DETECTOR.size, DETECTOR.size]);
        backend = 'GPU';
      } catch (err) {
        console.warn('WebGPU 無法使用，改用 CPU', err);
        detector = null;
      }
    }
    if (!detector) {
      detector = await ort.InferenceSession.create(detBytes, cpu);
      backend = 'CPU';
    }
    // 文字辨識模型很小（每次約 1 毫秒），用 CPU 就夠快
    ocr = await ort.InferenceSession.create(ocrBytes, cpu);
    await warmUp(ocr, 'uint8', [1, OCR.height, OCR.width, 3]);
  })().catch((err) => {
    loading = null;
    lastProgress = 0;
    throw err;
  });
  const done = () => onProgress && progressListeners.delete(onProgress);
  return loading.finally(done);
}

/** 先用空白資料跑一次，第一張真實畫面就不會因為初始化而特別慢 */
async function warmUp(session, type, dims) {
  const size = dims.reduce((a, b) => a * b, 1);
  const data = type === 'uint8' ? new Uint8Array(size) : new Float32Array(size);
  await session.run({ [session.inputNames[0]]: new ort.Tensor(type, data, dims) });
}

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`模型下載失敗（${res.status}）`);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onBytes(n);
  }
  const out = new Uint8Array(n);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 讀取照片檔：自動轉正（EXIF 方向），太大就縮小，回傳 canvas */
export async function readPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/**
 * 辨識照片中所有車牌。
 * 回傳 [{ box: {x1,y1,x2,y2}, score, text, confidence }]，依左到右排序。
 */
export async function recognizePlates(canvas, { scoreThreshold = DETECTOR.scoreThreshold } = {}) {
  if (!detector || !ocr) throw new Error('模型尚未載入');
  let boxes;
  try {
    boxes = await detect(canvas, scoreThreshold);
  } catch (err) {
    if (backend !== 'GPU') throw err;
    // GPU 執行到一半出錯（例如手機記憶體不足、GPU 被系統收回）：改用 CPU 繼續
    console.warn('GPU 辨識失敗，改用 CPU', err);
    await switchToCpu();
    boxes = await detect(canvas, scoreThreshold);
  }
  if (!boxes.length) return [];
  const texts = await readTexts(canvas, boxes);
  return boxes
    .map((b, i) => ({ ...b, ...texts[i] }))
    .sort((a, b) => a.box.x1 - b.box.x1);
}

let switching = null;
function switchToCpu() {
  switching ??= (async () => {
    const old = detector;
    detector = await ort.InferenceSession.create(detModelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    backend = 'CPU';
    old?.release?.().catch(() => {});
  })().finally(() => {
    switching = null;
  });
  return switching;
}

/** 使用者手動框選的區域，直接做文字辨識 */
export async function readPlateAt(canvas, box) {
  if (!ocr) throw new Error('模型尚未載入');
  return (await readTexts(canvas, [{ box }]))[0];
}

// ---------- 車牌偵測 ----------

async function detect(canvas, scoreThreshold) {
  const S = DETECTOR.size;
  const { width: w, height: h } = canvas;
  const r = Math.min(S / w, S / h);
  const nw = Math.round(w * r);
  const nh = Math.round(h * r);
  const dw = (S - nw) / 2;
  const dh = (S - nh) / 2;

  // letterbox：等比例縮放，周圍補灰色 (114,114,114)，與模型訓練時相同
  const ctx = scratch('letterbox', S, S);
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(canvas, dw, dh, nw, nh);
  const px = ctx.getImageData(0, 0, S, S).data;

  // RGBA (HWC) → RGB (CHW)，數值 0~1
  const area = S * S;
  detInput ??= new Float32Array(3 * area);
  const input = detInput;
  for (let i = 0; i < area; i++) {
    input[i] = px[i * 4] / 255;
    input[area + i] = px[i * 4 + 1] / 255;
    input[2 * area + i] = px[i * 4 + 2] / 255;
  }

  const feeds = { [detector.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) };
  const out = (await detector.run(feeds))[detector.outputNames[0]];
  const rows = out.dims[0];
  const d = out.data;

  // 每一列：[batch, x1, y1, x2, y2, class, score]（模型內已做 NMS）
  const results = [];
  for (let i = 0; i < rows; i++) {
    const score = d[i * 7 + 6];
    if (score < scoreThreshold) continue;
    const x1 = clamp((d[i * 7 + 1] - dw) / r, 0, w);
    const y1 = clamp((d[i * 7 + 2] - dh) / r, 0, h);
    const x2 = clamp((d[i * 7 + 3] - dw) / r, 0, w);
    const y2 = clamp((d[i * 7 + 4] - dh) / r, 0, h);
    if (x2 - x1 < 8 || y2 - y1 < 4) continue;
    results.push({ box: { x1, y1, x2, y2 }, score });
  }
  return results;
}

// ---------- 文字辨識 ----------

async function readTexts(canvas, boxes) {
  const { width: W, height: H, slots, alphabet, padChar } = OCR;
  const ctx = scratch('crop', W, H);

  // 每個車牌裁切後直接拉伸成 128×64（模型設定 keep_aspect_ratio: false），RGB uint8、NHWC
  const input = new Uint8Array(boxes.length * H * W * 3);
  boxes.forEach(({ box }, n) => {
    ctx.drawImage(canvas, box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const base = n * H * W * 3;
    for (let i = 0; i < W * H; i++) {
      input[base + i * 3] = px[i * 4];
      input[base + i * 3 + 1] = px[i * 4 + 1];
      input[base + i * 3 + 2] = px[i * 4 + 2];
    }
  });

  const feeds = { [ocr.inputNames[0]]: new ort.Tensor('uint8', input, [boxes.length, H, W, 3]) };
  const plateOut = ocr.outputNames.includes('plate') ? 'plate' : ocr.outputNames[0];
  const probs = (await ocr.run(feeds))[plateOut].data;
  const V = alphabet.length;

  // 每個位置取機率最高的字元；信心值取所有字元中最低的機率
  return boxes.map((_, n) => {
    let text = '';
    let confidence = 1;
    for (let s = 0; s < slots; s++) {
      const base = (n * slots + s) * V;
      let best = 0;
      for (let c = 1; c < V; c++) if (probs[base + c] > probs[base + best]) best = c;
      const ch = alphabet[best];
      if (ch === padChar) continue;
      text += ch;
      confidence = Math.min(confidence, probs[base + best]);
    }
    return { text, confidence: text ? confidence : 0 };
  });
}

// 重複使用的暫存畫布（即時辨識時每秒會呼叫好幾次，避免一直配置新記憶體）
const scratchCanvases = {};
function scratch(name, w, h) {
  let c = scratchCanvases[name];
  if (!c) {
    const canvas = document.createElement('canvas');
    c = scratchCanvases[name] = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (c.canvas.width !== w || c.canvas.height !== h) {
    c.canvas.width = w;
    c.canvas.height = h;
  }
  return c;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
