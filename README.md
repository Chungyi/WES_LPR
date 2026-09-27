# WES 校園車牌查詢系統（WES_LPR）

校園違規停車查詢用的手機網頁（PWA）。以學校 Google 帳號登入，先把車牌名單下載到手機，之後的查詢比對都在手機上完成。

- 網址：https://chungyi.github.io/WES_LPR/
- 支援：iPhone 13 以後、Samsung Galaxy S23+ 的 Chrome
- 部署步驟：[docs/部署說明.md](docs/部署說明.md)

## 開發進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| 1 | 登入、授權檢查、資料下載、7 天期限、登出清除、手動查詢、容錯比對、資訊卡與撥號 | ✅ 完成 |
| 2 | 拍照辨識（多車牌） | 規劃中 |
| 3 | 即時辨識、畫面疊加 | 規劃中 |
| 4 | 模型調校 | 規劃中 |

## 檔案結構

```
index.html            主頁面
css/style.css         樣式
js/config.js          設定（用戶端 ID、後端網址、有效天數）← 部署時只改這裡
js/app.js             主程式：畫面、下載、查詢、資訊卡
js/auth.js            Google 登入
js/api.js             呼叫後端
js/store.js           手機端儲存（IndexedDB）與 7 天期限
js/match.js           車牌標準化、完全比對、容錯比對
sw.js                 Service worker（快取程式本身，不快取名單）
manifest.webmanifest  PWA 設定
apps-script/Code.gs   後端，貼到試算表的 Apps Script
```

## 本機測試

```bash
python -m http.server 8080
```

開啟 http://localhost:8080 。這個網址已經加在 Google Cloud 的「已授權的 JavaScript 來源」中，可以直接測試登入。

## 安全設計

- 試算表不分享給任何人，只能透過 Apps Script 讀取。
- 後端會驗證 Google ID Token（簽章、用戶端 ID、網域 `wes.tc.edu.tw`），並檢查「授權登入名單」。
- Email 欄位不會下載到手機。
- 手機上的名單 7 天後失效；登出，或帳號被移出授權登入名單時，會立即清除。
- 本程式庫只有程式碼，**不可以**放入任何名單資料。
