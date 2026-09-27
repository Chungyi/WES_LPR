// 手機端資料儲存（IndexedDB）
// 只存一筆 dataset：{ records, downloadedAt, user: { email, name } }

import { CONFIG } from './config.js';

const DB_NAME = 'wes-lpr';
const STORE = 'kv';
const KEY = 'dataset';
const DAY_MS = 24 * 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDataset() {
  try {
    return (await run('readonly', (s) => s.get(KEY))) ?? null;
  } catch (err) {
    console.warn('讀取本機資料失敗', err);
    return null;
  }
}

export function saveDataset(dataset) {
  return run('readwrite', (s) => s.put(dataset, KEY));
}

/** 登出或帳號被取消授權時使用：整個資料庫刪除 */
export function clearAll() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** 剩餘有效時間（毫秒），≤ 0 代表已過期 */
export function remainingMs(dataset, now = Date.now()) {
  return dataset.downloadedAt + CONFIG.DATA_TTL_DAYS * DAY_MS - now;
}

export function isExpired(dataset, now = Date.now()) {
  return remainingMs(dataset, now) <= 0;
}
