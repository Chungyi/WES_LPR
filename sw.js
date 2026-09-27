// Service worker：讓網頁可以「加入主畫面」，並快取程式本身與 AI 模型（不快取任何名單資料）
// - 程式本身：網路優先，有網路時一定拿最新版；網路斷掉才用快取
// - AI 模型與 onnxruntime：快取優先，第一次下載後就不再重新下載
//   （檔名或網址都帶有版本，模型更新時請改檔名）

const SHELL_CACHE = 'wes-lpr-shell-v3';
const MODEL_CACHE = 'wes-lpr-models-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/api.js',
  'js/auth.js',
  'js/config.js',
  'js/live.js',
  'js/match.js',
  'js/photo.js',
  'js/recognizer.js',
  'js/store.js',
  'js/tracker.js',
  'js/ui.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL_CACHE, MODEL_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isModelAsset(url) {
  if (url.origin === self.location.origin) return url.pathname.includes('/models/') && url.pathname.endsWith('.onnx');
  return url.origin === 'https://cdn.jsdelivr.net' && url.pathname.startsWith('/npm/onnxruntime-web@');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isModelAsset(url)) {
    e.respondWith(
      caches.open(MODEL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // 其他網站（Google 登入、Apps Script API）一律不經過快取
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
