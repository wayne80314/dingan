/**
 * Message, media and membership ingestion.
 *
 * The privacy gate lives here, in the synchronous path: until a group has been
 * claimed into a project, message bodies are not written down. A bot sitting in
 * a chat it was added to by mistake should not quietly accumulate a
 * transcript, and "we filter it out later" is not the same promise as "we never
 * stored it".
 *
 * What is recorded for an unclaimed group is only that an event happened —
 * enough to show the group in the dashboard's unclaimed list so someone can
 * decide what it is.
 */

import { unscoped } from "../core/db";
import { newId } from "../core/ids";
import { enqueue } from "../core/outbox";
import { getContentToR2, getGroupMemberCount, getGroupMemberProfile, getGroupSummary } from "../core/line";
import { MEDIA_MESSAGE_TYPES, type Env } from "../core/types";
import type { ParsedEvent } from "./webhook";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

interface GroupRow {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  status: string;
}

async function findGroup(env: Env, lineGroupId: string): Promise<GroupRow | null> {
  return unscoped(env)
    .prepare(
      `SELECT id, organization_id, project_id, status
         FROM line_group
        WHERE line_group_id = ? AND status IN ('unclaimed', 'active')`,
    )
    .bind(lineGroupId)
    .first<GroupRow>();
}

/**
 * Records that the bot was added to a group, and sends the personal-data
 * notice.
 *
 * The notice goes out on join rather than on first use because by the time
 * anyone uses it, messages would already be arriving. Sent as a push (there is
 * no reply token worth relying on for `join`) and enqueued so a failure is
 * retried rather than lost.
 */
export async function handleJoin(env: Env, ev: ParsedEvent): Promise<void> {
  const source = asRecord(ev.raw.source);
  const lineGroupId = typeof source?.groupId === "string" ? source.groupId : null;
  if (!lineGroupId) return;

  const db = unscoped(env);
  const now = Date.now();
  const id = newId("grp");

  const summary = await getGroupSummary(env, lineGroupId);
  const count = await getGroupMemberCount(env, lineGroupId);

  await db
    .prepare(
      `INSERT INTO line_group
         (id, line_provider_id, line_channel_id, line_group_id, group_name_snapshot,
          member_count, member_count_synced_at, status, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      id,
      env.LINE_PROVIDER_ID,
      env.LINE_CHANNEL_ID,
      lineGroupId,
      summary.groupName,
      count.count,
      count.ok ? now : null,
      now,
    )
    .run();

  const notice =
    "您好，我是「定案」。\n\n" +
    "設計師邀請我加入這個群組，協助把討論中的決定記錄下來，" +
    "並在完工時整理成決策總表與追加減帳明細。\n\n" +
    "為此我會記錄本群組的訊息內容、圖片與確認紀錄。" +
    "在設計師於後台完成專案設定之前，我不會保存任何對話內容。\n\n" +
    "詳細的個人資料蒐集告知：請向設計師索取，或稍後由設計師提供連結。\n" +
    "若不希望我留在這裡，請直接將我移出群組，記錄會立即停止。";

  await enqueue(env, {
    organizationId: null,
    projectId: null,
    lineGroupId,
    kind: "consent_notice",
    messages: [{ type: "text", text: notice }],
    recipientCount: count.count ?? 1,
    // One notice per group, ever: re-adding the bot should not re-announce.
    dedupeKey: `consent_notice:${lineGroupId}`,
    priority: 3,
  });

  await db
    .prepare(`UPDATE line_group SET consent_notified_at = ? WHERE line_group_id = ? AND consent_notified_at IS NULL`)
    .bind(now, lineGroupId)
    .run();
}

/** Marks a group inactive when the bot is removed. Recording stops from this
 * point; nothing already stored is deleted, since it may be cited by a
 * decision. */
export async function handleLeave(env: Env, ev: ParsedEvent): Promise<void> {
  const source = asRecord(ev.raw.source);
  const lineGroupId = typeof source?.groupId === "string" ? source.groupId : null;
  if (!lineGroupId) return;

  await unscoped(env)
    .prepare(`UPDATE line_group SET status = 'left', left_at = ? WHERE line_group_id = ?`)
    .bind(Date.now(), lineGroupId)
    .run();
}

/** Notes a member joining, so the dashboard can offer them when the designer
 * assigns who may approve. */
export async function handleMemberJoined(env: Env, ev: ParsedEvent): Promise<void> {
  const source = asRecord(ev.raw.source);
  const lineGroupId = typeof source?.groupId === "string" ? source.groupId : null;
  if (!lineGroupId) return;

  const group = await findGroup(env, lineGroupId);
  if (!group) return;

  const joined = asRecord(ev.raw.joined);
  const members = Array.isArray(joined?.members) ? joined.members : [];
  const now = Date.now();

  for (const m of members) {
    const rec = asRecord(m);
    const userId = typeof rec?.userId === "string" ? rec.userId : null;
    if (!userId) continue;

    const profile = await getGroupMemberProfile(env, lineGroupId, userId);
    await unscoped(env)
      .prepare(
        `INSERT INTO group_member
           (line_group_id, line_user_id, organization_id, project_id, role,
            display_name_last_seen, display_name_synced_at, identity_confidence, first_seen_at)
         VALUES (?, ?, ?, ?, 'unknown', ?, ?, 'seen_before', ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        group.id,
        userId,
        group.organization_id,
        group.project_id,
        profile.displayName,
        profile.ok ? now : null,
        now,
      )
      .run();
  }

  // Membership changed, so the recipient count used for billing is stale.
  const count = await getGroupMemberCount(env, lineGroupId);
  if (count.ok) {
    await unscoped(env)
      .prepare(`UPDATE line_group SET member_count = ?, member_count_synced_at = ? WHERE id = ?`)
      .bind(count.count, now, group.id)
      .run();
  }
}

export async function handleMemberLeft(env: Env, ev: ParsedEvent): Promise<void> {
  const source = asRecord(ev.raw.source);
  const lineGroupId = typeof source?.groupId === "string" ? source.groupId : null;
  if (!lineGroupId) return;

  const group = await findGroup(env, lineGroupId);
  if (!group) return;

  const left = asRecord(ev.raw.left);
  const members = Array.isArray(left?.members) ? left.members : [];
  const now = Date.now();

  for (const m of members) {
    const rec = asRecord(m);
    const userId = typeof rec?.userId === "string" ? rec.userId : null;
    if (!userId) continue;
    // Marked rather than deleted: a confirmation they gave still refers to
    // them, and the record should stay interpretable.
    await unscoped(env)
      .prepare(`UPDATE group_member SET left_at = ? WHERE line_group_id = ? AND line_user_id = ?`)
      .bind(now, group.id, userId)
      .run();
  }

  const count = await getGroupMemberCount(env, lineGroupId);
  if (count.ok) {
    await unscoped(env)
      .prepare(`UPDATE line_group SET member_count = ?, member_count_synced_at = ? WHERE id = ?`)
      .bind(count.count, now, group.id)
      .run();
  }
}

/**
 * Stores a message.
 *
 * `has_user_id` is recorded on every row. It is the passive monitor for the
 * one platform behaviour this product depends on but LINE does not promise:
 * group events carrying the sender's id. A ratio below 100% is the earliest
 * signal available that the behaviour changed, and it costs one column.
 */
export async function handleMessage(env: Env, ev: ParsedEvent): Promise<void> {
  const source = asRecord(ev.raw.source);
  const lineGroupId = typeof source?.groupId === "string" ? source.groupId : null;
  const lineUserId = typeof source?.userId === "string" ? source.userId : null;
  if (!lineGroupId) return;

  const group = await findGroup(env, lineGroupId);
  if (!group) return;

  // The privacy gate. An unclaimed group's content is never written down --
  // only the raw event, which the dashboard uses to offer the group for
  // claiming, and which retention policy removes on its own schedule.
  if (group.status !== "active" || !group.project_id) return;

  const message = asRecord(ev.raw.message);
  const lineMessageId = typeof message?.id === "string" ? message.id : null;
  const messageType = typeof message?.type === "string" ? message.type : "unknown";
  if (!lineMessageId) return;

  const now = Date.now();
  const isMedia = MEDIA_MESSAGE_TYPES.has(messageType);
  const r2Key = isMedia ? `media/${group.project_id}/${lineMessageId}` : null;

  let displayName: string | null = null;
  let role: string | null = null;
  if (lineUserId) {
    const member = await unscoped(env)
      .prepare(
        `SELECT display_name_last_seen, role FROM group_member
          WHERE line_group_id = ? AND line_user_id = ?`,
      )
      .bind(group.id, lineUserId)
      .first<{ display_name_last_seen: string | null; role: string }>();
    displayName = member?.display_name_last_seen ?? null;
    role = member?.role ?? null;

    if (!member) {
      // First time we have seen this person: record them so the dashboard can
      // offer them as an approver.
      const profile = await getGroupMemberProfile(env, lineGroupId, lineUserId);
      displayName = profile.displayName;
      await unscoped(env)
        .prepare(
          `INSERT INTO group_member
             (line_group_id, line_user_id, organization_id, project_id, role,
              display_name_last_seen, display_name_synced_at, identity_confidence, first_seen_at)
           VALUES (?, ?, ?, ?, 'unknown', ?, ?, 'seen_before', ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(group.id, lineUserId, group.organization_id, group.project_id,
              profile.displayName, profile.ok ? now : null, now)
        .run();
    }
  }

  await unscoped(env)
    .prepare(
      `INSERT INTO line_message
         (id, organization_id, project_id, line_group_id, line_message_id, line_user_id,
          display_name_snapshot, role, message_type, text_content, r2_key, media_status,
          has_user_id, line_timestamp, received_at, webhook_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      newId("msg"),
      group.organization_id,
      group.project_id,
      group.id,
      lineMessageId,
      lineUserId,
      displayName,
      role,
      messageType,
      typeof message?.text === "string" ? message.text : null,
      r2Key,
      isMedia ? "pending" : null,
      lineUserId ? 1 : 0,
      typeof ev.raw.timestamp === "number" ? ev.raw.timestamp : now,
      now,
      ev.webhookEventId,
    )
    .run();

  if (isMedia && r2Key) {
    // LINE expires message content after a retention window, so this is not
    // recoverable later -- a failure is recorded, not deferred.
    const result = await getContentToR2(env, lineMessageId, r2Key);
    await unscoped(env)
      .prepare(
        `UPDATE line_message
            SET media_status = ?, media_sha256 = ?, mime = ?, size_bytes = ?
          WHERE line_message_id = ?`,
      )
      .bind(
        result.ok ? "stored" : "failed",
        result.sha256,
        result.mime,
        result.sizeBytes,
        lineMessageId,
      )
      .run();
  }
}

/**
 * Handles a message being unsent.
 *
 * The sender withdrew it, so the content goes. What stays is the fact that a
 * message existed and was withdrawn: a decision citing it would otherwise
 * reference a gap, and silently rewriting history is its own problem.
 */
export async function handleUnsend(env: Env, ev: ParsedEvent): Promise<void> {
  const unsend = asRecord(ev.raw.unsend);
  const messageId = typeof unsend?.messageId === "string" ? unsend.messageId : null;
  if (!messageId) return;

  const row = await unscoped(env)
    .prepare(`SELECT r2_key FROM line_message WHERE line_message_id = ?`)
    .bind(messageId)
    .first<{ r2_key: string | null }>();

  if (row?.r2_key) {
    try {
      await env.MEDIA.delete(row.r2_key);
    } catch {
      // Recorded as unsent regardless; a stranded object is better than
      // failing to mark the withdrawal.
    }
  }

  await unscoped(env)
    .prepare(
      `UPDATE line_message
          SET text_content = NULL, r2_key = NULL, media_status = NULL,
              unsent_at = ?
        WHERE line_message_id = ?`,
    )
    .bind(Date.now(), messageId)
    .run();
}

/** Routes one event to its handler. */
export async function ingestEvent(env: Env, ev: ParsedEvent): Promise<void> {
  switch (ev.eventType) {
    case "message":
      return handleMessage(env, ev);
    case "join":
      return handleJoin(env, ev);
    case "leave":
      return handleLeave(env, ev);
    case "memberJoined":
      return handleMemberJoined(env, ev);
    case "memberLeft":
      return handleMemberLeft(env, ev);
    case "unsend":
      return handleUnsend(env, ev);
    default:
      // Unknown and unhandled types are already stored verbatim in R2, which
      // is the point of keeping raw bodies: they stay recoverable.
      return;
  }
}
