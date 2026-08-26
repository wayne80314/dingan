import type {
  Env,
  ErrorRow,
  MediaFetchRow,
  ProfileProbeRow,
  RawEventRow,
} from "./types";

/**
 * All helpers here take `(env: Env, ...)` -- NOT a bare D1Database -- so
 * every call site does `insertX(c.env, {...})`, never `insertX(c.env.DB,
 * {...})`. Mixing the two breaks at the type level (D1Database has no `.DB`
 * property) and, if ever force-cast past that, breaks at runtime with every
 * write silently swallowed by a catch block. Keep this convention.
 */

function toInt(b: boolean): number {
  return b ? 1 : 0;
}

export interface InsertRawEventInput {
  webhookEventId: string | null;
  receivedAt: number;
  lineTimestamp: number | null;
  sourceType: string | null;
  groupId: string | null;
  userId: string | null;
  eventType: string | null;
  isRedelivery: boolean;
  rawJson: string;
}

/**
 * Idempotent insert keyed on webhook_event_id (UNIQUE in the schema).
 * Returns `{ inserted: true }` on a fresh row, `{ inserted: false }` when
 * `OR IGNORE` suppressed a UNIQUE conflict (i.e. this is a LINE redelivery
 * of an event we already stored).
 */
export async function insertRawEvent(
  env: Env,
  row: InsertRawEventInput,
): Promise<{ inserted: boolean }> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO raw_events
      (webhook_event_id, received_at, line_timestamp, source_type, group_id, user_id, event_type, is_redelivery, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.webhookEventId,
      row.receivedAt,
      row.lineTimestamp,
      row.sourceType,
      row.groupId,
      row.userId,
      row.eventType,
      toInt(row.isRedelivery),
      row.rawJson,
    )
    .run();

  return { inserted: (result.meta.changes ?? 0) > 0 };
}

export interface InsertMediaFetchInput {
  messageId: string | null;
  webhookEventId: string | null;
  mime: string | null;
  sizeBytes: number | null;
  success: boolean;
  durationMs: number | null;
  error: string | null;
  fetchedAt: number;
}

export async function insertMediaFetch(
  env: Env,
  row: InsertMediaFetchInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO media_fetches
      (message_id, webhook_event_id, mime, size_bytes, success, duration_ms, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.messageId,
      row.webhookEventId,
      row.mime,
      row.sizeBytes,
      toInt(row.success),
      row.durationMs,
      row.error,
      row.fetchedAt,
    )
    .run();
}

export interface InsertProfileProbeInput {
  groupId: string | null;
  userId: string | null;
  displayName: string | null;
  statusCode: number | null;
  success: boolean;
  rawResponse: string | null;
  probedAt: number;
}

export async function insertProfileProbe(
  env: Env,
  row: InsertProfileProbeInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO profile_probes
      (group_id, user_id, display_name, status_code, success, raw_response, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.groupId,
      row.userId,
      row.displayName,
      row.statusCode,
      toInt(row.success),
      row.rawResponse,
      row.probedAt,
    )
    .run();
}

export interface InsertPushLogInput {
  cardType: string | null;
  groupId: string | null;
  recipientCount: number | null;
  statusCode: number | null;
  pushedAt: number;
}

export async function insertPushLog(
  env: Env,
  row: InsertPushLogInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_log
      (card_type, group_id, recipient_count, status_code, pushed_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(row.cardType, row.groupId, row.recipientCount, row.statusCode, row.pushedAt)
    .run();
}

export interface InsertErrorInput {
  context: string | null;
  message: string | null;
  stack: string | null;
  occurredAt: number;
}

export async function insertError(env: Env, row: InsertErrorInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO errors (context, message, stack, occurred_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(row.context, row.message, row.stack, row.occurredAt)
    .run();
}

/**
 * Best-effort error logging: never throws. Use this (not `insertError`
 * directly) from any catch block whose job is "record the failure but keep
 * the request alive" -- if the DB write itself fails there is nowhere left
 * to report that, so we swallow it rather than let it escape and turn an
 * already-degraded path into an unhandled rejection / 500.
 */
export async function safeInsertError(
  env: Env,
  context: string,
  err: unknown,
): Promise<void> {
  try {
    await insertError(env, {
      context,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? (err.stack ?? null) : null,
      occurredAt: Date.now(),
    });
  } catch {
    // Nowhere left to report this. Deliberately swallowed.
  }
}

export interface ReportData {
  rawEvents: RawEventRow[];
  mediaFetches: MediaFetchRow[];
  profileProbes: ProfileProbeRow[];
}

export async function queryAllEventsForReport(env: Env): Promise<ReportData> {
  const [rawEvents, mediaFetches, profileProbes] = await Promise.all([
    env.DB.prepare(`SELECT * FROM raw_events ORDER BY id ASC`).all<RawEventRow>(),
    env.DB.prepare(`SELECT * FROM media_fetches ORDER BY id ASC`).all<MediaFetchRow>(),
    env.DB.prepare(`SELECT * FROM profile_probes ORDER BY id ASC`).all<ProfileProbeRow>(),
  ]);

  return {
    rawEvents: rawEvents.results ?? [],
    mediaFetches: mediaFetches.results ?? [],
    profileProbes: profileProbes.results ?? [],
  };
}

export interface PushUsageThisMonth {
  totalRecipients: number;
  pushCount: number;
  /** UTC calendar-month start, epoch ms. LINE's own billing month boundary
   * is not documented precisely enough to match exactly -- this is a rough
   * F0 monitoring aid, not an authoritative quota source. See RUNBOOK.md's
   * 429 troubleshooting note. */
  windowStart: number;
}

export async function queryPushUsageThisMonth(env: Env): Promise<PushUsageThisMonth> {
  const now = new Date();
  const windowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);

  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(recipient_count), 0) AS total_recipients, COUNT(*) AS push_count
     FROM push_log
     WHERE pushed_at >= ?`,
  )
    .bind(windowStart)
    .first<{ total_recipients: number; push_count: number }>();

  return {
    totalRecipients: row?.total_recipients ?? 0,
    pushCount: row?.push_count ?? 0,
    windowStart,
  };
}

export async function queryRecentGroupIds(env: Env, limit = 50): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT group_id FROM raw_events
     WHERE group_id IS NOT NULL
     ORDER BY group_id
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ group_id: string }>();

  return (result.results ?? []).map((r) => r.group_id);
}

export type { ErrorRow };
