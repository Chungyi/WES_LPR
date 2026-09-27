// 共用的畫面元件：建立元素、查詢結果卡片、提示訊息

import { normalizePlate } from './match.js';

export const $ = (id) => document.getElementById(id);

const MAX_LIST = 20; // 只輸入數字時，最多列出幾筆

/** 建立元素；文字一律用 textContent，避免試算表內容被當成 HTML */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 點姓名時要做的事（開啟車主資訊卡），由 app.js 設定
let ownerHandler = () => {};
export function setOwnerHandler(fn) {
  ownerHandler = fn;
}

export function typeBadge(type) {
  return h('span', { class: 'badge ' + (type === '機車' ? 'badge-moto' : 'badge-car') }, type || '未分類');
}

export function plateCard(rec, kind) {
  return h('article', { class: 'card card-' + kind },
    h('div', { class: 'card-top' }, h('span', { class: 'plate' }, rec.plate), typeBadge(rec.type)),
    h('div', { class: 'owner-line' }, [rec.unit, rec.title].filter(Boolean).join('｜')),
    h('button', { type: 'button', class: 'name-link', onclick: () => ownerHandler(rec) }, rec.name || '（未填姓名）', h('span', { 'aria-hidden': 'true' }, ' ›'))
  );
}

/** 把 PlateIndex.search() 的結果畫到 container 裡 */
export function renderResult(container, query, r) {
  if (r.kind === 'exact') {
    container.replaceChildren(...r.records.map((rec) => plateCard(rec, 'found')));
  } else if (r.kind === 'digits' || r.kind === 'partial') {
    const q = normalizePlate(query);
    const hint = r.kind === 'digits'
      ? `數字「${q}」符合 ${r.records.length} 筆：`
      : `沒有數字完全相同的車牌，包含「${q}」的有 ${r.records.length} 筆：`;
    container.replaceChildren(
      h('p', { class: r.kind === 'digits' ? 'hint hint-info' : 'hint' }, hint),
      ...r.records.slice(0, MAX_LIST).map((rec) => plateCard(rec, r.kind === 'digits' ? 'found' : 'candidate'))
    );
    if (r.records.length > MAX_LIST) {
      container.append(h('p', { class: 'hint' }, `還有 ${r.records.length - MAX_LIST} 筆未顯示，請輸入更多數字或加上英文字母。`));
    }
  } else if (r.kind === 'fuzzy') {
    container.replaceChildren(
      h('p', { class: 'hint' }, `查無「${query.trim()}」，您要找的是不是：`),
      ...r.candidates.map((c) => plateCard(c.record, 'candidate'))
    );
  } else {
    container.replaceChildren(
      h('div', { class: 'notfound' }, h('strong', {}, '查無資料'), h('span', {}, query.trim().toUpperCase() || '（沒有讀到文字）'))
    );
  }
}

let toastTimer;
export function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}
