# RUNBOOK — 定案 F0 Spike

給 Wayne 本人操作。程式碼、本地驗證（`npm run typecheck`、`npx vitest run`）已由 agent 完成；**LINE channel 建立與 Cloudflare 部署需要你自己的帳號與金鑰，agent 無法代辦**，以下是逐步操作。

## 0. 你需要準備的東西

- 一個 LINE Developers 帳號、兩支可用的手機門號 LINE 帳號（一支當「有加 OA 好友」的業主、一支當「沒加好友」的業主）
- 一個 Cloudflare 帳號（免費版即可）
- Node.js 20+、`npx`

## 1. 建立 LINE Messaging API Channel

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider（若還沒有）。
2. 在 Provider 下新增 **Messaging API channel**。
3. 進入該 channel 的 **Basic settings** 分頁，複製 **Channel secret**（等等要填進 `.dev.vars` / `wrangler secret`）。
4. 進入 **Messaging API** 分頁：
   - 產生並複製 **Channel access token (long-lived)**。
   - **Webhook URL**：先留白，等 Worker 部署完再回來填（`https://<你的 worker 網址>/webhook`）。
   - 打開 **Use webhook**。
   - **關掉** 「Auto-reply messages」與「Greeting messages」（避免官方自動回覆干擾測試判讀）。
   - 確認「Allow bot to join group chats」是打開的（否則機器人無法被加入群組）。
5. 用你的兩支測試帳號分別加這個 OA 為好友／**其中一支刻意不加好友**——這正是 Spike 要測的變因之一，登記在 `docs/spike-protocol.md` 的測試矩陣裡。

## 2. Cloudflare 帳號設定

```bash
cd /Users/wayne/somethingcool/spike
npm install
npx wrangler login          # 瀏覽器登入你的 Cloudflare 帳號
```

## 3. 建立 D1 資料庫與 R2 bucket

```bash
npx wrangler d1 create dingan-spike
```

指令輸出會包含一個 `database_id`——把它貼到 `spike/wrangler.toml` 裡 `database_id = "REPLACE_AFTER_D1_CREATE"` 那一行，取代掉 placeholder。

```bash
npx wrangler r2 bucket create dingan-spike-media
```

套用 schema（本地與遠端都要跑，遠端才是部署後 Worker 實際用的）：

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## 4. 設定密鑰

**本地開發**：複製範例檔並填入真實值（`.dev.vars` 已被 gitignore，不會進版控）：

```bash
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
# PANEL_TOKEN 自己選一串夠長的隨機字串（例如 openssl rand -hex 24）
```

**部署環境**（`wrangler secret` 會加密存在 Cloudflare，不會出現在 wrangler.toml 裡）：

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put PANEL_TOKEN
```

## 5. 本地跑起來驗證

```bash
npm run typecheck   # 應該 0 error
npx vitest run       # 應該全綠（簽章／冪等／report 分析）
npm run dev           # wrangler dev，本地監聽
```

`wrangler dev` 跑起來後，另開一個 terminal 打 `curl localhost:8787/health`，應該回 `ok`。

本地測 webhook 需要一個能被 LINE 打到的公開網址（wrangler dev 預設只在本機）。最簡單的路是直接部署到 Cloudflare（下一步），用真實網址接 webhook；如果想在部署前先在本機測，可以用 `npx wrangler dev --remote`（讓 Worker 跑在 Cloudflare 邊緣但仍即時同步本地程式碼變更）或自己接 `cloudflared tunnel` / `ngrok` 之類的工具對外曝露本機 port——這兩個都不是本 Spike 程式碼的一部分，照官方文件操作即可。

## 6. 部署

```bash
npm run deploy
```

拿到部署後的網址（形如 `https://dingan-spike.<your-subdomain>.workers.dev`），回到 LINE Developers Console 的 Messaging API 分頁，把 **Webhook URL** 填成 `<那個網址>/webhook`，按 **Verify**（LINE 會送一個測試請求，Worker 應該回 200）。

## 7. 執行測試矩陣

打開 `docs/spike-protocol.md`，照裡面的步驟，用兩支帳號在真實群組裡跑完整套測試（postback／message action／文字／編輯／收回／加入離開群組／傳圖片影片……）。

過程中可以用 `/panel` 一鍵推播測試卡：

```
https://<你的 worker 網址>/panel?token=<PANEL_TOKEN>
```

跑完後看結果：

```
https://<你的 worker 網址>/report?token=<PANEL_TOKEN>&format=html
```

## 8. 常見卡關排查

**Webhook 一直收不到事件 / Verify 失敗**
- 確認 Webhook URL 結尾是 `/webhook`（不是網站根目錄）。
- 確認 channel 的「Use webhook」有打開，「Auto-reply」有關掉。
- 打 `curl -i https://<你的網址>/health`，應該直接回 200 `ok`；如果連這個都失敗，是部署本身的問題，不是 webhook 設定的問題。

**簽章驗證一直失敗（Worker 回 401）**
- 90% 是 `LINE_CHANNEL_SECRET` 貼錯 channel（多 channel 帳號常見）或有多餘空白/換行——用 `wrangler secret put` 重新貼一次，貼的時候不要按 Enter 之外多按東西。
- 確認 Console 上的 channel secret 沒有在你設定完之後被「重新產生」過（重新產生會讓舊值失效）。

**推播回 429 (Too Many Requests) / 額度用完**
- `/panel` 頁面上的用量進度條，基準線是寫死的 200 則／月（LINE 最輕量方案的免費額度），**不是**從 LINE 讀來的即時額度，也不知道你實際開的是輕用量/中用量/高用量哪個方案（見 `docs/pricing.md`）。這條進度條只是 F0 內部粗估的健檢用途，不是官方額度來源——如果你已經開了更高的方案，這條線會提早看起來「爆表」但其實還早。
- 429 的真正原因，請直接去 [LINE Official Account Manager](https://manager.line.biz/) 的帳務／用量頁確認真實剩餘額度；如果額度明明還很夠卻還是 429，通常是短時間內推播太密集觸發的 rate limit（burst），不是月額度問題——把測試步驟間隔拉開一點再試。

**媒體（圖片/影片）抓不到**
- 檢查 `/report` 的 media 區塊的 `error` 欄位；`HTTP 401` 通常是 access token 錯或過期，`truncated_at_10mb_cap` 代表檔案超過本 Spike 設的 10MB 上限（這是刻意的安全上限，不是 bug）。

**profile probe 全部失敗**
- 這有可能就是你要驗證的結果，不是 bug！非好友帳號的 group member profile API 行為本來就是本 Spike 要實測、LINE 官方文件本身也沒寫清楚的項目。先看 `/report` 的 status code 分布，再對照 `docs/spike-protocol.md` 裡當下是哪支帳號、哪個情境在測。

## 9. 結案交接清單

- [ ] LINE channel 建好、webhook 驗證通過
- [ ] Spike Worker 部署完成，`/health` 回 200
- [ ] 照 `docs/spike-protocol.md` 用兩支帳號跑完整套測試矩陣
- [ ] 看 `/report`，確認「誰按了確認」是否能穩定識別 userId——這是唯一決定要不要繼續 M0 的技術門檻
- [ ] 帶 `pitch/index.html` 找 3–5 家設計公司談付費意向（`docs/pilot-plan.md`）
- [ ] 兩項門檻（技術可行 + 至少一家願付訂金/簽意向）都過，才回來以 `docs/architecture.md` 為規格開 M0
