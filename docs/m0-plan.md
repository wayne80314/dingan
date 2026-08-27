# 定案 M0 實作計畫

> **狀態**：F0 兩道門檻已通過（技術可行性見 [`spike-results.md`](./spike-results.md)；
> 首家設計公司已付訂金／簽意向書，見 [`pilot-plan.md`](./pilot-plan.md)）。
> 本文件是 M0 的開工計畫，由六個子系統平行設計 → 三個角度對抗性審查 → 收斂而成。
>
> **與 [`architecture.md`](./architecture.md) 的關係**：architecture.md 是完整的產品架構規格
> （理想終局），本文件是**在只有一個付費客戶、一人開發的現實條件下**對它做的範圍裁決與排序。
> 兩者衝突時，以本文件為準；architecture.md 中被延後的部分仍是有效的未來方向。

---

## 最高原則

客戶已付訂金在等。第 2 週要讓他的業主在 LINE 上按下確認並看到回執；第 6 週要讓他拿 PDF 去請款。其餘一切讓路。

---

## 1. 範圍裁決

### 做（M0 必須，補做代價極高或客戶下週就要）

| 項目 | 理由 |
|---|---|
| 每表冗餘 `organization_id` + ULID 主鍵 + `getDb(orgId)` 間接層 | 事後是全表遷移，現在成本近乎 0 |
| `decision_snapshots`：推播當下凍結 `canonical_json`+`sha256`（NFC 在寫入時做） | 補算的 hash 無時序意義，整個憑證體系歸零。半天 |
| `confirmations` 指向 `(decision_id, version)` 而非 decision | 歷史列無法回溯 |
| `confirmed_by_user_id` NULLABLE + `identity_source`/`confidence`/`resolution_status` | userId 缺席是產品命脈風險 |
| postback nonce 綁 `(decision, version, action)` + 驗 `source.groupId` + 六道驗證 | 防轉傳重放的唯一機制 |
| 群內可見回執（reply 優先） | 全設計最高 CP 值，一次免費 API 呼叫 |
| outbox + `dedupe_key` UNIQUE + `X-Line-Retry-Key` | 重複洗卡是在他的業主面前發生 |
| `decision_line_items` 明細行 | 「追加 35,000」不拆項業主不付錢 |
| 圖片下載入 R2（readCapped→Uint8Array） | LINE content 有保存期，第一天沒抓就永遠沒有 |
| has_userId 被動監控（一個 boolean + 一句 query） | LINE 悄悄改行為時唯一能當天發現的手段 |
| 個資告知：bot 入群第一則 reply 告知 + 存 `consent_event_id` | 零技術成本，漏了會出事（個資法第 8 條） |
| 驗章失敗寫 `dead_letters` + raw body 先進 R2 | 目前設計中最致命的靜默全損路徑 |
| 額度**硬擋** + 每日用量信 | dashboard 說軟擋、reliability 說硬擋 → 裁決：硬擋。並直接買中用量方案（NT$800/3,000 則），不用免費額度賭 |

### 延後（M1/M2，純加法）

驗證頁三層＋QR＋unlock code＋金鑰撤銷（M0 只印 hash 與附 `manifest.json`，**不印會 404 三個月的 QR**）；LINE Login OAuth＋PKCE＋session 輪替（M0 用 Cloudflare Access）；綁定碼全套；LIFF 三段觸發（僅保留降級偵測旗標）；Cloudflare Queues（waitUntil + cron sweeper）；額度降級階梯／全域三閘／Analytics Engine 告警；Flex 即時預覽（改「推到 Wayne 測試群預覽」，1 則額度、100% 準確）；時間軸 shift 範圍選取／左表單右原文並排；org 邀請／角色／entitlement 自助訂閱；RFC 3161 時戳與 Merkle 錨定；附件縮圖。

### 不做（明確否決）

| 項目 | 裁決理由 |
|---|---|
| **文字確認的 STRONG 路徑＋否定黑名單** | 站 scope-realism 這邊。手寫正則當中文意圖分類器來決定法律意義的確認，誤判「確認一下」＝打穿產品核心。**只留 WEAK**：任何疑似同意 → reply 一張 Yes/No 卡導回 postback。一條路徑、免費、嚴格更安全 |
| **SQLite immutability triggers** | D1 支援度未驗證，且與重建型 migration 交互是最易錯的一步。改 DAO 層 `assertUnlocked()` + 每日 hash 校驗 cron |
| **AI digest 與 `定案 今日`** | digest 砍對了（幻覺風險＋境外傳輸告知缺口）；`定案 今日` 一併砍——它要指令解析卻不解決付費痛點，而額度降級改用硬擋後也不再需要它當降級目標 |
| **`card_version` 雙表** | 一家客戶不需要 draft 版本鏈。改 `decisions` 單表（`version` 整數）+ `decision_snapshots`（**只在 publish 當下**寫一列不可變快照）。draft 隨便改不產生垃圾，confirmation 綁 `(decision_id, version)`，export 的 `D-007@2` 語意直接成立 |
| **綁定碼機制** | `join` 事件天然帶 groupId，不需 regex、不需搶用防護。改「join → 儀表板未認領清單 → 一鍵認領到 project」，同樣有「回儀表板確認群組名」這道防線，且天然實現「未認領期間不落地訊息內容」 |
| **合成自動點擊監控** | reliability 是對的，LINE 不提供程式觸發 postback。改被動 has_userId 比例 + 每日 09:00 人工 heartbeat（3 秒成本） |

### 整合衝突的最終裁決（一次講死）

1. **金額一律 INTEGER「分」**，欄位一律 `_cents` 結尾；export 渲染層除 100。`quantity_milli` 千分位整數，canonical JSON 序列化為字串 `"2.500"`（固定三位小數）。
2. **逐行捨入後加總**：`line_total_cents = round_half_up(quantity_milli × unit_price_cents / 1000)`，追減以負數存同一欄位。
3. **成員表只有一張** `group_members`，grain = `(line_group_id, line_user_id)`，冗餘 `project_id`/`organization_id`。`recipient_count` 與「指定確認人」下拉都讀它。
4. **記帳只有一個時點**：outbox push 成功後寫 `usage_ledger`（PK = outbox_id，天然冪等）。enqueue 時只做預估顯示，不扣帳，因此不需要退帳路徑。
5. **confirmation UNIQUE**：`(decision_id, version, confirmed_by_user_id) WHERE confirmed_by_user_id IS NOT NULL`（一人一票，不含 action；改票只能由設計師開修訂卡）+ `webhook_event_id` 全域 UNIQUE（擋重送，含 UNIDENTIFIED 路徑）。
6. **命名**：表名一律單數 snake_case（`decision`、`confirmation`、`line_message`）。動作欄位一律叫 `action`。
7. **CHECK 值域補齊**：`identity_source` 含 `postback_no_uid`；`resolution_status` 含 `revoked`、`late`、`superseded`。
8. **audit chain 不即時串接**：即時只寫 append-only `audit_event`（無 prev hash），每日 cron 單一寫入者計算當日 chain root 存 `audit_daily_root`。避開夫妻雙簽併發分叉。
9. **白名單信心分級**：`whitelist_source='designer_assigned'` 一律標 `identity_confidence='asserted'`，**不得**標 `whitelisted`。只有本人透過成員登記卡自述才是 `whitelisted`。PDF 上兩者分開呈現。

---

## 2. 里程碑序列

### M0.0 — 驗證衝刺（2 天，不寫任何 schema）

三項各能作廢掉一週設計：(a) LINE Login/LIFF channel 與 Messaging channel 同 provider 時 `sub` 是否等於 messaging userId（**開 channel 是不可逆設定，即使 M0 不做 Login 也必須先驗、先選對 provider**）；(b) `X-Line-Retry-Key` 重送已成功請求的回應碼與保存期；(c) `GET /group/{id}/members/count` 是否受 verified 限制。順帶：D1 partial unique index、`PRAGMA foreign_keys`。
**客戶端變化**：無。這兩天不可省。

### M0.1 — LINE 迴路打通（2 週）

**交付**：Wayne 用 SQL 建卡 → bot 推 Flex 決策卡到真實群組 → 業主點確認 → confirmation 落庫 → 群內 3 秒內出現「✅ 陳大明 於 08/27 14:03 確認 D-001」→ 儀表板（Cloudflare Access 保護的單頁）看得到卡片列表與確認明細（含 identity 徽章）。訊息與圖片全量入庫／入 R2。CSV 匯出。
**為何這個順序**：這是唯一不能由 Wayne 手工代替的一圈——業主在現場那一秒必須是軟體。其餘全部可以是 Wayne + wrangler。
**工作量**：10 個工作天。
**客戶能多做什麼**：第 2 週起，他的業主開始真的在 LINE 裡按確認，他在儀表板看得到誰在何時確認了什麼。**這就是他付錢買的東西。**

### M0.2 — 建卡自助化與金額明細（2 週）

**交付**：`decision_line_items` 明細表；儀表板建卡表單（時間軸 checkbox 多選 → modal 表單 → 品項表格 → 儲存草稿 →「推播到群組」二次確認 dialog）；修訂卡鏈（已確認卡只能開 `D-001-R1`）；`required_approval_count` 夫妻雙簽（回執明寫 `1/2，尚待陳美華`）；成員登記卡建白名單；群組 join → 認領流程。
**工作量**：10 天。
**客戶能多做什麼**：設計師自己建卡，Wayne 退出日常操作。追加項目拆到品項層級，業主看得懂。

### M0.3 — 請款文件（2 週）

**交付**：Browser Rendering PDF（A4 橫式追加減帳明細 + A4 直式決策總表，共用模板與 print CSS）；`manifest.json` + ECDSA 簽章 + `.well-known/dingan-keys.json`；法律定位文案與身分揭露聲明；`export_job` 表 + cron。
**為何排這裡**：PDF 只需趕上客戶第一次請款，通常還有 4–8 週。這是最大的喘息空間，別花在第 1 週。
**工作量**：8–10 天（CJK 字型是主要未知數）。
**客戶能多做什麼**：把「追加減帳明細表」當請款附件寄給業主。這是第二個付費理由。

### M0.4 — 硬化與緩衝（2 週）

回執未送達告警、額度硬擋與每日用量信、跨 org 越權測試、`retention_until` 欄位與隱私政策頁、每日 hash 校驗 cron、人工 heartbeat。以及**留給客訴與改需求的 20–30%**。

---

## 3. M0.1 詳細規格

### 檔案結構

```
/Users/wayne/somethingcool/
├── migrations/0001_init.sql
├── wrangler.hook.jsonc          # dingan-hook → hook.dingan.tw
├── wrangler.app.jsonc           # dingan-app  → app.dingan.tw（Cloudflare Access）
├── src/core/                    # 兩個 worker 共用
│   ├── db.ts                    # getDb(orgId) / withOrg(orgId) — 第一天就要有
│   ├── ids.ts money.ts canonical.ts   # ULID / 分與逐行捨入 / NFC+JCS+sha256
│   ├── line.ts                  # reply push getMemberProfile getContent
│   └── outbox.ts                # enqueue / dispatch / lease
├── src/hook/
│   ├── index.ts verify.ts route.ts    # 驗章 / 訊息路由
│   ├── postback.ts              # 六道驗證
│   └── consume.ts               # step 冪等處理（persist/media/profile/receipt）
├── src/app/index.ts + api/*.ts
├── web/                         # React + Vite SPA
└── scripts/smoke/               # 真實環境冒煙腳本
```

### D1 schema（0001_init.sql，13 表，關鍵欄位）

```sql
CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, tax_id TEXT,
  line_provider_id TEXT NOT NULL, line_channel_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei', created_at INTEGER NOT NULL);

CREATE TABLE project (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  name TEXT NOT NULL, client_name TEXT, site_address TEXT, contract_no TEXT,
  contract_amount_inc_tax_cents INTEGER, tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  tax_rate_bp INTEGER NOT NULL DEFAULT 500, card_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', retention_until INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE line_group (id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT,
  line_provider_id TEXT NOT NULL, line_channel_id TEXT NOT NULL,
  line_group_id TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'owner',
  group_name_snapshot TEXT, member_count_manual INTEGER,
  status TEXT NOT NULL DEFAULT 'unclaimed',   -- unclaimed|active|left|revoked
  liff_required INTEGER NOT NULL DEFAULT 0,
  consent_event_id TEXT, consent_sent_at INTEGER,
  joined_at INTEGER, claimed_at INTEGER, claimed_by TEXT);
CREATE UNIQUE INDEX idx_grp ON line_group(line_provider_id, line_group_id)
  WHERE status IN ('unclaimed','active');

CREATE TABLE group_member (line_group_id TEXT NOT NULL, line_user_id TEXT NOT NULL,
  organization_id TEXT, project_id TEXT, role TEXT NOT NULL DEFAULT 'unknown',
  declared_name TEXT, display_name_last_seen TEXT, display_name_synced_at INTEGER,
  identity_confidence TEXT NOT NULL DEFAULT 'seen_before',  -- whitelisted|asserted|seen_before|unknown
  whitelist_source TEXT, first_seen_at INTEGER, left_at INTEGER,
  PRIMARY KEY(line_group_id, line_user_id));

CREATE TABLE decision (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  decision_no TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL, change_scope TEXT, change_reason TEXT, category TEXT,
  tax_mode TEXT NOT NULL, tax_rate_bp INTEGER NOT NULL,
  amount_ex_tax_cents INTEGER NOT NULL DEFAULT 0, amount_tax_cents INTEGER NOT NULL DEFAULT 0,
  amount_inc_tax_cents INTEGER NOT NULL DEFAULT 0, schedule_delta_days INTEGER NOT NULL DEFAULT 0,
  required_approval_count INTEGER NOT NULL DEFAULT 1, risk_level TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'draft',      -- draft|pending|confirmed|rejected|expired|withdrawn
  line_group_id TEXT, source_line_message_ids TEXT,
  supersedes_id TEXT, superseded_by_id TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  published_at INTEGER, decided_at INTEGER, expires_at INTEGER);
CREATE UNIQUE INDEX idx_dec_no ON decision(project_id, decision_no);

-- publish 當下寫一列，永不 UPDATE
CREATE TABLE decision_snapshot (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL, version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_snap ON decision_snapshot(decision_id, version);

CREATE TABLE decision_line_item (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL,
  area TEXT, description TEXT NOT NULL, spec_note TEXT, unit TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL, tax_mode TEXT NOT NULL, tax_rate_bp INTEGER NOT NULL);

CREATE TABLE decision_nonce (nonce TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL,
  bound_line_group_id TEXT NOT NULL, issued_at INTEGER, expires_at INTEGER, invalidated_at INTEGER);

CREATE TABLE confirmation (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL, version INTEGER NOT NULL, line_group_id TEXT NOT NULL,
  action TEXT NOT NULL, channel TEXT NOT NULL,
  confirmed_by_user_id TEXT,                 -- NULLABLE
  identity_source TEXT NOT NULL, identity_confidence TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'resolved',
  display_name_snapshot TEXT, snapshot_source TEXT, declared_name TEXT, declared_role TEXT,
  confirm_text TEXT NOT NULL, content_sha256_at_confirm TEXT NOT NULL,
  line_provider_id TEXT NOT NULL, line_channel_id TEXT NOT NULL,
  line_event_timestamp INTEGER, server_received_at INTEGER NOT NULL,
  webhook_event_id TEXT, nonce_used TEXT,
  receipt_status TEXT NOT NULL DEFAULT 'pending', receipt_delivery TEXT, receipt_sent_at INTEGER,
  created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_cf_evt ON confirmation(webhook_event_id) WHERE webhook_event_id IS NOT NULL;
CREATE UNIQUE INDEX idx_cf_vote ON confirmation(decision_id, version, confirmed_by_user_id)
  WHERE confirmed_by_user_id IS NOT NULL;
CREATE INDEX idx_cf_open ON confirmation(organization_id, resolution_status, receipt_status);

CREATE TABLE line_message (id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT,
  line_group_id TEXT NOT NULL, line_user_id TEXT,
  display_name_snapshot TEXT, role TEXT,     -- AI digest 未來需要，現在順手寫
  message_type TEXT NOT NULL, text_content TEXT,
  r2_key TEXT, media_status TEXT, media_sha256 TEXT, size_bytes INTEGER,
  has_user_id INTEGER NOT NULL,              -- 被動監控
  line_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL,
  webhook_event_id TEXT, unsent_at INTEGER);
CREATE INDEX idx_lm ON line_message(line_group_id, line_timestamp);

CREATE TABLE raw_event (webhook_event_id TEXT PRIMARY KEY, line_group_id TEXT, event_type TEXT,
  ingest_state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER DEFAULT 0,
  next_attempt_at INTEGER DEFAULT 0, lease_until INTEGER DEFAULT 0,
  r2_key TEXT NOT NULL, last_error TEXT, received_at INTEGER NOT NULL);
CREATE INDEX idx_sweep ON raw_event(ingest_state, next_attempt_at);
CREATE TABLE event_step (webhook_event_id TEXT, step TEXT, done_at INTEGER, PRIMARY KEY(webhook_event_id, step));

CREATE TABLE outbox (id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT,
  line_group_id TEXT NOT NULL, kind TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL UNIQUE, retry_key TEXT NOT NULL, payload_json TEXT NOT NULL,
  recipient_count INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', uncertain INTEGER DEFAULT 0,
  attempt INTEGER DEFAULT 0, next_attempt_at INTEGER DEFAULT 0, lease_until INTEGER DEFAULT 0,
  last_status_code INTEGER, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER);

CREATE TABLE usage_ledger (outbox_id TEXT PRIMARY KEY, organization_id TEXT, ym TEXT,
  units INTEGER NOT NULL, kind TEXT, created_at INTEGER NOT NULL);
CREATE TABLE org_usage_counter (organization_id TEXT, ym TEXT, push_units INTEGER DEFAULT 0,
  PRIMARY KEY(organization_id, ym));

CREATE TABLE dead_letter (id TEXT PRIMARY KEY, reason TEXT NOT NULL, raw_sha256 TEXT,
  r2_key TEXT, status_code INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE audit_event (id TEXT PRIMARY KEY, organization_id TEXT, seq INTEGER,
  event_type TEXT, decision_id TEXT, confirmation_id TEXT,
  payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
```

### Webhook 流程（hook worker）

```
1  raw = await req.text()                       # 一定要先讀 raw text，不可先 c.req.json()
2  HMAC-SHA256 定長比對 → 失敗：R2.put(dl/{ts}-{sha}) + dead_letter + 401
3  JSON.parse 失敗 → dead_letter + 200
4  for each event: R2.put(`raw/{eventId}.json`) （R2 與 D1 不會同時倒）
5  db.batch([INSERT INTO raw_event ... ON CONFLICT DO NOTHING])
   → 若 throw：回 5xx（讓 LINE 重送），不可 catch 成 200
6  ctx.waitUntil(handleFast(events))            # postback 預檢 + reply 回執
7  return 200                                   # 目標 p99 < 200ms
```

`handleFast` 只做 1–2 次 D1 讀取後發 reply（token 約 1 分鐘壽命，等不了 cron）。正式入庫由 `consume()` 走 step 冪等。

### 訊息路由優先序（一次定義，避免四個消費者搶同一則）

```
postback  → postback.ts
join/leave/memberJoined/memberLeft → group lifecycle（join 時發個資告知 reply）
message.text:
  1. line_group.status='unclaimed' → 只寫 raw_event，不寫 line_message（隱私閘門在同步路徑）
  2. 疑似同意（含意圖詞）且該群恰有 1 張 pending 卡且推播 <30 分鐘 → reply Yes/No 卡（WEAK）
  3. 其餘 → 入 line_message
message.image → 入庫 + media step
```

### postback 六道驗證（順序不可調）

```
0. if (!event.source.userId) → 走 UNIDENTIFIED 路徑（見下）
1. nonce 存在、未 invalidate、未過期
2. nonce.version === decision.version
3. event.source.groupId === nonce.bound_line_group_id   ← 防轉傳核心
4. decision.status === 'pending'（若已 expired → 仍寫入，resolution_status='late'，reply 說明）
5. userId ∈ group_member 且 role/白名單允許（否則 reply 不指責的說明，不計為確認）
6. INSERT confirmation（撞 UNIQUE 即冪等 no-op）
→ 達 required_approval_count 才轉 confirmed；reject 立即生效不等其他人
```

**UNIDENTIFIED 路徑**：寫 confirmation（`confirmed_by_user_id=NULL, identity_source='postback_no_uid', resolution_status='unidentified'`），卡片**不進 confirmed**，reply「⚠️ 收到確認點擊但無法識別身分，請確認人直接在群組打一句：我確認 D-003」，同時 `line_group.liff_required=1`（保險絲），並告警。

### 回執

```
✅ 已記錄確認
D-003 廚房電路追加（v2）
確認人：陳大明（業主）  時間：08/27 14:03
狀態：1/2 已確認，尚待 陳美華
```
reply 失敗 → `receipt_delivery='push_fallback'` 走 outbox。**`receipt_status != 'sent'` 且 age > 90 秒 → 儀表板紅字「回執未送達」，這是第一級告警，優先於 has_userId。**

### API（app worker，Cloudflare Access 保護）

```
GET  /api/groups/unclaimed                     → join 過但未認領的群組（含 groupName、貼碼者）
POST /api/groups/:id/claim  {projectId,purpose,memberCount}  → status='active'，bot reply 已啟用
POST /api/groups/:id/dismiss {leave:boolean}   → 取消，可選退出群組
GET  /api/projects/:id/decisions               → 列表（狀態、金額、確認進度 n/N）
POST /api/projects/:id/decisions               → 建 draft（M0.1 可由 SQL 代替）
POST /api/decisions/:id/publish                → 原子：寫 snapshot + 發 nonce + 寫 outbox + waitUntil(dispatch)
GET  /api/decisions/:id                        → 版本、明細、confirmations（含 identity 徽章）
GET  /api/projects/:id/export.csv              → UTF-8 with BOM
GET  /api/health/user-id-rate                  → 7 日滾動 has_userId 比例
```

---

## 4. 貫穿全程的工程紀律

**冒煙測試是部署流程的一部分，不是選配。** F0 的兩個 bug（form-urlencoded 解析、R2 拒絕未知長度串流）都是單元測試全綠但線上壞掉。`scripts/smoke/` 每次 deploy 後對 **preview 環境的真實 LINE 群組**自動跑：推一張卡 → 驗 Flex 送達 → 上傳一張圖 → 驗 R2 物件 size 與 sha256 → 驗 webhook 簽章自檢。不過不上 production。**Miniflare 綠燈不算數的規則寫進 CLAUDE.md。**

**必須寫自動化測試**（會靜默算錯或無法人工察覺）：`money.ts` 逐行捨入與含稅／未稅換算（含負數追減）；`canonical.ts` 的 NFC + JCS 序列化穩定性（同輸入跨程序同 hash）；postback 六道驗證的每一條失敗分支；outbox 租約併發（兩個 dispatcher 只有一個 `meta.changes===1`）；confirmation 冪等（同 event 重送不產生第二列）；**跨 org 越權**——對每個 route 用 B org session 打 A org id 斷言 404，**M0.1 就要寫，只有一個客戶時不寫之後永遠不會寫**。

**手動驗證即可**：SPA 版面、Flex 外觀、PDF 排版、Cloudflare Access 設定。

**部署與回滾**：兩個 worker 獨立部署（儀表板改版不得讓 webhook 抖動）。`wrangler versions upload` → 冒煙 → `versions deploy` 漸進，出事 `wrangler rollback` 一鍵。**migration 只追加不修改**，已 apply 的檔視同唯讀；加欄位與回填分兩個檔（D1 跨檔非原子），回填走 cron 分批不寫在 migration 裡。每次 deploy 前 `wrangler d1 export` 一份到 R2（D1 資料量小，這是最便宜的保險）。

**userId 缺席永遠可見**：`line_message.has_user_id` 每則都記；每日 cron 算 7 日滾動比例，< 100% 立即推 Wayne 的 LINE。每日 09:00 推一張測試卡到內部群，24 小時內無 heartbeat 即告警。

---

## 5. 未解問題（依重要性）

1. **LIFF/Login `sub` 與 Messaging userId 同 provider 一致性** — 開 channel 是不可逆設定，M0.0 第一天必驗。錯了整條降級保險絲失效。
2. **`X-Line-Retry-Key` 重送已成功請求的回應碼與保存期** — outbox 的地基，唯一無法靠自家程式碼保證的環節。
3. **超額後 LINE push 的實際行為**（回錯還是靜默丟棄）— 若是後者，決策卡推不出去而系統以為送成功。必須第一週實測。**同時決定：是否第一天就買中用量方案**（我的建議是買，NT$800 買掉整類風險）。
4. **Browser Rendering 的 headless Chrome 是否有 CJK 字型** — 判斷「很可能沒有」，`@font-face`（subset Noto Sans TC 放 R2 同源）+ `await document.fonts.ready` 是備妥的解法，M0.3 第一天驗。
5. **`members/count` 是否受 verified 限制** — 影響 `recipient_count`。若受限，M0 用儀表板手填人數（設計師知道自己群裡幾個人），這是可接受的降級。
6. **台灣裝修報價單的捨入實務** — 直接跟試點客戶要兩三份既有報價單反推，比任何推論可靠。順便確認他慣用含稅還是未稅（M0 不支援同一份文件混用，混用即擋下報錯）。
7. **電子簽章法 2024 修正後的條次** — export 的法律文案送客戶前請律師確認並補條號。
8. **隱私政策與保存期限** — `retention_until` 建議完工後 5 年。「不可變稽核紀錄」與業主刪除權的衝突處理程序需律師確認。
9. **語音訊息佔比** — 試點期第一件事就量測。若 > 15%，未來 digest 的價值主張要重估。M0 不受影響（語音只記存在事實）。
