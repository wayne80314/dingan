import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { postbackEvent, signBody, webhookBody } from "./fixtures";

const testEnv = env as unknown as Env;
const TOKEN = testEnv.PANEL_TOKEN; // "test_panel_token", set in vitest.config.ts's miniflare bindings

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://example.com${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedOneEvent() {
  const body = webhookBody([postbackEvent({ groupId: "Cpanelgroup01", userId: "Upaneluser01" })]);
  const sig = await signBody(body);
  const res = await call("/webhook", { method: "POST", headers: { "x-line-signature": sig }, body });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await testEnv.DB.exec("DELETE FROM raw_events");
  await testEnv.DB.exec("DELETE FROM push_log");
});

describe("GET /panel", () => {
  it("401s with no token", async () => {
    const res = await call("/panel");
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await call("/panel?token=not-the-real-token");
    expect(res.status).toBe(401);
  });

  it("200s with the correct token and lists a group_id seen via /webhook", async () => {
    await seedOneEvent();
    const res = await call(`/panel?token=${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Cpanelgroup01");
  });
});

describe("GET /report", () => {
  it("401s with no token", async () => {
    const res = await call("/report");
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await call("/report?token=nope");
    expect(res.status).toBe(401);
  });

  it("?format=json returns the AnalysisResult shape reflecting seeded events", async () => {
    await seedOneEvent();
    const res = await call(`/report?token=${encodeURIComponent(TOKEN)}&format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const json = (await res.json()) as {
      totalRawEvents: number;
      eventTypeCounts: Record<string, number>;
      postbackUserIdCoverage: { withUserId: number };
    };
    expect(json.totalRawEvents).toBe(1);
    expect(json.eventTypeCounts.postback).toBe(1);
    expect(json.postbackUserIdCoverage.withUserId).toBe(1);
  });

  it("defaults to HTML when format is omitted or unrecognized", async () => {
    const res = await call(`/report?token=${encodeURIComponent(TOKEN)}&format=xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });
});

describe("POST /panel/push", () => {
  it("401s with no token", async () => {
    const res = await call("/panel/push", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("400s when groupId is missing", async () => {
    const res = await call(`/panel/push?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardType: "text" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on an unrecognized cardType", async () => {
    const res = await call(`/panel/push?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId: "Cabc", cardType: "carrier-pigeon" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s (not 500) on a non-JSON body", async () => {
    const res = await call(`/panel/push?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  describe("with LINE's HTTP API mocked (no real network call)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function mockLineFetch() {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/members/count")) {
          return new Response(JSON.stringify({ count: 5 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/message/push")) {
          return new Response("{}", { status: 200 });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }) as unknown as typeof fetch;
    }

    it("looks up member count, pushes, and logs recipient_count from the group's real member count (not a hardcoded 1)", async () => {
      mockLineFetch();
      const res = await call(`/panel/push?token=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupId: "Cpushgroup01", cardType: "postback" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; recipientCount: number | null };
      expect(json.ok).toBe(true);
      expect(json.recipientCount).toBe(5);

      const row = await testEnv.DB.prepare(
        "SELECT recipient_count, card_type, group_id FROM push_log WHERE group_id = ?",
      )
        .bind("Cpushgroup01")
        .first<{ recipient_count: number; card_type: string; group_id: string }>();
      expect(row?.recipient_count).toBe(5);
      expect(row?.card_type).toBe("postback");
    });

    it("still logs the push (with a null recipientCount) if the member-count lookup fails", async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/members/count")) return new Response("not found", { status: 404 });
        if (url.includes("/message/push")) return new Response("{}", { status: 200 });
        throw new Error(`unexpected fetch in test: ${url}`);
      }) as unknown as typeof fetch;

      const res = await call(`/panel/push?token=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupId: "Cpushgroup02", cardType: "text" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { memberCountLookupOk: boolean; recipientCount: number | null };
      expect(json.memberCountLookupOk).toBe(false);
      expect(json.recipientCount).toBeNull();
    });
  });
});
