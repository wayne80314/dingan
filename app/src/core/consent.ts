/**
 * The personal-data notice, and the gate that depends on it.
 *
 * Summarising a group's conversation means sending it to Anthropic, outside
 * Taiwan. Article 8 of the PDPA requires the people in that group to be told
 * first — and the obligation falls on the design firm toward its own client,
 * not on us. A tool that starts transmitting before the firm has told anyone
 * has handed them a liability they did not know they took on.
 *
 * So the notice is enforced here rather than described in documentation:
 * `canSummarise` is what digest generation asks, and it answers no until the
 * notice has actually gone out.
 */

import { unscoped } from "./db";
import { enqueue } from "./outbox";
import { getGroupMemberCount } from "./line";
import type { Env } from "./types";

/**
 * Bump when the wording changes in a way that widens what is being disclosed.
 *
 * A group notified under an older, narrower notice is re-notified rather than
 * treated as already covered — consent to one thing is not consent to
 * something broader.
 *
 * v1: recording of messages only (no AI, no cross-border transfer)
 * v2: adds AI summarisation via Anthropic, including overseas transfer
 */
export const CURRENT_NOTICE_VERSION = 2;

export const NOTICE_TEXT = [
  "您好，我是「定案」。",
  "",
  "設計師邀請我加入這個群組，協助把討論中的決定記錄下來，並在完工時整理成決策總表與追加減帳明細。",
  "",
  "【我會蒐集什麼】",
  "本群組的訊息內容、圖片、發言者的 LINE 顯示名稱，以及決策卡的確認紀錄。",
  "",
  "【每日會議記錄與境外傳輸】",
  "為了每天整理一份討論摘要，本群組的訊息內容會傳送至位於美國的 Anthropic（Claude AI）進行處理。",
  "依其現行政策，輸入與輸出內容最長保留約 30 天，且預設不用於模型訓練。",
  "摘要屬「決策候選」，須經設計師檢視後才會發佈，不會自動成為正式紀錄。",
  "",
  "【保存與權利】",
  "原始對話短期保存；被決策卡引用為佐證的內容則長期保留。",
  "您可向設計師要求查閱、更正、停止處理或刪除您的個人資料。",
  "",
  "若不希望我留在這裡，請直接將我移出群組，記錄會立即停止。",
].join("\n");

export interface ConsentState {
  notified: boolean;
  noticeVersion: number | null;
  sentAt: number | null;
  /** True when the group was told under an older, narrower notice. */
  stale: boolean;
}

export async function getConsentState(env: Env, lineGroupRowId: string): Promise<ConsentState> {
  const row = await unscoped(env)
    .prepare(
      `SELECT notice_version, sent_at FROM consent_notice WHERE line_group_id = ?`,
    )
    .bind(lineGroupRowId)
    .first<{ notice_version: number; sent_at: number | null }>();

  if (!row || !row.sent_at) {
    return { notified: false, noticeVersion: row?.notice_version ?? null, sentAt: null, stale: false };
  }
  return {
    notified: row.notice_version >= CURRENT_NOTICE_VERSION,
    noticeVersion: row.notice_version,
    sentAt: row.sent_at,
    stale: row.notice_version < CURRENT_NOTICE_VERSION,
  };
}

/**
 * The gate digest generation asks before reading a group's conversation.
 *
 * Deliberately a single named function rather than an inline condition: the
 * one thing that must never happen is a future code path that summarises
 * without passing through here.
 */
export async function canSummarise(env: Env, lineGroupRowId: string): Promise<boolean> {
  return (await getConsentState(env, lineGroupRowId)).notified;
}

/**
 * Sends the notice, or re-sends it when the wording has widened.
 *
 * Queued rather than sent inline so a failure is retried; marked as sent only
 * once it has actually left, since a notice that failed to deliver has told
 * nobody anything.
 */
export async function ensureNoticeSent(
  env: Env,
  lineGroupRowId: string,
  lineGroupId: string,
): Promise<{ queued: boolean; reason: "already_current" | "sent" | "resent_for_new_version" }> {
  const state = await getConsentState(env, lineGroupRowId);
  if (state.notified) return { queued: false, reason: "already_current" };

  const count = await getGroupMemberCount(env, lineGroupId);
  const now = Date.now();

  const { outboxId } = await enqueue(env, {
    organizationId: null,
    projectId: null,
    lineGroupId,
    kind: "consent_notice",
    messages: [{ type: "text", text: NOTICE_TEXT }],
    recipientCount: count.count ?? 1,
    // Keyed by version so a widened notice is delivered again rather than
    // suppressed as a duplicate of the older one.
    dedupeKey: `consent_notice:v${CURRENT_NOTICE_VERSION}:${lineGroupId}`,
    priority: 3,
  });

  await unscoped(env)
    .prepare(
      `INSERT INTO consent_notice (line_group_id, notice_version, sent_at, outbox_id, created_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT (line_group_id) DO UPDATE
         SET notice_version = excluded.notice_version,
             outbox_id = excluded.outbox_id,
             sent_at = NULL`,
    )
    .bind(lineGroupRowId, CURRENT_NOTICE_VERSION, outboxId, now)
    .run();

  return { queued: true, reason: state.stale ? "resent_for_new_version" : "sent" };
}

/** Marks the notice as delivered. Called after the outbox confirms the send,
 * because until then nobody has been told. */
export async function markNoticeDelivered(env: Env, outboxId: string): Promise<void> {
  await unscoped(env)
    .prepare(
      `UPDATE consent_notice SET sent_at = ? WHERE outbox_id = ? AND sent_at IS NULL`,
    )
    .bind(Date.now(), outboxId)
    .run();
}
