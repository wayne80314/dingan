# F0 Spike 實測結果

> 測試日期：2026-08-27
> 環境：真實 LINE Messaging API channel、真實群組、兩支真實 LINE 帳號
> Worker：`https://dingan-spike.wayne-7ef.workers.dev`（Cloudflare，APAC）
>
> 本文件記錄的是**實際觀測到的事實**。對「這些行為是否為 LINE 的官方保證」
> 的查證與風險判斷，見文末〈官方保證程度〉。

## 測試設定

| 角色 | 帳號 | 好友狀態 | LINE userId |
|---|---|---|---|
| 設計師 | Wayne | **已加**機器人好友 | `U097bdaa0f1e6b00ea4e9a10ae2146aed` |
| 業主 | 洪米奇 | **從未加**好友 | `Udfbad354770791067b243a5d7552bf7b` |

群組 ID：`C621f11d97b410b70a981ebc51b4c4f93`（3 名成員：機器人＋上述兩人）

「非好友」這個變因是刻意設計的，因為真實世界的業主幾乎不會特地去加設計公司的
LINE 官方帳號為好友——如果產品只在「好友」情境下能識別身分，等於在真實使用場景下失效。

---

## 1. 核心問題：能否識別「誰按了確認」

**結論：可以。兩種確認機制、兩種好友狀態，全數成功識別。**

### 1-a. postback 按鈕（主力方案）

推播 Flex Message，按鈕 `action.type = "postback"`，`data = "confirm:D-001"`。

| 點擊者 | 好友狀態 | 事件是否含 `source.userId` |
|---|---|---|
| Wayne | 已加好友 | ✅ 有 |
| 洪米奇 | **非好友** | ✅ **有** |

非好友點擊的原始事件（節錄）：

```json
{
  "type": "postback",
  "postback": { "data": "confirm:D-001" },
  "webhookEventId": "01M112G87JX1Q5P0V5Z25MBQGF",
  "deliveryContext": { "isRedelivery": false },
  "timestamp": 1787816320847,
  "source": {
    "type": "group",
    "groupId": "C621f11d97b410b70a981ebc51b4c4f93",
    "userId": "Udfbad354770791067b243a5d7552bf7b"
  },
  "replyToken": "f2d7519125784612a455d4bfec3c901b",
  "mode": "active"
}
```

**這解除了整個產品最大的技術風險。** 原先擔心必須退回 LIFF + LINE Login
（需要業主多按一次授權同意畫面）的備案，實測顯示不需要。

### 1-b. message action 按鈕（備援方案）

按鈕 `action.type = "message"`，點擊後代使用者送出「我確認 D-001」文字訊息。

兩支帳號點擊後都產生了帶 `userId` 的 message 事件。**備援方案同樣可行**，
且因為它走的是「使用者主動送出訊息」這條路徑，理論上身分揭露的保證更強。

### 1-c. 累計覆蓋率

| 事件類型 | 含 userId | 缺 userId |
|---|---|---|
| postback | 2 | **0** |
| message | 16（好友 10、非好友 6） | **0** |

樣本數不大，但**沒有觀察到任何一次缺席**。

---

## 2. Profile API：能否取得確認者姓名

`GET /v2/bot/group/{groupId}/member/{userId}`

**12 次呼叫全部成功（HTTP 200），非好友同樣取得 `displayName`。**

這對稽核紀錄很關鍵：光有 `userId`（一串亂碼）在爭議時無法讓人辨認是誰，
必須能對應到顯示名稱。實測顯示非好友也拿得到。

> ⚠️ 注意：`displayName` 是使用者可隨時自行修改的暱稱，不是真實姓名。
> 稽核紀錄必須存「確認當下的顯示名稱快照」，且不能把它當作法律上的身分證明。
> 架構文件已要求另外記錄「聲明的姓名與角色」，這點不變。

---

## 3. 計費模型驗證

推播一次到 3 人群組，`getGroupMemberCount` 回報 `recipientCount: 3`，
LINE 回應 `sentMessages` 一則。

**證實：推播額度按「收件人數」計算，不是按 API 呼叫次數。**

這正是先前架構審查指出、而原始成本模型算錯的關鍵點，現在有真實數據佐證。
`docs/pricing.md` 的推算基礎成立。

---

## 4. 媒體檔案

| 項目 | 結果 |
|---|---|
| 圖片抓取 | ✅ 成功（image/jpeg，435 KB 與 391 KB） |
| 抓取耗時 | 約 480–510 ms |
| R2 儲存 | ✅ 下載回驗證為完好 JPEG，位元組數吻合 |
| 非好友傳的圖 | ✅ 同樣抓得到 |

> 實作註記：過程中發現真實 R2 拒絕長度未知的串流
> （`Provided readable stream must have a known length`），
> 而 Miniflare 的 R2 模擬較寬鬆，導致測試全綠但線上每張圖都失敗。
> 已改為「讀進有上限的緩衝區再儲存」的單一可測路徑，並補上回歸測試。
> 這是 M0 實作媒體管線時務必沿用的作法。

---

## 5. 其他事件行為

| 事件 | 觀測結果 |
|---|---|
| `join`（機器人被加入群組） | ✅ 捕獲，`source` 無 userId（合理，這不是個人行為） |
| `memberJoined` | ✅ 捕獲 2 次 |
| `unsend`（訊息收回） | ✅ 捕獲，含 userId 與被收回的 `messageId` |
| `messageEdited`（訊息編輯） | ⚠️ **未能測試**（見下） |
| redelivery / 亂序 | 22 個事件中 0 次，測試期間未觸發 |
| 簽章驗證 | ✅ LINE Console 的 Verify 通過 |

### 關於 `messageEdited`

實測時發現**LINE 的訊息編輯功能並非所有帳號都有**，測試帳號無此功能因此無法觸發。

這本身是有價值的發現：`messageEdited` 事件在真實世界的出現率，會比架構文件原先
假設的低很多。「訊息被事後編輯導致決策卡佐證遭竄改」的風險，實際威脅程度小於預期。

M0 仍應實作 `messageEdited` 的版本化處理（成本低、且功能可能逐步開放給更多帳號），
但可以降低其優先序，不必當作首要威脅來設計。

---

## 6. 尚未驗證的項目

| 項目 | 為何重要 | 狀態 |
|---|---|---|
| 使用者**封鎖**機器人後點擊按鈕 | 業主可能因為嫌吵而封鎖官方帳號，但仍留在群組 | ⏳ 待測 |
| LINE **PC 版**點擊 | 部分業主習慣用電腦版 | ⏳ 待測 |
| 使用者**改暱稱**後的 displayName 更新時機 | 影響稽核紀錄的姓名快照準確度 | ⏳ 待測 |
| 一個群組能否加入**多個官方帳號** | 若設計公司已有自己的 OA，可能無法再加「定案」 | ⏳ 待測 |
| 長期運行下的 redelivery / 亂序 | 影響冪等設計的必要性 | ⏳ 需長時間觀察 |

---

## 官方保證程度

### 裁決：**實務可靠，但無明文保證** — 可以做，但必須防禦性設計

這是本次 F0 最重要、也最違反直覺的一項結論：**實測全數成功，但官方規格說它不該成功。**

#### 官方規格怎麼寫

LINE Messaging API Reference 的 Source group chat 段落，以及官方 OpenAPI spec
（`line/line-openapi` → `webhook.yml`）對 `userId` 的描述：

> "ID of the source user. **Only included in message events.**
> Only users of LINE for iOS and LINE for Android are included in `userId`."

- `GroupSource.required` 只有 `[type, groupId]`——**`userId` 是選填**，官方各語言 SDK 因此一律將其型別標為 nullable。
- 加重因素：該 spec 於 **2025-04** 修訂過 source 的 required 欄位（補上 `type`），
  卻**沒有**把 `userId` 升為必填。這是選擇，不是遺漏——「文件過時可忽略」的說法站不住腳。
- 前例：LINE 曾於 **2025-01** 直接移除某 webhook 事件的整個 `source` 屬性，
  預告期僅 19 天。LINE 有更動 source 結構的前科。

**postback 不是 message event**，所以我們觀測到的行為屬於**未文件化的實作細節**，
不是契約保證。LINE 可以在任何版本收斂回文件敘述，而且不算 breaking change。

#### 有明文保證的部分 ✅

非好友／已封鎖仍可查詢群組成員 profile，**這是官方白紙黑字的承諾**：

> "You can get the profile information of users in the same group chat,
> **regardless of whether they have added your LINE Official Account as a friend,
> or blocked** your LINE Official Account."

所以 §2 的 12/12 成功不是僥倖，是官方設計行為。

> ⚠️ 別搞混另一支 API：`GET /v2/bot/group/{groupId}/members/ids`（列舉全體成員）
> 明文限定 **verified 或 premium 帳號**才能用。產品設計不可建立在這支 API 上。

#### 已知會導致 userId 缺席的情境

| 情境 | 證據等級 | 台灣裝修業實務機率 |
|---|---|---|
| A. 從未用過 iOS/Android 版 LINE 的純 PC 帳號 | 官方明文 | **< 0.1%**（2020/04 起已無法新辦 PC 帳號） |
| B. 點擊當下用戶端為電腦版 | **已實測排除** ✅ | — |
| C. LINE 未來收斂回「僅 message event 帶 userId」 | spec 有據、無時程 | 產品週期內約 **5–15%**，可能僅數週預告 |
| D. LINE ≤ 7.4.x 舊版用戶端 | 2017 官方公告 | ~0% |
| E. ~~room（多人聊天）而非 group~~ | **已實測排除** ✅ | 見下方說明 |

**情境 B 已由實測排除**：Wayne 的帳號（曾用過手機版）從 LINE 電腦版點擊 postback，
`source.userId` 依然存在。這確認了官方那句話應作「帳號歷史」解讀，而非「點擊當下的用戶端」。
原先評估中「10–30% 的確認會失去身分」這個災難級風險**不成立**。

**情境 E 也已由實測排除**：本次測試所用的對話，建立時其實是**多人聊天**而非正式群組
（現行 LINE 已將兩者統一，差別僅在能否編輯對話名稱）。而本次捕獲的
**28 個事件全部是 `source.type = "group"`，對話 ID 為 `C` 開頭**（群組前綴），
沒有任何一個以 `room` / `R` 形式送達。

換言之，`room` source 在現行 LINE 中已是歷史遺留形態。M0 仍應防禦性地同時處理
`groupId` 與 `roomId`（成本極低），但「業主用多人聊天導致程式失效」的風險實務上不成立。

#### 對 M0 產品的具體要求

1. **可見回執（最高 CP 值）**：每次確認立即在群組 reply「✅ {姓名} 於 08/27 14:03 確認 D-001」。
   這一招把「缺 userId、webhook 遺失、伺服器當機、他人代按」全部從**沉默失敗**轉為**可見失敗**。
2. **schema 先認錯**：`confirmed_by_user_id` 必須 nullable，並額外記錄
   `identity_source`（postback／member_profile／liff_id_token）與 `identity_confidence`。
   缺 userId 時標記為顯性的 `UNIDENTIFIED`，並自動 reply 請該業主改用**文字訊息**回覆確認
   （message event 是唯一有書面保證帶 userId 的事件類型）。**絕不可靜默丟棄。**
3. **確認當下即固化姓名**：確認瞬間就呼叫 member profile 存下 displayName 快照。
   成員退群或 OA 離群後補查會得到 404。
4. **postback data 加固**：目前的 `confirm:D-001` 無 nonce、無群組綁定，
   可被轉傳與重放。應改為「決策 ID + 一次性 nonce」，並在伺服器端驗證
   `source.groupId` 等於該決策綁定的群組。
5. **LIFF + LINE Login：保留但不全面採用**。全面採用會殺死「群組內一鍵確認」的核心體驗。
   採三段觸發：(a) 偵測到 userId 缺席時降級；(b) 高風險決策（追加預算、驗收）強制走
   LIFF ID token（可驗簽、強度最高）；(c) 專案啟動時一次性綁定業主 userId 白名單。
6. **合成監控**：內部測試群每日自動推卡並自動點擊，對每筆真實 postback 記錄 `has_userId`；
   一旦出現 false 立即告警。這是 LINE 悄悄改行為時，唯一能當天發現的手段。
7. **記錄 provider／channel id**：user ID 因 provider 而異，換 provider 會讓歷史稽核靜默失去對應。

### 仍待實測（按風險排序）

| # | 項目 | 為何重要 |
|---|---|---|
| 1 | **卡片轉傳與重放** | 卡片被轉傳到別的群組後點擊會怎樣？`data` 能否無限重放？ |
| 2 | **退群後補查 profile** | 驗證「當下固化姓名」是必要而非可選 |
| 3 | **封鎖狀態下點擊** | 官方保證 profile 可查，但 postback 行為未實測 |
| 4 | **重複點擊／redelivery** | 同鈕連點的 `webhookEventId` 行為，冪等設計的依據 |

以上皆屬 M0 實作階段要處理的細節，**不構成「做不做」的決策門檻**——
技術可行性已由本次實測確立。
