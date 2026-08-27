/**
 * Work that must happen while the reply token is still valid.
 *
 * Reply tokens are single-use and expire within about a minute, so anything
 * that answers a person cannot wait for a sweeper. This runs inside
 * `waitUntil`, after the 200 has been sent, and is written so that no failure
 * here can escape: an unhandled rejection in a waitUntil task is invisible.
 */

import { replyMessage } from "../core/line";
import { unscoped } from "../core/db";
import type { Env } from "../core/types";
import { handlePostback } from "./postback";
import { buildReceiptMessages } from "./receipt";
import { ingestEvent } from "./ingest";
import type { ParsedEvent } from "./webhook";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

async function decisionNoFor(env: Env, decisionId: string): Promise<string> {
  const row = await unscoped(env)
    .prepare(`SELECT decision_no FROM decision WHERE id = ?`)
    .bind(decisionId)
    .first<{ decision_no: string }>();
  return row?.decision_no ?? "該決策卡";
}

async function markReceipt(
  env: Env,
  confirmationId: string,
  delivered: boolean,
): Promise<void> {
  await unscoped(env)
    .prepare(
      `UPDATE confirmation
          SET receipt_status = ?, receipt_delivery = 'reply', receipt_sent_at = ?
        WHERE id = ?`,
    )
    .bind(delivered ? "sent" : "failed", delivered ? Date.now() : null, confirmationId)
    .run();
}

async function handleOnePostback(env: Env, ev: ParsedEvent): Promise<void> {
  const postback = asRecord(ev.raw.postback);
  const source = asRecord(ev.raw.source);
  const data = typeof postback?.data === "string" ? postback.data : "";
  const replyToken = typeof ev.raw.replyToken === "string" ? ev.raw.replyToken : null;

  const outcome = await handlePostback(env, {
    webhookEventId: ev.webhookEventId,
    data,
    sourceGroupId: typeof source?.groupId === "string" ? source.groupId : null,
    sourceUserId: typeof source?.userId === "string" ? source.userId : null,
    lineTimestamp: typeof ev.raw.timestamp === "number" ? ev.raw.timestamp : Date.now(),
  });

  const decisionNo =
    outcome.kind === "unidentified"
      ? outcome.decisionNo
      : outcome.kind === "recorded" || outcome.kind === "duplicate"
        ? await decisionNoFor(env, outcome.decisionId)
        : "該決策卡";

  const messages = buildReceiptMessages(outcome, decisionNo, Date.now());
  if (messages.length === 0 || !replyToken) {
    // Nothing to say, or no token to say it with. A recorded confirmation with
    // no receipt is flagged so the dashboard can surface it rather than let it
    // pass as delivered.
    if (outcome.kind === "recorded" || outcome.kind === "unidentified") {
      await markReceipt(env, outcome.confirmationId, false);
    }
    return;
  }

  const result = await replyMessage(env, replyToken, messages);

  if (outcome.kind === "recorded" || outcome.kind === "unidentified") {
    await markReceipt(env, outcome.confirmationId, result.delivered);
    // A failed receipt is not retried here with a push: quota is charged per
    // recipient and the dashboard already shows undelivered receipts. Escalation
    // is a deliberate decision, not an automatic cost.
  }
}

/** Marks an event as ingested, so the sweeper does not reprocess it. */
async function markDone(env: Env, webhookEventId: string): Promise<void> {
  await unscoped(env)
    .prepare(`UPDATE raw_event SET ingest_state = 'done' WHERE webhook_event_id = ?`)
    .bind(webhookEventId)
    .run();
}

async function markFailed(env: Env, webhookEventId: string, err: unknown): Promise<void> {
  await unscoped(env)
    .prepare(
      `UPDATE raw_event
          SET ingest_state = 'failed', attempt = attempt + 1, last_error = ?
        WHERE webhook_event_id = ?`,
    )
    .bind(err instanceof Error ? err.message : String(err), webhookEventId)
    .run();
}

/**
 * Runs the time-sensitive part of ingestion for a batch of events.
 * Each event is isolated: one failure must not stop the rest, and none of them
 * may throw out of this function.
 */
export async function handleFastPath(env: Env, events: ParsedEvent[]): Promise<void> {
  for (const ev of events) {
    try {
      if (ev.eventType === "postback") {
        await handleOnePostback(env, ev);
      } else {
        await ingestEvent(env, ev);
      }
      await markDone(env, ev.webhookEventId);
    } catch (err) {
      try {
        await markFailed(env, ev.webhookEventId, err);
      } catch {
        // Nowhere left to report this.
      }
    }
  }
}
