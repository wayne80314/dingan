/**
 * Webhook ingestion.
 *
 * Ordering here is deliberate and load-bearing:
 *
 *   1. Verify the signature over the raw body. Parsing first and
 *      re-serializing would change bytes and break verification.
 *   2. Persist the verbatim body to R2 before interpreting anything. R2 and D1
 *      are unlikely to fail together, so a body preserved there is recoverable
 *      even if the row behind it never landed.
 *   3. Record each event with its webhookEventId as the primary key, which
 *      makes LINE's at-least-once redelivery idempotent for free.
 *   4. Answer 200 quickly, and do the slow work (media, profiles, receipts)
 *      outside the response.
 *
 * Two response rules that look inconsistent but are not:
 *
 *   * A bad signature answers 401. It is a rejection, not a failure, and
 *     retrying it would never help.
 *   * A body we cannot parse answers 200. LINE would otherwise retry the whole
 *     batch indefinitely against an endpoint that will never accept it.
 *   * A failure to record answers 5xx, because that one *should* be retried --
 *     losing an event silently is the worst outcome available.
 */

import type { Context } from "hono";
import { verifyLineSignature } from "../core/signature";
import { recordDeadLetter, unscoped } from "../core/db";
import { newId } from "../core/ids";
import { sha256Hex } from "../core/canonical";
import type { Env } from "../core/types";
import { handleFastPath } from "./fast";

interface ParsedEvent {
  webhookEventId: string;
  eventType: string;
  lineGroupId: string | null;
  isRedelivery: boolean;
  raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Pulls out only what is needed to index and route the event. Everything
 * else stays in the raw body, so an event shape we do not yet understand is
 * still stored rather than dropped. */
function parseEvent(value: unknown): ParsedEvent | null {
  const rec = asRecord(value);
  if (!rec) return null;

  const webhookEventId =
    typeof rec.webhookEventId === "string" ? rec.webhookEventId : null;
  const eventType = typeof rec.type === "string" ? rec.type : "unknown";
  if (!webhookEventId) return null;

  const source = asRecord(rec.source);
  const lineGroupId =
    source && typeof source.groupId === "string"
      ? source.groupId
      : source && typeof source.roomId === "string"
        ? source.roomId
        : null;

  const delivery = asRecord(rec.deliveryContext);
  const isRedelivery = delivery?.isRedelivery === true;

  return { webhookEventId, eventType, lineGroupId, isRedelivery, raw: rec };
}

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-line-signature") ?? null;

  const valid = await verifyLineSignature(rawBody, signature, c.env.LINE_CHANNEL_SECRET);
  if (!valid) {
    // Preserved rather than merely counted: a spike of these is either a
    // misconfigured secret or someone probing, and the bodies are what tell
    // the two apart.
    const sha = await sha256Hex(rawBody);
    const key = `deadletter/${Date.now()}-${sha.slice(0, 16)}.json`;
    try {
      await c.env.RAW.put(key, rawBody);
    } catch {
      // Storage failure must not turn a rejection into a 500.
    }
    await recordDeadLetter(c.env, {
      id: newId("dl"),
      reason: "signature",
      detail: `header=${signature ? "present" : "absent"} bytes=${rawBody.length}`,
      rawSha256: sha,
      r2Key: key,
      statusCode: 401,
    });
    return c.text("invalid signature", 401);
  }

  let events: unknown[] = [];
  try {
    const parsed = JSON.parse(rawBody) as { events?: unknown };
    if (Array.isArray(parsed.events)) events = parsed.events;
  } catch (err) {
    await recordDeadLetter(c.env, {
      id: newId("dl"),
      reason: "unparseable_body",
      detail: err instanceof Error ? err.message : String(err),
      rawSha256: await sha256Hex(rawBody),
      statusCode: 200,
    });
    return c.text("ok", 200);
  }

  const parsedEvents: ParsedEvent[] = [];
  for (const raw of events) {
    const parsed = parseEvent(raw);
    if (parsed) {
      parsedEvents.push(parsed);
    } else {
      // No webhookEventId means no idempotency key, so it cannot be indexed.
      // Keep the body; it is the only record that it arrived at all.
      await recordDeadLetter(c.env, {
        id: newId("dl"),
        reason: "unindexable_event",
        detail: JSON.stringify(raw).slice(0, 500),
      });
    }
  }

  if (parsedEvents.length === 0) return c.text("ok", 200);

  const receivedAt = Date.now();

  // Bodies first: if the batch below fails, LINE retries and we still have
  // these. Written per event so a retry overwrites the same key rather than
  // accumulating copies.
  const r2Keys = new Map<string, string>();
  for (const ev of parsedEvents) {
    const key = `raw/${ev.webhookEventId}.json`;
    r2Keys.set(ev.webhookEventId, key);
    try {
      await c.env.RAW.put(key, JSON.stringify(ev.raw));
    } catch {
      // Fall through: the D1 row still records that the event existed, and
      // ingest will report the body as missing rather than pretend otherwise.
    }
  }

  try {
    const db = unscoped(c.env);
    await db.batch(
      parsedEvents.map((ev) =>
        db
          .prepare(
            `INSERT INTO raw_event
               (webhook_event_id, line_group_id, event_type, is_redelivery,
                ingest_state, r2_key, received_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT (webhook_event_id) DO NOTHING`,
          )
          .bind(
            ev.webhookEventId,
            ev.lineGroupId,
            ev.eventType,
            ev.isRedelivery ? 1 : 0,
            r2Keys.get(ev.webhookEventId) ?? "",
            receivedAt,
          ),
      ),
    );
  } catch (err) {
    // The one case worth a retry: nothing was recorded, so answering 200 would
    // discard the events for good.
    await recordDeadLetter(c.env, {
      id: newId("dl"),
      reason: "raw_event_insert_failed",
      detail: err instanceof Error ? err.message : String(err),
      statusCode: 503,
    });
    return c.text("storage unavailable", 503);
  }

  // Reply tokens are short-lived and single-use, so anything that answers the
  // user has to start now rather than wait for a sweeper.
  c.executionCtx.waitUntil(handleFastPath(c.env, parsedEvents));

  return c.text("ok", 200);
}

export type { ParsedEvent };
