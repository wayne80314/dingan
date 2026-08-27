/**
 * M0.0 verification sprint — D1 capability probes.
 *
 * These answer schema-design questions that must be settled BEFORE writing
 * M0's migrations, and they have to run against real remote D1 rather than
 * Miniflare: F0 already produced two bugs where the local emulation was more
 * permissive than the real service (R2 accepting unknown-length streams,
 * and a hand-rolled form parser). Same trap applies to SQL feature support,
 * so every answer here comes from the deployed database via the Worker
 * binding -- the same path M0's application code will use.
 *
 * Temporary: delete this module once docs/m0-plan.md records the answers.
 */

import type { Context } from "hono";
import { constantTimeStringEqual } from "./signature";
import type { Env } from "./types";

interface ProbeResult {
  name: string;
  question: string;
  /** What we observed, in plain terms. */
  outcome: string;
  /** What it means for M0's schema. */
  implication: string;
  raw?: unknown;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function quiet(env: Env, sql: string): Promise<void> {
  try {
    await env.DB.prepare(sql).run();
  } catch {
    // Cleanup is best-effort; a failed DROP must not mask a probe result.
  }
}

async function cleanup(env: Env): Promise<void> {
  for (const t of ["_m0_child", "_m0_parent", "_m0_partial", "_m0_batch"]) {
    await quiet(env, `DROP TABLE IF EXISTS ${t}`);
  }
}

/** (e) Does D1 enforce foreign keys through the Worker binding? */
async function probeForeignKeys(env: Env): Promise<ProbeResult> {
  await quiet(env, "DROP TABLE IF EXISTS _m0_child");
  await quiet(env, "DROP TABLE IF EXISTS _m0_parent");

  let pragmaValue: unknown = "(unreadable)";
  try {
    const row = await env.DB.prepare("PRAGMA foreign_keys").first();
    pragmaValue = row ?? "(empty result)";
  } catch (err) {
    pragmaValue = `error: ${errText(err)}`;
  }

  await env.DB.prepare("CREATE TABLE _m0_parent (id TEXT PRIMARY KEY)").run();
  await env.DB.prepare(
    "CREATE TABLE _m0_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES _m0_parent(id))",
  ).run();

  let enforced: boolean;
  let detail: string;
  try {
    await env.DB.prepare("INSERT INTO _m0_child (id, parent_id) VALUES (?, ?)")
      .bind("c1", "nonexistent-parent")
      .run();
    enforced = false;
    detail = "orphan row inserted without error";
  } catch (err) {
    enforced = true;
    detail = errText(err);
  }

  return {
    name: "foreign_keys",
    question: "D1 是否透過 Worker binding 強制外鍵約束？",
    outcome: enforced
      ? `強制。插入孤兒列被拒：${detail}`
      : `不強制。${detail}`,
    implication: enforced
      ? "可以依賴 FK 作為資料完整性的最後防線，但仍需注意 migration 重建表時的順序。"
      : "不可依賴 FK。租戶隔離與參照完整性必須在應用層（DAO）強制，且刪除時要自行處理級聯。",
    raw: { pragmaForeignKeys: pragmaValue },
  };
}

/** (d) Are partial (filtered) unique indexes supported? line_group's
 * "one active binding per LINE group, but keep historical rows" design
 * depends on this. */
async function probePartialUniqueIndex(env: Env): Promise<ProbeResult> {
  await quiet(env, "DROP TABLE IF EXISTS _m0_partial");
  await env.DB.prepare(
    "CREATE TABLE _m0_partial (id TEXT PRIMARY KEY, grp TEXT NOT NULL, status TEXT NOT NULL)",
  ).run();

  try {
    await env.DB.prepare(
      "CREATE UNIQUE INDEX _m0_partial_idx ON _m0_partial(grp) WHERE status IN ('unclaimed','active')",
    ).run();
  } catch (err) {
    return {
      name: "partial_unique_index",
      question: "D1 是否支援帶 WHERE 條件的 partial unique index？",
      outcome: `不支援，建立索引即失敗：${errText(err)}`,
      implication:
        "line_group 無法用「同一 LINE 群組只能有一個 active 綁定、但保留歷史列」的設計，需改用軟刪除欄位加應用層檢查。",
    };
  }

  // Active row occupies the slot.
  await env.DB.prepare("INSERT INTO _m0_partial VALUES (?, ?, ?)").bind("r1", "Cgroup", "active").run();

  let blocksDuplicateActive: boolean;
  let blockDetail = "";
  try {
    await env.DB.prepare("INSERT INTO _m0_partial VALUES (?, ?, ?)").bind("r2", "Cgroup", "active").run();
    blocksDuplicateActive = false;
  } catch (err) {
    blocksDuplicateActive = true;
    blockDetail = errText(err);
  }

  // A historical row for the same group must still be allowed.
  let allowsHistorical: boolean;
  let historicalDetail = "";
  try {
    await env.DB.prepare("INSERT INTO _m0_partial VALUES (?, ?, ?)").bind("r3", "Cgroup", "left").run();
    allowsHistorical = true;
  } catch (err) {
    allowsHistorical = false;
    historicalDetail = errText(err);
  }

  const works = blocksDuplicateActive && allowsHistorical;
  return {
    name: "partial_unique_index",
    question: "D1 是否支援帶 WHERE 條件的 partial unique index？",
    outcome: works
      ? `支援且語意正確。重複 active 被拒（${blockDetail}），同群組的歷史列可共存。`
      : `語意不如預期：擋重複 active=${blocksDuplicateActive}、允許歷史列=${allowsHistorical} ${historicalDetail}`,
    implication: works
      ? "line_group 可照計畫使用 partial unique index：同一 LINE 群組僅一筆 active 綁定，歷史綁定保留可查。"
      : "需改用其他方式保證唯一性（例如把 status 併入索引鍵，或應用層加鎖）。",
  };
}

/** Does db.batch() roll back as a unit? The publish flow writes a snapshot,
 * a nonce and an outbox row together; a partial write there would publish a
 * card nobody can confirm. */
async function probeBatchAtomicity(env: Env): Promise<ProbeResult> {
  await quiet(env, "DROP TABLE IF EXISTS _m0_batch");
  await env.DB.prepare("CREATE TABLE _m0_batch (id TEXT PRIMARY KEY, note TEXT)").run();

  let threw = false;
  let detail = "";
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO _m0_batch VALUES (?, ?)").bind("b1", "first"),
      // Same primary key -- must fail.
      env.DB.prepare("INSERT INTO _m0_batch VALUES (?, ?)").bind("b1", "duplicate"),
      env.DB.prepare("INSERT INTO _m0_batch VALUES (?, ?)").bind("b2", "third"),
    ]);
  } catch (err) {
    threw = true;
    detail = errText(err);
  }

  const rows = await env.DB.prepare("SELECT id FROM _m0_batch ORDER BY id").all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  const rolledBack = ids.length === 0;

  return {
    name: "batch_atomicity",
    question: "db.batch() 中有一句失敗時，整批是否回滾？",
    outcome: `批次${threw ? "拋出錯誤" : "未拋出錯誤"}；事後表中殘留 ${ids.length} 列 [${ids.join(", ")}]。${
      rolledBack ? "＝整批回滾" : "＝部分寫入殘留"
    }${detail ? ` 錯誤：${detail}` : ""}`,
    implication: rolledBack
      ? "publish 流程（snapshot + nonce + outbox）可用單一 batch 保證原子性。"
      : "batch 非原子，publish 流程必須設計成可重入：先寫可重複偵測的鍵，失敗後由 sweeper 補齊，不可假設三筆同生共死。",
  };
}

// ---------------------------------------------------------------------------
// LINE platform probes
// ---------------------------------------------------------------------------

const LINE_API = "https://api.line.me";

function authHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
}

/** (c) `members/count` is documented as generally available while
 * `members/ids` is restricted to verified or premium accounts. Calling the
 * restricted one is what tells us which tier this account is on -- if ids is
 * refused but count works, then count is confirmed usable on an unverified
 * account, which is the case M0 has to design for. */
async function probeMemberApis(env: Env, groupId: string): Promise<ProbeResult> {
  let infoSummary = "(未取得)";
  try {
    const res = await fetch(`${LINE_API}/v2/bot/info`, { headers: authHeaders(env) });
    const body = (await res.json()) as Record<string, unknown>;
    infoSummary = JSON.stringify({
      basicId: body.basicId,
      premiumId: body.premiumId ?? null,
      chatMode: body.chatMode,
    });
  } catch (err) {
    infoSummary = `error: ${errText(err)}`;
  }

  let countStatus = 0;
  let countValue: unknown = null;
  try {
    const res = await fetch(
      `${LINE_API}/v2/bot/group/${encodeURIComponent(groupId)}/members/count`,
      { headers: authHeaders(env) },
    );
    countStatus = res.status;
    countValue = res.ok ? await res.json() : await res.text();
  } catch (err) {
    countValue = `error: ${errText(err)}`;
  }

  let idsStatus = 0;
  let idsBody = "";
  try {
    const res = await fetch(
      `${LINE_API}/v2/bot/group/${encodeURIComponent(groupId)}/members/ids`,
      { headers: authHeaders(env) },
    );
    idsStatus = res.status;
    idsBody = (await res.text()).slice(0, 200);
  } catch (err) {
    idsBody = `error: ${errText(err)}`;
  }

  const countWorks = countStatus === 200;
  const idsRestricted = idsStatus === 403 || idsStatus === 401;

  let implication: string;
  if (countWorks && idsRestricted) {
    implication =
      "確認：members/count 在未驗證帳號上可用（members/ids 被拒證明本帳號非 verified/premium）。recipient_count 可直接由 API 取得，不需要設計師手填人數的降級路徑。";
  } else if (countWorks && !idsRestricted) {
    implication =
      "count 可用，但 ids 也可用 → 本帳號可能是 verified/premium，因此無法證明 count 在未驗證帳號上可用。試點客戶若用自己的未驗證帳號，需重測。";
  } else {
    implication =
      "count 不可用 → M0 需改由儀表板手填群組人數（設計師知道自己群裡幾個人），這是可接受的降級。";
  }

  return {
    name: "member_apis",
    question: "members/count 是否受 verified/premium 限制？",
    outcome: `bot info: ${infoSummary}｜count → HTTP ${countStatus} ${JSON.stringify(countValue)}｜ids → HTTP ${idsStatus} ${idsBody}`,
    implication,
  };
}

/** (b) The outbox design leans on X-Line-Retry-Key to make "we timed out but
 * LINE may already have sent it" recoverable. This checks what actually
 * happens when the same key is replayed after a success -- if LINE silently
 * sends a second copy, the outbox needs a different safety mechanism, and
 * duplicate cards would appear in front of the pilot's own client. */
async function probeRetryKey(env: Env, groupId: string): Promise<ProbeResult> {
  const retryKey = crypto.randomUUID();
  const body = JSON.stringify({
    to: groupId,
    messages: [
      {
        type: "text",
        text: `【M0.0 驗證】重送鍵測試 ${retryKey.slice(0, 8)}｜這則訊息應該只出現一次`,
      },
    ],
  });

  async function send(): Promise<{ status: number; acceptedId: string | null; body: string }> {
    const res = await fetch(`${LINE_API}/v2/bot/message/push`, {
      method: "POST",
      headers: {
        ...authHeaders(env),
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body,
    });
    return {
      status: res.status,
      acceptedId: res.headers.get("x-line-accepted-request-id"),
      body: (await res.text()).slice(0, 300),
    };
  }

  const first = await send();
  const second = await send();

  const deduped = second.status === 409;
  return {
    name: "retry_key",
    question: "X-Line-Retry-Key 重送已成功的請求時，LINE 會怎麼回應？",
    outcome: `第一次 → HTTP ${first.status}（accepted-request-id: ${first.acceptedId ?? "無"}）｜第二次同鍵重送 → HTTP ${second.status}（accepted-request-id: ${second.acceptedId ?? "無"}）${second.body ? ` body: ${second.body}` : ""}`,
    implication: deduped
      ? "LINE 以 409 表示該重送鍵已被處理，不會重複送出。outbox 可安全地在不確定狀態下用同一 retry key 重試，409 視同成功。"
      : `第二次回 ${second.status} 而非 409 → 不能假設重送必被去重。請檢查群組裡是否真的出現兩則訊息，若是，outbox 必須改用「先查詢再重送」或接受重複風險。`,
  };
}

export async function handleM0Verify(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("token");
  if (!token || !constantTimeStringEqual(token, c.env.PANEL_TOKEN)) {
    return c.text("unauthorized", 401);
  }

  const groupId = c.req.query("groupId");
  // The retry-key probe sends real messages into a real group, so it only
  // runs when explicitly asked for.
  const runRetryKey = c.req.query("retryKey") === "1";

  const results: ProbeResult[] = [];
  try {
    results.push(await probeForeignKeys(c.env));
    results.push(await probePartialUniqueIndex(c.env));
    results.push(await probeBatchAtomicity(c.env));

    if (groupId) {
      results.push(await probeMemberApis(c.env, groupId));
      if (runRetryKey) results.push(await probeRetryKey(c.env, groupId));
    } else {
      results.push({
        name: "line_probes",
        question: "-",
        outcome: "略過（未提供 groupId）",
        implication: "加上 ?groupId=C... 執行 LINE 平台探測；再加 &retryKey=1 才會實際送出測試訊息。",
      });
    }
  } catch (err) {
    results.push({
      name: "probe_harness_error",
      question: "-",
      outcome: `探測過程本身失敗：${errText(err)}`,
      implication: "結果不完整，需人工重跑。",
    });
  } finally {
    await cleanup(c.env);
  }

  return c.json({ generatedAt: Date.now(), results });
}
