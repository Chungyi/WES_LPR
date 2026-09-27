// 呼叫 Apps Script 後端

import { CONFIG } from './config.js';

export const ERROR_MESSAGES = {
  UNAUTHORIZED: '此帳號不在授權登入名單中，請洽系統管理者。',
  INVALID_TOKEN: '登入驗證失敗，請重新登入。（只接受 @' + CONFIG.DOMAIN + ' 帳號）',
  NETWORK: '無法連線到伺服器，請確認網路後再試一次。',
  SERVER_ERROR: '伺服器發生錯誤，請稍後再試，或洽系統管理者。',
  NOT_CONFIGURED: '系統尚未設定後端網址（config.js 的 API_URL）。',
};

export class ApiError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.SERVER_ERROR);
    this.code = code in ERROR_MESSAGES ? code : 'SERVER_ERROR';
  }
}

/** 簡化的裝置描述，寫入「下載紀錄」用，例如「iPhone／Chrome」 */
export function describeDevice(ua = navigator.userAgent) {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : '其他';
  const browser = /CriOS|Chrome\//.test(ua) && !/EdgA|Edg\//.test(ua)
    ? (/SamsungBrowser/.test(ua) ? 'Samsung Internet' : 'Chrome')
    : /Safari\//.test(ua) ? 'Safari' : '其他';
  return os + '／' + browser;
}

/**
 * 下載車牌名單。
 * body 用純文字送出（Content-Type: text/plain），避免跨網域的預檢請求，Apps Script 才收得到。
 */
export async function downloadPlates(idToken) {
  if (!CONFIG.API_URL) throw new ApiError('NOT_CONFIGURED');

  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'download', idToken, device: describeDevice() }),
    });
  } catch {
    throw new ApiError('NETWORK');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('SERVER_ERROR');
  }
  if (!data.ok) throw new ApiError(data.error);
  if (!Array.isArray(data.records)) throw new ApiError('SERVER_ERROR');
  return data;
}
