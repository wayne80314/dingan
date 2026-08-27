import { beforeEach, describe, expect, it } from "vitest";
import { publishDecision } from "../src/core/publish";
import { dispatchDue, dispatchOne, enqueue } from "../src/core/outbox";
import { handlePostback, encodePostbackData } from "../src/hook/postback";
import { newId } from "../src/core/ids";
import { OWNER_USER_ID, resetDb, testEnv } from "./helpers";

const LINE_GROUP = "Cpublishgroup0000000000000000001";

interface DraftFixture {
  orgId: string;
  projectId: string;
  groupRowId: string;
  decisionId: string;
}

async function seedDraft(opts: { status?: string; withItems?: boolean } = {}): Promise<DraftFixture> {
  const now = Date.now();
  const orgId = newId("org");
  const projectId = newId("prj");
  const groupRowId = newId("grp");
  const decisionId = newId("dec");

  await testEnv.DB.prepare(
    `INSERT INTO organization (id, name, line_provider_id, line_channel_id, created_at)
     VALUES (?, '工作室', 'test_provider', 'test_channel', ?)`,
  ).bind(orgId, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO project (id, organization_id, name, created_at) VALUES (?, ?, '測試案件', ?)`,
  ).bind(projectId, orgId, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO line_group
       (id, organization_id, project_id, line_provider_id, line_channel_id,
        line_group_id, status, joined_at, claimed_at)
     VALUES (?, ?, ?, 'test_provider', 'test_channel', ?, 'active', ?, ?)`,
  ).bind(groupRowId, orgId, projectId, LINE_GROUP, now, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO group_member
       (line_group_id, line_user_id, organization_id, project_id, role,
        declared_name, display_name_last_seen, identity_confidence, first_seen_at)
     VALUES (?, ?, ?, ?, 'owner', '陳大明', '大明', 'whitelisted', ?)`,
  ).bind(groupRowId, OWNER_USER_ID, orgId, projectId, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO decision
       (id, organization_id, project_id, decision_no, version, title, change_scope,
        amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents,
        schedule_delta_days, status, created_by, created_at)
     VALUES (?, ?, ?, 'D-001', 1, '廚房電路追加', '增設專用迴路兩處',
             3500000, 175000, 3675000, 3, ?, 'test', ?)`,
  ).bind(decisionId, orgId, projectId, opts.status ?? "draft", now).run();

  if (opts.withItems) {
    await testEnv.DB.prepare(
      `INSERT INTO decision_line_item
         (id, organization_id, decision_id, version, seq, area, description, unit,
          quantity_milli, unit_price_cents, line_total_cents)
       VALUES (?, ?, ?, 1, 1, '廚房', '220V 專用迴路', '式', 2000, 1750000, 3500000)`,
    ).bind(newId("itm"), orgId, decisionId).run();
  }

  return { orgId, projectId, groupRowId, decisionId };
}

beforeEach(resetDb);

describe("publishDecision", () => {
  it("freezes a snapshot, issues a nonce, queues the card and marks it pending, all together", async () => {
    const f = await seedDraft({ withItems: true });

    const result = await publishDecision(testEnv, {
      organizationId: f.orgId,
      projectId: f.projectId,
      decisionId: f.decisionId,
      lineGroupId: LINE_GROUP,
      recipientCount: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshot = await testEnv.DB.prepare(
      `SELECT content_sha256, canonical_json FROM decision_snapshot WHERE decision_id = ?`,
    ).bind(f.decisionId).first<{ content_sha256: string; canonical_json: string }>();
    expect(snapshot?.content_sha256).toBe(result.contentSha256);
    // Quantities are serialized as fixed-precision text so the hash is
    // reproducible on any machine.
    expect(snapshot?.canonical_json).toContain('"quantity":"2.000"');

    const nonce = await testEnv.DB.prepare(
      `SELECT bound_line_group_id, version FROM decision_nonce WHERE nonce = ?`,
    ).bind(result.nonce).first<{ bound_line_group_id: string; version: number }>();
    expect(nonce?.bound_line_group_id).toBe(LINE_GROUP);

    const outbox = await testEnv.DB.prepare(
      `SELECT kind, recipient_count, state, dedupe_key FROM outbox WHERE id = ?`,
    ).bind(result.outboxId).first<{ kind: string; recipient_count: number; state: string; dedupe_key: string }>();
    expect(outbox?.kind).toBe("decision_card");
    expect(outbox?.recipient_count).toBe(3);
    expect(outbox?.state).toBe("pending");

    const decision = await testEnv.DB.prepare(
      `SELECT status, published_at FROM decision WHERE id = ?`,
    ).bind(f.decisionId).first<{ status: string; published_at: number | null }>();
    expect(decision?.status).toBe("pending");
    expect(decision?.published_at).toBeTruthy();
  });

  it("refuses to publish a decision that is already settled", async () => {
    const f = await seedDraft({ status: "confirmed" });
    const result = await publishDecision(testEnv, {
      organizationId: f.orgId,
      projectId: f.projectId,
      decisionId: f.decisionId,
      lineGroupId: LINE_GROUP,
      recipientCount: 3,
    });
    expect(result).toMatchObject({ ok: false, reason: "not_publishable" });
  });

  it("refuses a decision belonging to another organization", async () => {
    const f = await seedDraft();
    const result = await publishDecision(testEnv, {
      organizationId: newId("org"),
      projectId: f.projectId,
      decisionId: f.decisionId,
      lineGroupId: LINE_GROUP,
      recipientCount: 3,
    });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  // Sending without a recipient count would charge quota we cannot account
  // for, so the publish stops rather than guessing.
  it("stops when the recipient count is unavailable", async () => {
    const f = await seedDraft();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    try {
      const result = await publishDecision(testEnv, {
        organizationId: f.orgId,
        projectId: f.projectId,
        decisionId: f.decisionId,
        lineGroupId: LINE_GROUP,
      });
      expect(result).toMatchObject({ ok: false, reason: "no_recipient_count" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not queue a second card when the same publish is retried", async () => {
    const f = await seedDraft();
    const first = await publishDecision(testEnv, {
      organizationId: f.orgId, projectId: f.projectId, decisionId: f.decisionId,
      lineGroupId: LINE_GROUP, recipientCount: 3,
    });
    expect(first.ok).toBe(true);

    // Put it back to draft to simulate a retry of the same publish.
    await testEnv.DB.prepare(`UPDATE decision SET status = 'draft' WHERE id = ?`)
      .bind(f.decisionId).run();

    await publishDecision(testEnv, {
      organizationId: f.orgId, projectId: f.projectId, decisionId: f.decisionId,
      lineGroupId: LINE_GROUP, recipientCount: 3,
    });

    const count = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox WHERE kind = 'decision_card'`,
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  // A card still visible in chat history must not be able to approve content
  // that has since changed.
  it("bumps the version and invalidates the old nonce when re-published after a change request", async () => {
    const f = await seedDraft();
    const first = await publishDecision(testEnv, {
      organizationId: f.orgId, projectId: f.projectId, decisionId: f.decisionId,
      lineGroupId: LINE_GROUP, recipientCount: 3,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await testEnv.DB.prepare(`UPDATE decision SET status = 'request_changes' WHERE id = ?`)
      .bind(f.decisionId).run();

    const second = await publishDecision(testEnv, {
      organizationId: f.orgId, projectId: f.projectId, decisionId: f.decisionId,
      lineGroupId: LINE_GROUP, recipientCount: 3,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.version).toBe(2);

    const oldNonce = await testEnv.DB.prepare(
      `SELECT invalidated_at FROM decision_nonce WHERE nonce = ?`,
    ).bind(first.nonce).first<{ invalidated_at: number | null }>();
    expect(oldNonce?.invalidated_at).toBeTruthy();

    // Tapping the superseded card records nothing.
    const outcome = await handlePostback(testEnv, {
      webhookEventId: "evt-old-card",
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: first.nonce }),
      sourceGroupId: LINE_GROUP,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "nonce_invalidated" });
  });

  it("produces a card a tap can then be validated against end to end", async () => {
    const f = await seedDraft({ withItems: true });
    const published = await publishDecision(testEnv, {
      organizationId: f.orgId, projectId: f.projectId, decisionId: f.decisionId,
      lineGroupId: LINE_GROUP, recipientCount: 3,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const outcome = await handlePostback(testEnv, {
      webhookEventId: "evt-e2e",
      data: encodePostbackData({
        action: "confirm", decisionId: f.decisionId, version: published.version, nonce: published.nonce,
      }),
      sourceGroupId: LINE_GROUP,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });

    expect(outcome.kind).toBe("recorded");
    // The confirmation records the hash of exactly what was published.
    const row = await testEnv.DB.prepare(
      `SELECT content_sha256_at_confirm FROM confirmation WHERE decision_id = ?`,
    ).bind(f.decisionId).first<{ content_sha256_at_confirm: string }>();
    expect(row?.content_sha256_at_confirm).toBe(published.contentSha256);
  });
});

describe("outbox dispatch", () => {
  const originalFetch = globalThis.fetch;

  function mockPush(status: number, body = "{}") {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  async function seedQueued(dedupeKey: string): Promise<string> {
    const orgId = newId("org");
    await testEnv.DB.prepare(
      `INSERT INTO organization (id, name, line_provider_id, line_channel_id, created_at)
       VALUES (?, 'x', 'p', 'c', ?)`,
    ).bind(orgId, Date.now()).run();
    const { outboxId } = await enqueue(testEnv, {
      organizationId: orgId,
      projectId: null,
      lineGroupId: LINE_GROUP,
      kind: "decision_card",
      messages: [{ type: "text", text: "hi" }],
      recipientCount: 5,
      dedupeKey,
    });
    return outboxId;
  }

  it("marks a delivered message sent and charges quota per recipient", async () => {
    const id = await seedQueued("k1");
    mockPush(200, JSON.stringify({ sentMessages: [{ id: "msg-1" }] }));
    try {
      const r = await dispatchOne(testEnv, id);
      expect(r?.state).toBe("sent");
      expect(r?.sentMessageId).toBe("msg-1");

      const usage = await testEnv.DB.prepare(
        `SELECT units FROM usage_ledger WHERE outbox_id = ?`,
      ).bind(id).first<{ units: number }>();
      // Five members, five units -- billing is per recipient, not per call.
      expect(usage?.units).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // LINE answering 409 means it already accepted this retry key, so the
  // message is out there: settled, not failed.
  it("treats a 409 on the retry key as delivered and recovers the message id", async () => {
    const id = await seedQueued("k2");
    mockPush(409, JSON.stringify({
      message: "The retry key is already accepted",
      sentMessages: [{ id: "msg-original" }],
    }));
    try {
      const r = await dispatchOne(testEnv, id);
      expect(r?.state).toBe("sent");
      expect(r?.sentMessageId).toBe("msg-original");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("charges quota only once even if dispatch runs again", async () => {
    const id = await seedQueued("k3");
    mockPush(200, JSON.stringify({ sentMessages: [{ id: "msg-1" }] }));
    try {
      await dispatchOne(testEnv, id);
      // Force it back to pending, as a stuck-lease sweeper would.
      await testEnv.DB.prepare(
        `UPDATE outbox SET state = 'pending', lease_until = 0, next_attempt_at = 0 WHERE id = ?`,
      ).bind(id).run();
      await dispatchOne(testEnv, id);

      const count = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS n FROM usage_ledger WHERE outbox_id = ?`,
      ).bind(id).first<{ n: number }>();
      expect(count?.n).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("holds a timed-out send as uncertain rather than failed, so it can be retried safely", async () => {
    const id = await seedQueued("k4");
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      const r = await dispatchOne(testEnv, id);
      expect(r?.state).toBe("uncertain");

      const row = await testEnv.DB.prepare(
        `SELECT next_attempt_at, attempt FROM outbox WHERE id = ?`,
      ).bind(id).first<{ next_attempt_at: number; attempt: number }>();
      expect(row?.attempt).toBe(1);
      expect(row?.next_attempt_at).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops retrying a message LINE rejects outright once attempts run out", async () => {
    const id = await seedQueued("k5");
    mockPush(400, '{"message":"invalid"}');
    try {
      await testEnv.DB.prepare(`UPDATE outbox SET attempt = 5 WHERE id = ?`).bind(id).run();
      const r = await dispatchOne(testEnv, id);
      expect(r?.state).toBe("failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("will not let two dispatchers claim the same row", async () => {
    const id = await seedQueued("k6");
    mockPush(200);
    try {
      const [a, b] = await Promise.all([dispatchOne(testEnv, id), dispatchOne(testEnv, id)]);
      const claimed = [a, b].filter(Boolean);
      expect(claimed).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends everything currently due", async () => {
    await seedQueued("k7");
    await seedQueued("k8");
    mockPush(200);
    try {
      const results = await dispatchDue(testEnv, 10);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.state === "sent")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
