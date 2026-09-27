// Google 登入（Google Identity Services）

import { CONFIG } from './config.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let currentToken = null;
let gisPromise = null;

function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('無法載入 Google 登入元件'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

/** 初始化登入元件；每次使用者完成登入，都會以 ID Token 呼叫 onToken */
export async function initAuth(onToken) {
  await loadGis();
  google.accounts.id.initialize({
    client_id: CONFIG.CLIENT_ID,
    hd: CONFIG.DOMAIN,
    auto_select: true,
    ux_mode: 'popup',
    callback: (resp) => {
      currentToken = resp.credential;
      onToken(resp.credential);
    },
  });
}

export function renderSignInButton(container) {
  container.replaceChildren();
  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'filled_blue',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    locale: 'zh-TW',
    width: 260,
  });
}

/** 解開 JWT 的內容（只用來讀取 email、到期時間，不做驗證；驗證在後端） */
export function decodeJwt(token) {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 目前記憶體中的 ID Token 若還有 1 分鐘以上效期就回傳，否則回傳 null */
export function getValidToken() {
  if (!currentToken) return null;
  try {
    return decodeJwt(currentToken).exp * 1000 - Date.now() > 60_000 ? currentToken : null;
  } catch {
    return null;
  }
}

export function signOut() {
  currentToken = null;
  window.google?.accounts?.id?.disableAutoSelect();
}
