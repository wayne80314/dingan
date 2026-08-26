import type { Context } from "hono";
import { verifyLineSignature } from "./signature";
import {
  insertMediaFetch,
  insertProfileProbe,
  insertRawEvent,
  safeInsertError,
} from "./db";
import { getContent, getGroupMemberProfile } from "./line";
import { isPlausibleWebhookEvent, type Env } from "./types";

const MEDIA_MESSAGE_TYPES = new Set(["image", "video", "audio", "file"]);

/** Narrow shape we actually need from ExecutionContext -- avoids coupling
 * to whichever concrete ExecutionContext<T> type Hono's Context happens to
 * report (it has drifted from @cloudflare/workers-types' own ExecutionContext
 * shape across versions), and makes tests trivial to drive without a real one. */
type WaitUntil = (promise: Promise<unknown>) => void;

function extractGroupOrRoomId(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const s = source as Record<string, unknown>;
  // Schema only has one `group_id` column (see 0001_init.sql comment); room
  // sources are folded into the same column since raw_json always keeps the
  // ground truth regardless of which convenience column we pick.
  if (s.type === "group" && typeof s.groupId === "string") return s.groupId;
  if (s.type === "room" && typeof s.roomId === "string") return s.roomId;
  return null;
}

function extractUserId(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const s = source as Record<string, unknown>;
  return typeof s.userId === "string" ? s.userId : null;
}

/**
 * Handles a single event from body.events[]. Never throws: every branch
 * that can fail is caught locally so one malformed/unexpected event can
 * never abort the rest of the batch (see processBatch) or the guaranteed-200
 * response contract for POST /webhook.
 */
async function processOneEvent(env: Env, waitUntil: WaitUntil, event: unknown): Promise<void> {
  try {
    if (!isPlausibleWebhookEvent(event)) {
      await safeInsertError(
        env,
        "webhook",
        new Error(`event is not a plausible webhook event object: ${JSON.stringify(event)}`),
      );
      return;
    }

    const webhookEventId =
      typeof event.webhookEventId === "string" ? event.webhookEventId : null;
    const eventType = typeof event.type === "string" ? event.type : null;
    const lineTimestamp = typeof event.timestamp === "number" ? event.timestamp : null;
    const source = event.source;
    const groupId = extractGroupOrRoomId(source);
    const userId = extractUserId(source);
    const sourceType =
      typeof source === "object" && source !== null && "type" in source
        ? String((source as Record<string, unknown>).type)
        : null;
    const isRedelivery =
      typeof event.deliveryContext === "object" &&
      event.deliveryContext !== null &&
      (event.deliveryContext as Record<string, unknown>).isRedelivery === true;

    // Raw event storage must complete synchronously (before this function
    // returns / the response is finalized) -- this is the record of what
    // LINE actually sent, and it's what the idempotency/redelivery matrix in
    // report.ts is checked against.
    await insertRawEvent(env, {
      webhookEventId,
      receivedAt: Date.now(),
      lineTimestamp,
      sourceType,
      groupId,
      userId,
      eventType,
      isRedelivery,
      rawJson: JSON.stringify(event),
    });

    // Media fetch and profile probing are not required for the 200 response
    // and must not delay it -- scheduled via waitUntil, individually guarded
    // so a failure in one never blocks or hides the other.
    if (eventType === "message" || eventType === "messageEdited") {
      const message = (event as Record<string, unknown>).message;
      if (
        typeof message === "object" &&
        message !== null &&
        typeof (message as Record<string, unknown>).type === "string" &&
        MEDIA_MESSAGE_TYPES.has((message as Record<string, unknown>).type as string) &&
        typeof (message as Record<string, unknown>).id === "string"
      ) {
        const messageId = (message as Record<string, unknown>).id as string;
        waitUntil(fetchAndRecordMedia(env, messageId, webhookEventId));
      }
    }

    if (groupId && userId) {
      waitUntil(probeAndRecordProfile(env, groupId, userId));
    }
  } catch (err) {
    await safeInsertError(env, "webhook", err);
  }
}

async function fetchAndRecordMedia(
  env: Env,
  messageId: string,
  webhookEventId: string | null,
): Promise<void> {
  try {
    const result = await getContent(env, messageId);
    await insertMediaFetch(env, {
      messageId,
      webhookEventId,
      mime: result.mime,
      sizeBytes: result.sizeBytes,
      success: result.success,
      durationMs: result.durationMs,
      error: result.error,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    await safeInsertError(env, "media_fetch", err);
  }
}

const seenProbeKeys = new Set<string>();

async function probeAndRecordProfile(
  env: Env,
  groupId: string,
  userId: string,
): Promise<void> {
  const key = `${groupId}:${userId}`;
  // Best-effort in-isolate dedupe so repeated messages from the same person
  // in the same worker instance's lifetime don't re-probe every time; not a
  // durable "have we ever probed this pair" check (that would require a
  // blocking DB read before the 200 response, which the contract disallows
  // for the profile probe). Duplicate profile_probes rows across cold
  // starts are expected and are exactly the kind of "does displayName
  // change over time" signal report.ts's matrix wants anyway.
  if (seenProbeKeys.has(key)) return;
  seenProbeKeys.add(key);

  try {
    const result = await getGroupMemberProfile(env, groupId, userId);
    await insertProfileProbe(env, {
      groupId,
      userId,
      displayName: result.displayName,
      statusCode: result.statusCode,
      success: result.success,
      rawResponse: result.raw,
      probedAt: Date.now(),
    });
  } catch (err) {
    // getGroupMemberProfile itself does not throw, but this catch stays as
    // defense-in-depth so a bug there (or in insertProfileProbe) still ends
    // up in errors instead of a silently-dropped waitUntil rejection.
    await safeInsertError(env, "profile_probe", err);
  }
}

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();
  const signatureHeader = c.req.header("x-line-signature") ?? null;

  const valid = await verifyLineSignature(rawBody, signatureHeader, c.env.LINE_CHANNEL_SECRET);
  if (!valid) {
    // Signature failure is a deliberate security rejection, not an internal
    // error -- 401, not 200, and logged separately from the generic
    // "webhook" error context so /report can distinguish the two.
    await safeInsertError(c.env, "signature", new Error("invalid or missing X-Line-Signature"));
    return c.text("invalid signature", 401);
  }

  let events: unknown[] = [];
  try {
    const parsed = JSON.parse(rawBody) as { events?: unknown };
    if (Array.isArray(parsed.events)) events = parsed.events;
  } catch (err) {
    // Not valid JSON at all: still 200, per LINE's own retry-storm-avoidance
    // guidance -- an endpoint that 5xxs on a body it can't parse gets
    // hammered with retries for the whole batch.
    await safeInsertError(c.env, "webhook", err);
    return c.text("ok", 200);
  }

  // Each event gets its own guarded call (processOneEvent already wraps
  // itself in try/catch), and this loop adds a second layer so that even a
  // bug inside the guard itself can't propagate out of the loop and turn
  // into an uncaught-by-Hono 500 for the whole batch.
  const waitUntil: WaitUntil = (p) => c.executionCtx.waitUntil(p);
  for (const event of events) {
    try {
      await processOneEvent(c.env, waitUntil, event);
    } catch (err) {
      await safeInsertError(c.env, "webhook", err);
    }
  }

  return c.text("ok", 200);
}
