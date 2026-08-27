import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { postbackEvent, signBody, textMessageEvent, webhookBody } from "./fixtures";

const testEnv = env as unknown as Env;

async function postWebhook(body: string, signature: string | null) {
  const ctx = createExecutionContext();
  const req = new Request("https://example.com/webhook", {
    method: "POST",
    headers: signature ? { "x-line-signature": signature } : {},
    body,
  });
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function countRawEvents(webhookEventId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    "SELECT COUNT(*) AS n FROM raw_events WHERE webhook_event_id = ?",
  )
    .bind(webhookEventId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  // Isolated storage per test is provided by the pool, but be explicit and
  // defensive: clear tables so counts asserted below are unambiguous.
  await testEnv.DB.exec("DELETE FROM raw_events");
  await testEnv.DB.exec("DELETE FROM errors");
});

describe("POST /webhook idempotency + robustness", () => {
  it("returns 401 and logs to errors(context='signature') on an invalid signature", async () => {
    const body = webhookBody([textMessageEvent({ groupId: "Cabc" })]);
    const res = await postWebhook(body, "clearly-not-a-valid-signature");
    expect(res.status).toBe(401);

    const errRow = await testEnv.DB.prepare(
      "SELECT context FROM errors WHERE context = 'signature' ORDER BY id DESC LIMIT 1",
    ).first<{ context: string }>();
    expect(errRow?.context).toBe("signature");
  });

  it("returns 401 when the signature header is missing entirely", async () => {
    const body = webhookBody([textMessageEvent({ groupId: "Cabc" })]);
    const res = await postWebhook(body, null);
    expect(res.status).toBe(401);
  });

  it("classifies a signature failure so setup problems are distinguishable from internet noise", async () => {
    // LINE-shaped body + a present-but-wrong signature is the fingerprint of
    // a channel-secret mismatch, which is the most common setup failure.
    const body = webhookBody([textMessageEvent({ groupId: "Cabc" })]);
    await postWebhook(body, "d2Jvb2dpZXdvb2dpZQ==");

    const row = await testEnv.DB.prepare(
      "SELECT message FROM errors WHERE context = 'signature' ORDER BY id DESC LIMIT 1",
    ).first<{ message: string }>();
    expect(row?.message).toContain("header=present");
    expect(row?.message).toContain("lineShaped=true");
    expect(row?.message).toContain("secretConfigured=yes");

    // Whereas a bodyless, headerless POST -- what a scanner sends -- must be
    // distinguishable at a glance.
    await postWebhook("", null);
    const noise = await testEnv.DB.prepare(
      "SELECT message FROM errors WHERE context = 'signature' ORDER BY id DESC LIMIT 1",
    ).first<{ message: string }>();
    expect(noise?.message).toContain("header=absent");
    expect(noise?.message).toContain("lineShaped=false");
  });

  it("never records the request body itself into the error log (it is chat content)", async () => {
    const secretText = "客廳磁磚改用工程師推薦的款式";
    const body = webhookBody([textMessageEvent({ groupId: "Cabc", text: secretText })]);
    await postWebhook(body, "aW52YWxpZHNpZ25hdHVyZQ==");

    const row = await testEnv.DB.prepare(
      "SELECT message, stack FROM errors WHERE context = 'signature' ORDER BY id DESC LIMIT 1",
    ).first<{ message: string; stack: string | null }>();
    expect(row?.message ?? "").not.toContain(secretText);
    expect(row?.stack ?? "").not.toContain(secretText);
  });

  it("stores one raw_events row per event on a valid signed batch, and returns 200", async () => {
    const events = [
      textMessageEvent({ groupId: "Cabc", webhookEventId: "wh-idem-1" }),
      postbackEvent({ groupId: "Cabc", webhookEventId: "wh-idem-2" }),
    ];
    const body = webhookBody(events);
    const sig = await signBody(body);
    const res = await postWebhook(body, sig);

    expect(res.status).toBe(200);
    expect(await countRawEvents("wh-idem-1")).toBe(1);
    expect(await countRawEvents("wh-idem-2")).toBe(1);
  });

  it("a redelivered event (same webhookEventId) is stored only once, not duplicated", async () => {
    const event = textMessageEvent({ groupId: "Cabc", webhookEventId: "wh-redeliver-1" });
    const body = webhookBody([event]);
    const sig = await signBody(body);

    const first = await postWebhook(body, sig);
    expect(first.status).toBe(200);
    expect(await countRawEvents("wh-redeliver-1")).toBe(1);

    // LINE resending the exact same webhookEventId (e.g. because our first
    // 200 got lost in transit) -- OR IGNORE + the UNIQUE constraint on
    // webhook_event_id must keep this at exactly one row.
    const second = await postWebhook(body, sig);
    expect(second.status).toBe(200);
    expect(await countRawEvents("wh-redeliver-1")).toBe(1);
  });

  it("records deliveryContext.isRedelivery=true into the is_redelivery column", async () => {
    const event = textMessageEvent({
      groupId: "Cabc",
      webhookEventId: "wh-flagged-redelivery",
      isRedelivery: true,
    });
    const body = webhookBody([event]);
    const sig = await signBody(body);
    await postWebhook(body, sig);

    const row = await testEnv.DB.prepare(
      "SELECT is_redelivery FROM raw_events WHERE webhook_event_id = ?",
    )
      .bind("wh-flagged-redelivery")
      .first<{ is_redelivery: number }>();
    expect(row?.is_redelivery).toBe(1);
  });

  it("still returns 200 and stores the valid event when the batch also contains a malformed (null) event", async () => {
    const good = textMessageEvent({ groupId: "Cabc", webhookEventId: "wh-mixed-good" });
    const rawBody = JSON.stringify({ destination: "Uxxxx", events: [null, good] });
    const sig = await signBody(rawBody);

    const res = await postWebhook(rawBody, sig);
    expect(res.status).toBe(200);
    expect(await countRawEvents("wh-mixed-good")).toBe(1);
  });

  it("still returns 200 (not 500) when the body is not valid JSON at all", async () => {
    const rawBody = "{not valid json";
    const sig = await signBody(rawBody);
    const res = await postWebhook(rawBody, sig);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /health returns 200 ok", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://example.com/health"), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
