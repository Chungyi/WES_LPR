// Service worker：讓網頁可以「加入主畫面」，並快取程式本身與 AI 模型（不快取任何名單資料）
// - 程式本身：網路優先，有網路時一定拿最新版；網路斷掉才用快取
// - AI 模型與 onnxruntime（vendor/）：快取優先，第一次下載後就不再重新下載
//   （檔名或資料夾名稱都帶有版本，更新時請改名）

const SHELL_CACHE = 'wes-lpr-shell-v8';
const MODEL_CACHE = 'wes-lpr-models-v1';
const SHELL = [
  './',
  'index.html',
  'about.html',
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
      .then(removeOldCdnFiles)
      .then(() => self.clients.claim())
  );
});

/** 舊版從 jsDelivr 下載的 onnxruntime 已改由本站提供，清掉快取中的舊檔（模型保留，不必重新下載） */
async function removeOldCdnFiles() {
  const cache = await caches.open(MODEL_CACHE);
  const reqs = await cache.keys();
  await Promise.all(reqs.filter((r) => r.url.startsWith('https://cdn.jsdelivr.net/')).map((r) => cache.delete(r)));
}

function isModelAsset(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return (p.includes('/models/') && p.endsWith('.onnx')) || p.includes('/vendor/onnxruntime-web-');
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

  // 一律向伺服器確認有沒有新版（cache: 'no-cache'；沒變時伺服器只回 304，幾乎不耗流量）。
  // 否則瀏覽器可能拿到新的 index.html 配上 HTTP 快取裡舊的 js，新舊程式混用而出錯。
  // 瀏覽器不允許替「navigate」請求另外指定選項，所以網頁本身改用網址重新發出請求。
  const fresh = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    fresh
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
