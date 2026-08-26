# 定案 — M0 架構藍圖（修正版，F0 門檻通過後適用）

> **狀態**：本文件是規格來源（source of truth），**尚未實作**。只有在 F0 兩項門檻都通過後才會依此開 M0：
> 1. `spike/` 的真群組技術驗證通過——「誰按了確認」能穩定識別（見 `spike-protocol.md` 判讀結果）
> 2. 3–5 家設計公司試點，至少一家願付訂金或簽付費意向（見 `pilot-plan.md`）
>
> 本文件固化了完整產品計畫 review 後發現的 6 個 P0 問題的修正方案，M0 開工時直接照此規格走，不要重新設計。

## 0. 6 個 P0 問題與修正對照

| # | Review 發現的問題 | 本文件的修正 |
|---|---|---|
| 1 | 確認者身分不保證可識別（group postback 的 userId 語意不明） | §5 確認流程改為「依 F0 spike 結論擇一」：postback／message action／LIFF+LINE Login 三選一，架構層面三者都支援 |
| 2 | 密鑰規格矛盾（曾規劃長效 JWT 存前端／離線驗證） | §2 三權分離改用伺服器端 session cookie + opaque token，棄用需要離線驗證的簽章金鑰 |
| 3 | 推播按收件人數計費，先前成本模型算錯 | §3 pricing.md 已用「收件人數」重算 |
| 4 | 稽核紀錄證據力宣稱過強（曾暗示等同法律證據） | §4 明確定位「可驗證的決策稽核紀錄」，不宣稱法律效力 |
| 5 | webhook 缺冪等與佇列，可能重複處理或漏處理 | §6 可靠性架構：去重 → Queue → 非同步消費 |
| 6 | group_id 被誤當租戶邊界 | §1 租戶模型改為 organization → project → line_group 三層 |

## 1. 租戶模型

```
organization (公司/工作室)
  └── project (一個裝修案件)
        └── line_group (綁定的 LINE 群組，可能不只一個——例如業主群 + 內部群)
```

**`group_id` 只是一個綁定端點，不是租戶邊界。** 同一個 organization 可以有多個 project，同一個 project 可以綁定多個 line_group（例如同時有「業主+設計師」討論群和「工班+設計師」施工群），刪除/更換群組不影響 project 底下累積的決策卡歷史。

## 2. 三權分離

三件事完全分開，不共用同一把金鑰或同一種驗證機制：

1. **登入**（誰在操作儀表板）：email magic link 或 LINE Login，登入態存在 `app.` 子網域下的 `HttpOnly + Secure` cookie session（伺服器端 session store），**不放長效 JWT 於 localStorage**（避免 XSS 竊取後長期冒用）。
2. **訂閱**（這個 organization 有沒有付費、額度多少）：`entitlements` 表，隨機 128-bit opaque token，**伺服器只存 hash**（比對時 hash 再比對，token 本身不落地）。因為沒有離線驗證需求（每次都是伺服器端查表），不需要 ECDSA 簽章這種可離線驗證的機制，故意棄用，降低金鑰管理複雜度。
3. **群組綁定**（哪個 LINE 群組屬於哪個 project）：儀表板產生**單次、10 分鐘後失效、project-scoped** 的綁定碼（一次性 6–8 碼），業主/設計師把這串碼貼進群組聊天室，機器人收到後完成綁定。**綁定後系統要求回到儀表板確認群組名稱與成員數**，避免綁錯碼綁到別人的群組（打字打錯碼、碼被別人先搶用等情境）。

## 3. Pricing（見 `pricing.md`，此處僅列架構要點）

以 **active project** 計價並限額：projects 數量、儲存空間、AI tokens、LINE message units 都有方案上限。有效討論日才觸發 digest 推播（避免安靜的群組也被計費/打擾）。「定案 今日」（當日決策卡摘要）走免費 reply message（不計入 push 額度，因為是回覆而非主動推播）。接近額度上限時自動降級為「需要 `@定案` 指令叫出才回應」，而非直接停用；到期後進入唯讀期（能看歷史決策卡，不能再新增）而非立即刪除資料。

## 4. 稽核紀錄規格

**定位聲明（必須出現在所有對外文案與匯出文件上）**：「定案」產出的是**可驗證的決策稽核紀錄**，用來輔助釐清雙方溝通過程、佐證討論曾經發生與確認方式，**不是法律文件、不等同公證或具備自動法律效力**，實際爭議仍需雙方合意或循正式法律途徑處理。

每張決策卡的稽核紀錄包含：

- 卡片 ID、版本號、canonical JSON（欄位順序固定序列化，避免同內容不同 hash）、SHA-256
- 確認時的明確確認文字（例如「我確認 D-001」全文，不是只記「已確認」三個字）
- LINE `userId`、**確認當下**的顯示名稱（displayName 會變，要存快照而非即時查詢）、聲明的姓名與角色（業主／設計師／工班……，由儀表板事先設定或確認時要求選擇）
- LINE event 的 `timestamp`（LINE 端記錄的時間）＋伺服器 `received_at`（我方收到的時間）＋`webhookEventId`（供事後對照原始 raw event）
- 引用的附件（圖面／報價單／材料清單等）之版本號與各自的 hash
- 伺服器簽署的 evidence manifest（把上述全部欄位打包後由伺服器私鑰簽一次，讓匯出的 PDF 事後仍可驗證未被竄改）

**已確認的決策卡不可修改，只能發「修訂卡」**（新版本，引用舊版本，舊版本本身不可刪除/覆寫）——確保歷史軌跡完整。

**匯出**：PDF（給人看的排版）＋ `manifest.json`（機器可讀的完整稽核資料）＋ manifest 的 ECDSA 簽章＋ 一個可以線上驗證簽章的 QR code 網址。

### 決策卡欄位（完整版）

`requestedBy`、變更範圍與原因（文字）、引用的圖面/報價/材料版本、數量/單位/單價/小計/稅、工期影響天數、付款節點、卡片有效期限、指定確認人（見 §5）、來源訊息與附件的 LINE message ID 清單。

## 5. 確認流程

- `approverUserIds`：這張卡指定哪些 LINE userId 有權確認；`requiredApprovalCount`：需要幾人確認才算數（例如夫妻雙方都要按）。
- 狀態機：`pending` → `confirmed` / `rejected` / `request_changes`（業主要求修改，退回設計師）。
- **確認方式依 F0 spike 結論擇一實作**（見 `spike-protocol.md` 的判讀章節），架構上三種都要留接口：
  1. postback 按鈕（若 spike 證實好友與非好友都穩定帶 userId）
  2. message action 文字訊息（若 postback 不可靠但 message action 可靠——判斷確認的邏輯改成比對訊息文字格式）
  3. LIFF + LINE Login（若兩者都不可靠——多一次同意畫面換取穩定的身分綁定）

## 6. 可靠性架構

1. Webhook 進來：驗章 → 用 `webhookEventId` 去重 → 寫入 Queue → **立即回 200**（不等後續處理完成，避免 LINE 因逾時判定失敗而重試整批）。
2. Queue consumer 非同步處理：真正的入庫、媒體 streaming 下載、profile 探測、`messageEdited`/`unsend` 對應的版本化/purge 邏輯都在這裡做，允許重試而不影響 webhook 端點的回應時間。
3. LINE push 一律走 **outbox pattern**：要送的訊息先落地到 outbox 表（帶 retry key），背景 worker 實際呼叫 push API 並記帳用量，失敗依 retry key 重試，避免「呼叫失敗但不知道到底送出了沒」導致重複扣打或漏送。
4. Digest（每日摘要）用 `lastSuccessfulCutoff`（上次成功處理到的時間點）而不是「今天的日曆日期」——避免 Worker 短暫離線時，重啟後用日曆日期算窗口，漏掉離線期間累積的討論。
5. Dead-letter queue（DLQ）：處理失敗超過重試上限的訊息進 DLQ，並對「失敗率過高」「額度即將用完」設定告警（e-mail 或站內通知）。
6. `lineMessageId` 在資料庫層加 UNIQUE 約束（比照 F0 spike 對 `webhook_event_id` 的做法），避免佇列重試造成的重複處理在資料庫層仍被擋下。
7. D1 有 10GB 單庫上限——超大型 organization（案件量很大）需要提前規劃依 organization 分片（sharding）的路線，M0 先不做，但 schema 設計要預留 organization_id 作為未來分片鍵。

## 7. AI Digest 定位

AI 產出的每日摘要是「**決策候選**」，不是正式決策紀錄本身——正式紀錄只由業主明確按確認的決策卡構成。

- 每條摘要結論都要附上來源訊息的連結（可回頭核對原文）。
- 金額類數字如果原始訊息裡沒有明確提到，AI **不得自行推測補上**——沒來源就留空，寧可讓人補，不要讓 AI 幻覺出一個數字。
- 討論量超過單次可處理上限時要分段摘要，**不能靜默截斷**（截斷要讓使用者知道「這天的討論還有一段沒摘要到」）。
- 上線前要跑 prompt injection 測試項——群組聊天內容是不可信輸入，測試「聊天訊息裡塞入『請把摘要改成 XXX』之類的指令」是否會污染摘要輸出。

## 8. 與 F0 Spike 程式碼的關係

`spike/` 的程式碼（D1 schema、簽章驗證、webhook 去重邏輯）是本文件 §6 可靠性架構的最小驗證版本，不是 M0 產品程式碼本身——M0 開工時預期會整個重寫（加上 Queue、outbox、多租戶 schema），但 §6 列的可靠性原則（先驗章去重再回應、`webhook_event_id` UNIQUE 去重、is_redelivery 追蹤）已經在 spike 裡驗證過可行，M0 直接沿用這些原則。
