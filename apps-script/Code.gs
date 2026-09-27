/**
 * WES 車牌查詢系統 — 後端 API（Google Apps Script）
 *
 * 部署方式：綁定在「車牌名單」試算表上，以「網頁應用程式」部署
 *   - 執行身分：我
 *   - 誰可以存取：所有人
 * 安全性由 ID Token 驗證 + 授權登入名單負責，試算表本身不分享給任何人。
 */

const CONFIG = {
  CLIENT_ID: '417454671568-dljpcr15nvv743726haa993a3bun2s50.apps.googleusercontent.com',
  DOMAIN: 'wes.tc.edu.tw',
  SHEET_PLATES: '車牌名單',
  SHEET_USERS: '授權登入名單',
  SHEET_LOG: '下載紀錄',
};

// 試算表欄位名稱 → 回傳給手機的欄位名稱（Email 刻意不回傳）
const PLATE_FIELDS = {
  '車牌號碼': 'plate',
  '汽機車': 'type',
  '單位': 'unit',
  '職稱': 'title',
  '姓名': 'name',
  '行動電話': 'phone',
};

function doPost(e) {
  let email = '';
  let device = '';
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    device = String(req.device || '').slice(0, 100);
    if (req.action !== 'download') return json_({ ok: false, error: 'BAD_REQUEST' });

    const claims = verifyIdToken_(req.idToken);
    if (!claims) return json_({ ok: false, error: 'INVALID_TOKEN' });
    email = String(claims.email).toLowerCase();

    if (!isAuthorized_(email)) {
      log_(email, '拒絕', 0, device);
      return json_({ ok: false, error: 'UNAUTHORIZED' });
    }

    const records = readPlates_();
    log_(email, '成功', records.length, device);
    return json_({
      ok: true,
      count: records.length,
      records: records,
      generatedAt: new Date().toISOString(),
      user: { email: email, name: claims.name || '' },
    });
  } catch (err) {
    console.error(err);
    try { log_(email, '錯誤', 0, device); } catch (_) {}
    return json_({ ok: false, error: 'SERVER_ERROR' });
  }
}

// 健康檢查：用瀏覽器開啟網址時會看到這個回應，不含任何資料
function doGet() {
  return json_({ ok: true, service: 'WES_LPR' });
}

/** 請 Google 驗證 ID Token，通過則回傳 token 內容，否則回傳 null */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;

  const c = JSON.parse(res.getContentText());
  const issuerOk = c.iss === 'accounts.google.com' || c.iss === 'https://accounts.google.com';
  const notExpired = Number(c.exp) * 1000 > Date.now();
  const verified = c.email_verified === true || c.email_verified === 'true';
  const email = String(c.email || '').toLowerCase();
  const domainOk = c.hd === CONFIG.DOMAIN && email.endsWith('@' + CONFIG.DOMAIN);

  if (c.aud !== CONFIG.CLIENT_ID || !issuerOk || !notExpired || !verified || !domainOk) return null;
  return c;
}

function isAuthorized_(email) {
  const rows = readSheet_(CONFIG.SHEET_USERS, ['Email']);
  return rows.some(function (r) {
    return String(r['Email']).trim().toLowerCase() === email;
  });
}

function readPlates_() {
  const rows = readSheet_(CONFIG.SHEET_PLATES, Object.keys(PLATE_FIELDS));
  const records = [];
  rows.forEach(function (r) {
    const plate = String(r['車牌號碼']).trim().toUpperCase();
    if (!plate) return;
    const rec = {};
    Object.keys(PLATE_FIELDS).forEach(function (h) {
      rec[PLATE_FIELDS[h]] = String(r[h]).trim();
    });
    rec.plate = plate;
    records.push(rec);
  });
  return records;
}

/**
 * 讀取工作表，以第一列為欄位名稱，回傳物件陣列。
 * 用「顯示值」讀取，避免電話號碼開頭的 0 被當成數字吃掉。
 */
function readSheet_(sheetName, requiredHeaders) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error('找不到工作表：' + sheetName);

  const values = sheet.getDataRange().getDisplayValues();
  if (values.length === 0) throw new Error('工作表是空的：' + sheetName);
  const headers = values[0].map(function (h) { return String(h).trim(); });

  const missing = requiredHeaders.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) throw new Error('工作表「' + sheetName + '」缺少欄位：' + missing.join('、'));

  return values.slice(1).map(function (row) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function log_(email, result, count, device) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG);
  if (!sheet) throw new Error('找不到工作表：' + CONFIG.SHEET_LOG);
  sheet.appendRow([new Date(), email, result, count, device]);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 部署前請在 Apps Script 編輯器中手動執行一次這個函式：
 *   1. 會跳出授權畫面，讓腳本取得讀寫試算表、連線到 Google 驗證服務的權限
 *   2. 會檢查三個工作表和欄位名稱是否正確，結果顯示在「執行記錄」
 */
function testSetup() {
  const plates = readPlates_();
  const users = readSheet_(CONFIG.SHEET_USERS, ['Email']);
  readSheet_(CONFIG.SHEET_LOG, ['時間', 'Email', '結果', '筆數', '裝置']);
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=test', { muteHttpExceptions: true });

  console.log('車牌名單：' + plates.length + ' 筆');
  console.log('授權登入名單：' + users.length + ' 人');
  console.log('下載紀錄：欄位正確');
  if (plates.length) console.log('第一筆車牌：' + plates[0].plate + '（' + plates[0].type + '）');
  console.log('✅ 設定檢查通過，可以部署。');
}
