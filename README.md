# 定案 — F0 Spike 工具包

「定案」是給台灣室內設計公司用的 LINE 機器人構想：進駐設計師×業主的 LINE 群組，記錄討論、把重要決定變成「決策卡」推播給業主按鈕確認，完工時匯出決策總表與追加減帳明細。

## 專案狀態：F0 已結案，兩道門檻皆通過 ✅

開工前刻意設下兩道門檻，現在都過了：

| 門檻 | 結果 |
|---|---|
| **技術可行**——群組裡點確認鈕能否穩定識別是誰按的 | ✅ 真實環境實測通過，詳見 [`docs/spike-results.md`](./docs/spike-results.md) |
| **有人願意付錢**——至少一家設計公司付訂金或簽意向 | ✅ 已有一家設計公司完成 |

技術驗證的核心結論：postback 按鈕在好友／非好友、手機／電腦版所有情境下都能取得
`userId`，**但這是 LINE 未文件化的行為**（官方 spec 明寫 `userId` 只在 message event
出現、且非必填）。因此產品可以建立在它之上，但 `userId` 必須全程當 nullable，
並以「群組內可見回執」把任何身分缺口從沉默失敗轉成可見失敗。

## 目錄

1. **`spike/`** — F0 技術驗證工具。一個 Cloudflare Worker，捕獲真實 LINE 群組的所有
   webhook 原始事件並自動分析。已部署且完成任務，保留作為未來回歸驗證與合成監控的基礎。
2. **`docs/`** — 架構藍圖、定價模型、試點計畫、個資告知範本，以及 F0 實測結果。
3. **`assets/line-brand/`** — LINE 官方帳號的品牌素材：
   `dingan-profile-640.png`（大頭貼，640×640）、
   `dingan-background-1920x1080.jpg`（官方帳號主頁背景）。
   主色 `#1f7a4d`，與 `pitch/index.html` 一致。

## 從這裡開始

- **要開工做產品** → [`docs/m0-plan.md`](./docs/m0-plan.md) ← 分階段實作計畫，含第一個里程碑的完整 schema 與流程規格
- **想知道技術驗證測出什麼** → [`docs/spike-results.md`](./docs/spike-results.md)
- **要看正式產品規格** → [`docs/architecture.md`](./docs/architecture.md)、[`docs/pricing.md`](./docs/pricing.md)、[`docs/privacy-notice.md`](./docs/privacy-notice.md)
- **要重跑或擴充 Spike** → [`RUNBOOK.md`](./RUNBOOK.md)、[`docs/spike-protocol.md`](./docs/spike-protocol.md)
- **要找更多設計公司談試點** → [`pitch/index.html`](./pitch/index.html)、[`docs/pilot-plan.md`](./docs/pilot-plan.md)
