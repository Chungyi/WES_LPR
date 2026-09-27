// 主程式：畫面切換、資料下載、查詢、車主資訊卡

import { initAuth, renderSignInButton, getValidToken, decodeJwt, signOut } from './auth.js';
import { downloadPlates } from './api.js';
import { loadDataset, saveDataset, clearAll, remainingMs, isExpired } from './store.js';
import { PlateIndex, normalizePlate } from './match.js';
import { $, h, typeBadge, renderResult, setOwnerHandler, toast } from './ui.js';
import { initPhoto } from './photo.js';
import { initLive } from './live.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let dataset = null;
let index = null;
let busy = false;

// ---------- 畫面切換 ----------

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

function showLogin(message = '', type = 'error') {
  showView('view-login');
  setStatus($('login-status'), message, type);
  if (window.google?.accounts?.id) renderSignInButton($('login-button'));
}

function showMain() {
  showView('view-main');
  $('user-name').textContent = dataset.user.name || dataset.user.email;
  updateDataStatus();
}

function setStatus(el, message, type = 'info') {
  el.textContent = message;
  el.dataset.type = type;
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateDataStatus() {
  if (!dataset) return;
  const expired = isExpired(dataset);
  const left = remainingMs(dataset);
  const leftText = expired
    ? '已過期'
    : left >= DAY_MS ? `剩 ${Math.ceil(left / DAY_MS)} 天` : `剩 ${Math.max(1, Math.ceil(left / HOUR_MS))} 小時`;

  $('data-count').textContent = `名單 ${dataset.records.length.toLocaleString()} 筆`;
  $('data-time').textContent = `${formatTime(dataset.downloadedAt)} 下載｜${leftText}`;
  $('data-status').classList.toggle('is-expired', expired);
  $('expired-banner').hidden = !expired;
  $('search-input').disabled = expired;
  $('search-form').querySelector('button').disabled = expired;
  $('btn-photo-camera').disabled = expired;
  $('btn-photo-album').disabled = expired;
  $('btn-live').disabled = expired;
  if (expired) $('results').replaceChildren();
}

// ---------- 登入與資料下載 ----------

async function onToken(token) {
  if (busy) return;
  busy = true;
  const dlg = $('dlg-download');
  const statusEl = dlg.open ? $('download-status') : $('login-status');
  const report = (msg, type) => (dataset && !dlg.open ? toast(msg) : setStatus(statusEl, msg, type));

  report('正在下載名單…', 'info');
  try {
    const data = await downloadPlates(token);
    const claims = decodeJwt(token);
    dataset = {
      records: data.records,
      downloadedAt: Date.now(),
      user: { email: data.user?.email ?? claims.email, name: data.user?.name || claims.name || '' },
    };
    await saveDataset(dataset);
    index = new PlateIndex(dataset.records);
    if (dlg.open) dlg.close();
    showMain();
    toast(`名單已更新，共 ${dataset.records.length.toLocaleString()} 筆`);
    if ($('search-input').value) runSearch();
  } catch (err) {
    console.error(err);
    if (err.code === 'UNAUTHORIZED') {
      // 帳號已被移出授權名單：清除手機上的舊資料
      if (dlg.open) dlg.close();
      await wipeLocal();
      showLogin(err.message);
    } else {
      report(err.message || '發生未預期的錯誤。', 'error');
    }
  } finally {
    busy = false;
  }
}

function onDownloadClick() {
  const token = getValidToken();
  if (token) return onToken(token);
  setStatus($('download-status'), '');
  renderSignInButton($('download-button'));
  $('dlg-download').showModal();
}

async function wipeLocal() {
  signOut();
  await clearAll();
  dataset = null;
  index = null;
  $('search-input').value = '';
  $('results').replaceChildren();
}

async function onLogout() {
  if (!confirm('確定要登出嗎？\n手機上的名單會一併清除。')) return;
  await wipeLocal();
  showLogin('已登出，手機上的名單已清除。', 'info');
}

// ---------- 查詢 ----------

function runSearch() {
  if (!index || isExpired(dataset)) return updateDataStatus();
  const query = $('search-input').value;
  const results = $('results');
  if (!normalizePlate(query)) return results.replaceChildren();

  renderResult(results, query, index.search(query));
}

// ---------- 車主資訊卡 ----------

function openOwner(rec) {
  const dlg = $('dlg-owner');
  const tel = (rec.phone || '').replace(/[^\d+]/g, '');
  const others = index.otherVehicles(rec);

  dlg.replaceChildren(
    h('h2', {}, rec.name || '（未填姓名）'),
    h('p', { class: 'muted' }, [rec.unit, rec.title].filter(Boolean).join('｜')),
    h('dl', { class: 'info' },
      h('dt', {}, '車牌'), h('dd', {}, h('div', {}, h('span', { class: 'plate plate-sm' }, rec.plate), ' ', typeBadge(rec.type))),
      others.length ? [h('dt', {}, '其他車輛'), h('dd', {}, others.map((o) =>
        h('div', {}, h('span', { class: 'plate plate-sm' }, o.plate), ' ', typeBadge(o.type))))] : null,
      h('dt', {}, '行動電話'), h('dd', {}, rec.phone || '未登記')
    ),
    tel
      ? h('a', { class: 'btn btn-call btn-block', href: 'tel:' + tel }, '📞 撥打電話')
      : h('button', { type: 'button', class: 'btn btn-block', disabled: '' }, '未登記電話'),
    h('button', { type: 'button', class: 'btn btn-block', 'data-close': '' }, '關閉')
  );
  dlg.showModal();
}

// ---------- 啟動 ----------

function bindEvents() {
  setOwnerHandler(openOwner);
  const viewDeps = {
    getIndex: () => index,
    isUsable: () => !!index && !isExpired(dataset),
    showView,
    showMain,
    openOwner,
  };
  initPhoto(viewDeps);
  initLive(viewDeps);
  $('btn-download').addEventListener('click', onDownloadClick);
  $('btn-logout').addEventListener('click', onLogout);
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('search-input').blur();
    runSearch();
  });
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }
  // 從背景切回來時，重新檢查是否過期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateDataStatus();
  });
  setInterval(updateDataStatus, 60_000);
}

async function main() {
  bindEvents();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker 註冊失敗', err));
  }

  dataset = await loadDataset();
  if (dataset?.records && dataset?.user) {
    index = new PlateIndex(dataset.records);
    showMain();
  } else {
    dataset = null;
    showLogin('', 'info');
  }

  try {
    await initAuth(onToken);
    if (!dataset) renderSignInButton($('login-button'));
  } catch (err) {
    console.error(err);
    if (!dataset) setStatus($('login-status'), '無法載入 Google 登入元件，請確認網路後重新整理頁面。', 'error');
  }
}

main();
