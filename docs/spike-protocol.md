# F0 Spike 測試協定

目的：用兩支真實 LINE 帳號在真實群組裡跑一遍，回答「點擊確認鈕時，能否穩定識別是誰按的」，以及周邊平台行為問題。全程 30–60 分鐘。跑完看 `/report?token=...&format=html`。

## 事前準備

- 兩支手機 LINE 帳號：
  - **帳號 A（好友）**：加 Spike 的 LINE OA 為好友
  - **帳號 B（非好友）**：**不要**加 OA 為好友，全程保持非好友狀態，除非測試步驟特別要求改變
- 建一個 LINE 群組，把 Spike OA、帳號 A、帳號 B 都拉進去
- 瀏覽器開好 `/panel?token=<PANEL_TOKEN>`（用來推播測試卡）與 `/report?token=<PANEL_TOKEN>&format=html`（隨時重整看結果）

## 記錄方式

每個步驟按順序做，**不要跳步**，因為 `/report` 的 userId 覆蓋率分析是照 `groupId + userId` 分桶，你要能對照「這個 userId 是帳號 A 還是帳號 B」。建議準備一張紙/備忘錄，記錄「第幾步、帳號 A 或 B、做了什麼」，跑完後對照 `/report` 輸出裡出現的 userId 值。

## 測試矩陣

### 1. 基本文字訊息（確認 userId 基準行為）

1. 帳號 A（好友）在群組傳一則文字。
2. 帳號 B（非好友）在群組傳一則文字。
3. 看 `/report` 的「(2) message-action 文字訊息 userId 覆蓋率」——理論上兩者都應該有 userId（LINE 對「使用者主動送出訊息」這件事的 userId 揭露，理論上比 postback 更有保證，但仍要實測）。

### 2. postback 按鈕（核心問題）

用 `/panel` 推播一張 **postback 卡**到這個群組。

4. 帳號 A（好友）點按鈕。
5. 帳號 B（非好友）點按鈕。
6. 看 `/report` 的「(1) postback userId 覆蓋率」，分別對照帳號 A、B 對應的 userId 是否出現、是否為 `(missing)`。

**這是整個 Spike 最關鍵的一步。** 如果帳號 B（非好友）點按鈕後 `/report` 顯示 `(missing)`，代表非好友場景無法用 postback 穩定識別確認者身分。

### 3. message action 按鈕（postback 的候補方案）

用 `/panel` 推播一張 **message action 卡**到同一個群組。

7. 帳號 A 點按鈕（會變成群組裡一則「我確認 D-001」的文字訊息，不是 postback）。
8. 帳號 B 點按鈕，同樣觀察。
9. 對照 `/report` 的「(2) message-action 文字訊息 userId 覆蓋率」中，這兩則「我確認 D-001」訊息是否都帶 userId。

### 4. 封鎖後點按（進階案例）

10. 帳號 A 封鎖 OA（LINE 裡把這個 OA 封鎖）。
11. 用 `/panel` 再推一張 postback 卡（推播本身若對方已封鎖，該收件人不會計費也可能收不到訊息——這也是要觀察的行為之一，注意 `/panel/push` 回傳的 `recipientCount` 與後續 `/report` 的用量，交叉比對「封鎖後是否還算在收件人數內」）。
12. 若帳號 A 仍能在群組裡看到卡片並點擊（群組場景下封鎖 1:1 不一定影響群組內收訊），記錄點擊後的行為。
13. 測完後帳號 A 解除封鎖（避免影響後續步驟）。

### 5. PC 版 LINE 點按差異

14. 用 LINE 桌面版（Windows/Mac）登入帳號 A 或 B，在同一群組點擊一張新推播的測試卡。
15. 對照手機版點擊時的 userId 覆蓋情形是否一致。

### 6. 編輯與收回

16. 帳號 A 在群組傳一則文字，接著在 LINE 內編輯這則訊息的內容。
17. 看 `/report` 的「(3) 結構性事件」裡 `messageEdited` 的 samples，確認事件收得到、payload 長相。
18. 帳號 B 傳一則訊息後立刻「收回」（unsend）。
19. 看 `/report` 的 `unsend` 事件 samples。

### 7. 加入 / 離開群組

20. 把一支第三方測試帳號（或暫時移出再重新加入帳號 B）加入群組，觀察 `join`／`memberJoined` 事件。
21. 讓該帳號離開群組，觀察 `leave`／`memberLeft` 事件。

### 8. 媒體訊息

22. 帳號 A 傳一張圖片、一段短影片到群組。
23. 看 `/report` 的「(4) 媒體抓取成功率」，確認成功率、mime type、耗時是否合理；若失敗看 `error` 欄位（見 RUNBOOK 排查章節）。

### 9. Profile API 與改名

24. 觀察 `/report` 的「(6) Profile API 可用性」，比較帳號 A（好友）與帳號 B（非好友）的 profile 探測成功率／status code 是否有差異。
25. 帳號 A 或 B 改一次 LINE 顯示名稱，然後在群組裡再傳一則訊息（觸發新的 profile 探測）。
26. 幾分鐘後重整 `/report`，看「觀察到改名」表格是否抓到新舊名稱都有記錄到。

### 10. Redelivery / 亂序（被動觀察，非必須主動觸發）

27. 若 Worker 在測試過程中曾短暫離線或回應變慢，LINE 可能會重送同一事件——`/report` 的「(5) redelivery／亂序」會自動統計，不需要特別操作。若想主動測試，可以在推播與點擊密集時段暫時把 Worker 部署降級（例如故意跑一版會噴錯的程式碼幾秒鐘）製造重試，測完記得換回正常版本——**這是進階/選配步驟，不做也不影響核心結論**。

### 11.「一個群組只能有一個 OA」實測

28. 嘗試把第二個不同的 LINE OA（如果你手邊有另一個測試用 channel）加進同一個群組，觀察 LINE 是否允許、或是否有數量限制／行為異常。若手邊只有一個 OA 可測，這步驟可以跳過，改為查證 LINE 官方文件的群組機器人數量限制說明並記錄在此文件的「已知限制」章節（見下）。

## 判讀與決策

跑完全部步驟，看 `/report`：

- **postback 對好友與非好友都穩定帶 userId** → 原方案（postback 按鈕）可行，直接照 `docs/architecture.md` 的確認流程規格開 M0。
- **postback 對非好友會漏 userId，但 message action 對好友/非好友都穩定帶 userId** → 改用 message action（文字訊息點擊），`docs/architecture.md` 的確認流程需要相應調整為「解析特定格式的確認文字」而非「解析 postback data」。
- **postback 與 message action 都無法穩定識別非好友確認者** → 兩者都不可靠，必須改走 **LIFF + LINE Login** 方案：業主點擊卡片內連結開啟 LIFF 頁面，用 LINE Login 完成身分綁定後在頁面內按確認。取捨：
  - 零安裝（LIFF 頁面在 LINE 內建瀏覽器開啟，不需要另外裝 App）
  - 但比純聊天室內按鈕多一次「同意畫面」（LINE Login 的授權同意），部分業主可能覺得多一步驟麻煩，需要在 UX 文案上做好引導
  - 需要在 LINE Developers Console 額外設定 LIFF app，取得 liff.state / LINE Login channel

## 已知限制 / 待補記錄

（跑完 Spike 後，把實測發現的限制或例外行為記在這裡，供 `docs/architecture.md` 修訂時參考。例如：一個群組能否加入多個 OA、封鎖後推播計費行為、非好友 profile API 實際回傳的 status code 等。）
