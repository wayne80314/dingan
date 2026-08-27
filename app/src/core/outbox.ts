/**
 * Outbound message queue.
 *
 * Every push is written down before it is attempted. A push that times out
 * leaves us genuinely unable to tell whether LINE delivered it, and guessing
 * either way is bad: assume failure and the client gets the same decision card
 * twice; assume success and they never see it at all.
 *
 * LINE's retry key resolves that. Replaying a key it already accepted returns
 * 409 along with the original message id (verified against the live API in
 * M0.0), so an uncertain send can be settled by retrying rather than by
 * guessing.
 *
 * Quota is charged per recipient, so usage is recorded from the group's member
 * count at send time, once, keyed by the outbox row so a replayed dispatch
 * cannot double-count.
 */

import { newId } from "./ids";
import { pushMessage } from "./line";
import { unscoped } from "./db";
import type { Env, OutboxState } from "./types";

/** How long a dispatcher holds a row before another may take it. Long enough
 * to cover a slow LINE call, short enough that a crashed dispatcher does not
 * strand a decision card for long. */
const LEASE_MS = 60_000;

const MAX_ATTEMPTS = 5;

export interface EnqueueInput {
  organizationId: string | null;
  projectId: string | null;
  /** LINE's C-prefixed group id: the push target. */
  lineGroupId: string;
  kind: string;
  messages: unknown[];
  recipientCount: number;
  /**
   * Application-level identity of this send. Two enqueues with the same key
   * are the same message, so a retried publish cannot queue a second card.
   */
  dedupeKey: string;
  priority?: number;
}

export interface EnqueueResult {
  outboxId: string;
  /** False when this exact send was already queued. */
  created: boolean;
}

export async function enqueue(env: Env, input: EnqueueInput): Promise<EnqueueResult> {
  const id = newId("obx");
  const now = Date.now();

  const result = await unscoped(env)
    .prepare(
      `INSERT INTO outbox
         (id, organization_id, project_id, line_group_id, kind, priority,
          dedupe_key, retry_key, payload_json, recipient_count, state,
          next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      id,
      input.organizationId,
      input.projectId,
      input.lineGroupId,
      input.kind,
      input.priority ?? 1,
      input.dedupeKey,
      // The retry key is fixed at enqueue time and reused for every attempt --
      // that is what makes a retry idempotent at LINE's end.
      crypto.randomUUID(),
      JSON.stringify(input.messages),
      input.recipientCount,
      now,
      now,
    )
    .run();

  if ((result.meta.changes ?? 0) > 0) return { outboxId: id, created: true };

  const existing = await unscoped(env)
    .prepare(`SELECT id FROM outbox WHERE dedupe_key = ?`)
    .bind(input.dedupeKey)
    .first<{ id: string }>();
  return { outboxId: existing?.id ?? id, created: false };
}

/** Statement form of `enqueue`, for callers that need the send to be part of
 * the same atomic batch as the rows it belongs to. */
export function enqueueStatement(
  env: Env,
  outboxId: string,
  retryKey: string,
  input: EnqueueInput,
): D1PreparedStatement {
  const now = Date.now();
  return unscoped(env)
    .prepare(
      `INSERT INTO outbox
         (id, organization_id, project_id, line_group_id, kind, priority,
          dedupe_key, retry_key, payload_json, recipient_count, state,
          next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      outboxId,
      input.organizationId,
      input.projectId,
      input.lineGroupId,
      input.kind,
      input.priority ?? 1,
      input.dedupeKey,
      retryKey,
      JSON.stringify(input.messages),
      input.recipientCount,
      now,
      now,
    );
}

interface OutboxRow {
  id: string;
  organization_id: string | null;
  line_group_id: string;
  kind: string;
  retry_key: string;
  payload_json: string;
  recipient_count: number;
  attempt: number;
}

/**
 * Claims a row for this dispatcher.
 *
 * The lease is taken with a conditional UPDATE and confirmed by the reported
 * row count, so two dispatchers racing for the same row cannot both win.
 */
async function claimOne(env: Env, outboxId: string): Promise<OutboxRow | null> {
  const now = Date.now();
  const claimed = await unscoped(env)
    .prepare(
      `UPDATE outbox
          SET lease_until = ?, attempt = attempt + 1
        WHERE id = ?
          AND state IN ('pending', 'uncertain')
          AND next_attempt_at <= ?
          AND lease_until < ?`,
    )
    .bind(now + LEASE_MS, outboxId, now, now)
    .run();

  if ((claimed.meta.changes ?? 0) === 0) return null;

  return unscoped(env)
    .prepare(
      `SELECT id, organization_id, line_group_id, kind, retry_key, payload_json,
              recipient_count, attempt
         FROM outbox WHERE id = ?`,
    )
    .bind(outboxId)
    .first<OutboxRow>();
}

/** Month key in the organization's own timezone, since quota is billed and
 * read by people who think in local months. */
function monthKey(nowMs: number, timeZone = "Asia/Taipei"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${y}-${m}`;
}

async function recordUsage(env: Env, row: OutboxRow): Promise<void> {
  const now = Date.now();
  // Keyed by the outbox row, so replaying a dispatch cannot charge twice.
  await unscoped(env)
    .prepare(
      `INSERT INTO usage_ledger (outbox_id, organization_id, ym, units, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (outbox_id) DO NOTHING`,
    )
    .bind(row.id, row.organization_id, monthKey(now), row.recipient_count, row.kind, now)
    .run();
}

export interface DispatchResult {
  outboxId: string;
  state: OutboxState;
  statusCode: number;
  sentMessageId: string | null;
}

/** Sends one queued message. Never throws: dispatch runs in background tasks
 * where a rejection would vanish. */
export async function dispatchOne(env: Env, outboxId: string): Promise<DispatchResult | null> {
  const row = await claimOne(env, outboxId);
  if (!row) return null;

  let messages: unknown[];
  try {
    messages = JSON.parse(row.payload_json) as unknown[];
  } catch {
    await unscoped(env)
      .prepare(`UPDATE outbox SET state = 'failed', last_error = ?, lease_until = 0 WHERE id = ?`)
      .bind("unparseable payload", row.id)
      .run();
    return { outboxId: row.id, state: "failed", statusCode: 0, sentMessageId: null };
  }

  const result = await pushMessage(env, row.line_group_id, messages, row.retry_key);
  const now = Date.now();

  if (result.delivered) {
    // Includes LINE's 409: it is telling us this key was already accepted, so
    // the message is out there and this row is settled.
    await unscoped(env)
      .prepare(
        `UPDATE outbox
            SET state = 'sent', sent_at = ?, last_status_code = ?,
                sent_line_message_id = ?, lease_until = 0
          WHERE id = ?`,
      )
      .bind(now, result.statusCode, result.sentMessageId, row.id)
      .run();
    await recordUsage(env, row);
    return {
      outboxId: row.id,
      state: "sent",
      statusCode: result.statusCode,
      sentMessageId: result.sentMessageId,
    };
  }

  const exhausted = row.attempt >= MAX_ATTEMPTS;
  // 'uncertain' is not 'failed': we do not know the message was lost, only
  // that we did not hear back. The retry key makes trying again safe.
  const nextState: OutboxState = exhausted ? "failed" : result.uncertain ? "uncertain" : "pending";
  // Exponential backoff, so a LINE outage is not hammered.
  const backoffMs = Math.min(60_000 * 2 ** row.attempt, 30 * 60_000);

  await unscoped(env)
    .prepare(
      `UPDATE outbox
          SET state = ?, last_status_code = ?, last_error = ?,
              next_attempt_at = ?, lease_until = 0
        WHERE id = ?`,
    )
    .bind(
      nextState,
      result.statusCode,
      result.body.slice(0, 500),
      exhausted ? 0 : now + backoffMs,
      row.id,
    )
    .run();

  return {
    outboxId: row.id,
    state: nextState,
    statusCode: result.statusCode,
    sentMessageId: null,
  };
}

/** Sends everything currently due. Used by the sweeper. */
export async function dispatchDue(env: Env, limit = 20): Promise<DispatchResult[]> {
  const now = Date.now();
  const due = await unscoped(env)
    .prepare(
      `SELECT id FROM outbox
        WHERE state IN ('pending', 'uncertain')
          AND next_attempt_at <= ?
          AND lease_until < ?
        ORDER BY priority DESC, created_at ASC
        LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ id: string }>();

  const results: DispatchResult[] = [];
  for (const { id } of due.results ?? []) {
    try {
      const r = await dispatchOne(env, id);
      if (r) results.push(r);
    } catch {
      // One bad row must not stop the rest of the queue.
    }
  }
  return results;
}
