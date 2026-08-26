# 定案 — F0 Spike 工具包

「定案」是給台灣室內設計公司用的 LINE 機器人構想：進駐設計師×業主的 LINE 群組，記錄討論、把重要決定變成「決策卡」推播給業主按鈕確認，完工時匯出決策總表與追加減帳明細。

完整產品計畫經深度技術審查後，發現最關鍵的未知數是：**LINE 群組裡點擊確認按鈕時，是否保證能穩定識別是誰按的**。在確認這件事之前，不建置產品本體——本 repo 現階段只有兩樣東西：

1. **`spike/`** — 一個 Cloudflare Worker，讓開發者用兩支真實 LINE 帳號在真實群組裡跑一遍測試矩陣，把所有 webhook 原始事件逐字存起來並自動分析。
2. **`docs/`** — 審查修正後固化的架構藍圖、定價模型、試點計畫、個資告知範本，供技術驗證與試點都通過後的正式開發階段直接引用。

## 從這裡開始

- **要動手跑 Spike** → 看 [`RUNBOOK.md`](./RUNBOOK.md)（LINE channel 建立、Cloudflare 部署、逐步操作）
- **要照協定跑測試矩陣** → 看 [`docs/spike-protocol.md`](./docs/spike-protocol.md)
- **要看正式產品規格（門檻通過後才會開工）** → 看 [`docs/architecture.md`](./docs/architecture.md)、[`docs/pricing.md`](./docs/pricing.md)、[`docs/pilot-plan.md`](./docs/pilot-plan.md)、[`docs/privacy-notice.md`](./docs/privacy-notice.md)
- **要找設計公司談試點** → 看 [`pitch/index.html`](./pitch/index.html)

## 目前範圍

本階段刻意**不做**：儀表板、AI 摘要 pipeline、多租戶、金流。全部等 F0 的兩項門檻（技術驗證通過＋至少一家願付訂金或簽付費意向）都過了才開工。
