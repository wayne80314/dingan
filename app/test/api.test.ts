import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/app/index";
import { newId } from "../src/core/ids";
import { resetDb, testEnv } from "./helpers";

interface Tenant {
  orgId: string;
  projectId: string;
  decisionId: string;
  groupRowId: string;
  lineGroupId: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const now = Date.now();
  const orgId = newId("org");
  const projectId = newId("prj");
  const decisionId = newId("dec");
  const groupRowId = newId("grp");
  const lineGroupId = `C${label}00000000000000000000000`.slice(0, 33);

  await testEnv.DB.prepare(
    `INSERT INTO organization (id, name, line_provider_id, line_channel_id, created_at)
     VALUES (?, ?, 'p', 'c', ?)`,
  ).bind(orgId, `工作室 ${label}`, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO project (id, organization_id, name, client_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(projectId, orgId, `${label} 的案子`, `${label} 業主`, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO line_group
       (id, organization_id, project_id, line_provider_id, line_channel_id,
        line_group_id, status, joined_at, claimed_at)
     VALUES (?, ?, ?, 'p', 'c', ?, 'active', ?, ?)`,
  ).bind(groupRowId, orgId, projectId, lineGroupId, now, now).run();

  await testEnv.DB.prepare(
    `INSERT INTO decision
       (id, organization_id, project_id, decision_no, version, title, status,
        amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents,
        created_by, created_at, decided_at)
     VALUES (?, ?, ?, 'D-001', 1, ?, 'confirmed', 3500000, 175000, 3675000, 'x', ?, ?)`,
  ).bind(decisionId, orgId, projectId, `${label} 的機密決策`, now, now).run();

  return { orgId, projectId, decisionId, groupRowId, lineGroupId };
}

async function call(path: string, orgId?: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (orgId) headers.set("x-dingan-org", orgId);
  const res = await worker.fetch(
    new Request(`https://app.example.com${path}`, { ...init, headers }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(resetDb);

describe("tenant isolation", () => {
  // Written while there is only one customer, precisely because that is the
  // point at which it is easiest to skip and hardest to add back later.
  it("does not return another firm's decisions", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");

    const res = await call(`/api/projects/${a.projectId}/decisions`, b.orgId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decisions: unknown[] };
    expect(body.decisions).toHaveLength(0);
  });

  it("returns 404 for a decision belonging to another firm", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");

    const res = await call(`/api/decisions/${a.decisionId}`, b.orgId);
    expect(res.status).toBe(404);
  });

  it("does not export another firm's project", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");

    const res = await call(`/api/projects/${a.projectId}/export.csv`, b.orgId);
    expect(res.status).toBe(404);
  });

  it("lists only the requesting firm's projects", async () => {
    const a = await seedTenant("aaa");
    await seedTenant("bbb");

    const res = await call("/api/projects", a.orgId);
    const body = (await res.json()) as { projects: Array<{ name: string }> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].name).toBe("aaa 的案子");
  });

  it("refuses to claim a group into another firm's project", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");

    const unclaimedId = newId("grp");
    await testEnv.DB.prepare(
      `INSERT INTO line_group
         (id, line_provider_id, line_channel_id, line_group_id, status, joined_at)
       VALUES (?, 'p', 'c', 'Cbrandnew0000000000000000000001', 'unclaimed', ?)`,
    ).bind(unclaimedId, Date.now()).run();

    const res = await call(`/api/groups/${unclaimedId}/claim`, b.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: a.projectId }),
    });
    expect(res.status).toBe(404);

    const group = await testEnv.DB.prepare(
      `SELECT status FROM line_group WHERE id = ?`,
    ).bind(unclaimedId).first<{ status: string }>();
    expect(group?.status).toBe("unclaimed");
  });
});

describe("creating a project", () => {
  // Without this the dashboard is a dead end on first use: a group arrives
  // waiting to be assigned and there is nothing to assign it to.
  it("creates a project under the requesting organization", async () => {
    const t = await seedTenant("aaa");
    const res = await call("/api/projects", t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "信義路王宅", clientName: "王小姐", contractAmountIncTaxCents: 185000000 }),
    });
    expect(res.status).toBe(200);

    const row = await testEnv.DB.prepare(
      `SELECT organization_id, client_name, contract_amount_inc_tax_cents
         FROM project WHERE name = ?`,
    ).bind("信義路王宅").first<{ organization_id: string; client_name: string; contract_amount_inc_tax_cents: number }>();
    expect(row?.organization_id).toBe(t.orgId);
    expect(row?.client_name).toBe("王小姐");
    expect(row?.contract_amount_inc_tax_cents).toBe(185000000);
  });

  it("rejects a project with no name", async () => {
    const t = await seedTenant("aaa");
    const res = await call("/api/projects", t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("does not let one organization create a project inside another", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");

    await call("/api/projects", b.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "越權建立" }),
    });

    // The tenant comes from the caller, never from the body, so it lands under
    // b regardless of what a is doing.
    const rows = await call("/api/projects", a.orgId);
    const body = (await rows.json()) as { projects: Array<{ name: string }> };
    expect(body.projects.map((p) => p.name)).not.toContain("越權建立");
  });

  it("makes the new project immediately claimable by a group", async () => {
    const t = await seedTenant("aaa");
    const created = (await (
      await call("/api/projects", t.orgId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "新案子" }),
      })
    ).json()) as { id: string };

    const groupId = newId("grp");
    await testEnv.DB.prepare(
      `INSERT INTO line_group (id, line_provider_id, line_channel_id, line_group_id, status, joined_at)
       VALUES (?, 'p', 'c', 'Cfresh000000000000000000000001', 'unclaimed', ?)`,
    ).bind(groupId, Date.now()).run();

    const res = await call(`/api/groups/${groupId}/claim`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: created.id }),
    });
    expect(res.status).toBe(200);

    const group = await testEnv.DB.prepare(
      `SELECT status, project_id FROM line_group WHERE id = ?`,
    ).bind(groupId).first<{ status: string; project_id: string }>();
    expect(group?.status).toBe("active");
    expect(group?.project_id).toBe(created.id);
  });
});

describe("decision list", () => {
  it("totals only confirmed amounts", async () => {
    const t = await seedTenant("aaa");
    // A pending change is not money the client has agreed to.
    await testEnv.DB.prepare(
      `INSERT INTO decision
         (id, organization_id, project_id, decision_no, version, title, status,
          amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents, created_by, created_at)
       VALUES (?, ?, ?, 'D-002', 1, '未確認的追加', 'pending', 1000000, 50000, 1050000, 'x', ?)`,
    ).bind(newId("dec"), t.orgId, t.projectId, Date.now()).run();

    const res = await call(`/api/projects/${t.projectId}/decisions`, t.orgId);
    const body = (await res.json()) as {
      decisions: unknown[];
      confirmedTotals: { net: number; netText: string };
    };
    expect(body.decisions).toHaveLength(2);
    expect(body.confirmedTotals.net).toBe(3675000);
    expect(body.confirmedTotals.netText).toBe("+NT$36,750");
  });

  it("surfaces taps that could not be attributed", async () => {
    const t = await seedTenant("aaa");
    await testEnv.DB.prepare(
      `INSERT INTO confirmation
         (id, organization_id, decision_id, version, line_group_id, action, channel,
          confirmed_by_user_id, identity_source, identity_confidence, resolution_status,
          confirm_text, content_sha256_at_confirm, line_provider_id, line_channel_id,
          server_received_at, created_at)
       VALUES (?, ?, ?, 1, ?, 'confirm', 'postback', NULL, 'postback_no_uid', 'unknown',
               'unidentified', 'x', 'h', 'p', 'c', ?, ?)`,
    ).bind(newId("cfm"), t.orgId, t.decisionId, t.lineGroupId, Date.now(), Date.now()).run();

    const res = await call(`/api/projects/${t.projectId}/decisions`, t.orgId);
    const body = (await res.json()) as { decisions: Array<{ unidentified: number }> };
    expect(body.decisions[0].unidentified).toBe(1);
  });
});

describe("CSV export", () => {
  it("starts with a BOM so Excel reads the Chinese correctly", async () => {
    const t = await seedTenant("aaa");
    const res = await call(`/api/projects/${t.projectId}/export.csv`, t.orgId);
    expect(res.status).toBe(200);

    // Asserted on the raw bytes: a UTF-8 decoder strips a leading BOM, so
    // reading this back as text would hide whether it was ever sent -- and
    // without it Excel on a zh-TW machine renders the whole file as mojibake.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    expect(await res.text()).toContain("aaa 的機密決策");
  });

  // Billing for a change the client never agreed to is the dispute this
  // product exists to prevent, so an invoice attachment defaults to confirmed
  // items only.
  it("omits unconfirmed items by default and includes them on request", async () => {
    const t = await seedTenant("aaa");
    await testEnv.DB.prepare(
      `INSERT INTO decision
         (id, organization_id, project_id, decision_no, version, title, status,
          amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents, created_by, created_at)
       VALUES (?, ?, ?, 'D-002', 1, '尚未確認的項目', 'pending', 1000000, 50000, 1050000, 'x', ?)`,
    ).bind(newId("dec"), t.orgId, t.projectId, Date.now()).run();

    const confirmedOnly = await (await call(`/api/projects/${t.projectId}/export.csv`, t.orgId)).text();
    expect(confirmedOnly).not.toContain("尚未確認的項目");

    const all = await (await call(`/api/projects/${t.projectId}/export.csv?all=1`, t.orgId)).text();
    expect(all).toContain("尚未確認的項目");
  });

  // Read by a designer and their client, neither of whom should have to
  // convert a UTC timestamp to check when something was agreed.
  it("renders timestamps in Taipei time rather than UTC", async () => {
    const t = await seedTenant("aaa");
    const text = await (await call(`/api/projects/${t.projectId}/export.csv`, t.orgId)).text();
    expect(text).not.toContain("Z");
    expect(text).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("carries the audit-record framing on the document itself", async () => {
    const t = await seedTenant("aaa");
    const text = await (await call(`/api/projects/${t.projectId}/export.csv`, t.orgId)).text();
    // Travels with the file rather than living only in a web page.
    expect(text).toContain("非法律文件");
  });
});

describe("config health", () => {
  const originalFetch = globalThis.fetch;

  function mockVerify(clientId: string) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ client_id: clientId, expires_in: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  // A wrong channel id corrupts the provenance stamped on every confirmation
  // and raises no error anywhere, so it is worth detecting explicitly.
  it("flags a configured channel id that disagrees with LINE", async () => {
    mockVerify("9999999999");
    try {
      const body = (await (await call("/api/health/config")).json()) as {
        channelIdMatches: boolean;
        reportedChannelId: string;
      };
      expect(body.reportedChannelId).toBe("9999999999");
      expect(body.channelIdMatches).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("confirms a matching channel id", async () => {
    mockVerify("test_channel");
    try {
      const body = (await (await call("/api/health/config")).json()) as { channelIdMatches: boolean };
      expect(body.channelIdMatches).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Provider and channel are separate identifiers; equal values mean one was
  // pasted into both fields.
  it("flags a provider id that is really a copy of the channel id", async () => {
    mockVerify("test_channel");
    try {
      const body = (await (await call("/api/health/config")).json()) as {
        providerLooksLikeChannel: boolean;
      };
      // The test environment sets both to the same value on purpose.
      expect(body.providerLooksLikeChannel).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("correcting a published digest", () => {
  async function seedDigest(t: { orgId: string; projectId: string; groupRowId: string }, over: Record<string, unknown> = {}) {
    const id = newId("dig");
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO digest (id, organization_id, project_id, line_group_id, digest_date,
        covered_from, covered_to, message_count, status, summary_text,
        published_at, edited_at, created_at)
       VALUES (?, ?, ?, ?, '2026-08-31', 0, ?, 5, ?, ?, ?, ?, ?)`,
    ).bind(
      id, t.orgId, t.projectId, t.groupRowId, now,
      over.status ?? "published", over.summary_text ?? "原始摘要",
      over.published_at ?? now - 10_000,
      over.edited_at ?? null,
      now,
    ).run();
    return id;
  }

  it("refuses to republish when nothing changed since it went out", async () => {
    const t = await seedTenant("aaa");
    const id = await seedDigest(t);

    const res = await call(`/api/digests/${id}/publish`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });

  // The group has already seen the wrong version. Blocking the correction
  // would leave the mistake standing and the fix visible only in the
  // dashboard, which is the opposite of the point.
  it("allows republishing after an edit, marked as a correction", async () => {
    const t = await seedTenant("aaa");
    const now = Date.now();
    const id = await seedDigest(t, { published_at: now - 10_000, edited_at: now, summary_text: "更正後的摘要" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const res = await call(`/api/digests/${id}/publish`, t.orgId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);

      const row = await testEnv.DB.prepare(
        `SELECT payload_json, dedupe_key FROM outbox WHERE kind = 'digest' ORDER BY created_at DESC LIMIT 1`,
      ).first<{ payload_json: string; dedupe_key: string }>();
      expect(row?.payload_json).toContain("更正版");
      // Keyed by the edit, so the correction is not suppressed as a duplicate
      // of the original send.
      expect(row?.dedupe_key).toContain(String(now));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks an edit on a published digest so the interface can offer the correction", async () => {
    const t = await seedTenant("aaa");
    const id = await seedDigest(t);

    await call(`/api/digests/${id}/edit`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summaryText: "改過了" }),
    });

    const row = await testEnv.DB.prepare(
      `SELECT status, edited_at, published_at FROM digest WHERE id = ?`,
    ).bind(id).first<{ status: string; edited_at: number; published_at: number }>();
    // Editing does not un-publish it; it records that the published version is
    // now out of date.
    expect(row?.status).toBe("published");
    expect(row!.edited_at).toBeGreaterThan(row!.published_at);
  });
});

describe("resending a decision card", () => {
  it("refuses for a decision that is not awaiting confirmation", async () => {
    const t = await seedTenant("aaa");
    const res = await call(`/api/decisions/${t.decisionId}/resend`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // Seeded as confirmed, so there is nothing to resend.
    expect(res.status).toBe(409);
  });

  it("does not resend another organization's card", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");
    const res = await call(`/api/decisions/${a.decisionId}/resend`, b.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });
});

describe("running a digest on demand", () => {
  it("refuses when the project has no owner group bound", async () => {
    const t = await seedTenant("aaa");
    await testEnv.DB.prepare(`UPDATE line_group SET status = 'left' WHERE id = ?`)
      .bind(t.groupRowId).run();

    const res = await call(`/api/projects/${t.projectId}/digests/run`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  // The manual path must not become a way around the notice: it runs the same
  // gate the scheduler does.
  it("refuses a group that has not been notified", async () => {
    const t = await seedTenant("aaa");
    const res = await call(`/api/projects/${t.projectId}/digests/run`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("個資告知");
  });

  it("reports a quiet window as its own outcome rather than a failure", async () => {
    const t = await seedTenant("aaa");
    await testEnv.DB.prepare(
      `INSERT INTO consent_notice (line_group_id, notice_version, sent_at, created_at)
       VALUES (?, 2, ?, ?)`,
    ).bind(t.groupRowId, Date.now(), Date.now()).run();

    const res = await call(`/api/projects/${t.projectId}/digests/run`, t.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("對話太少");
  });

  it("does not run a digest for another organization's project", async () => {
    const a = await seedTenant("aaa");
    const b = await seedTenant("bbb");

    const res = await call(`/api/projects/${a.projectId}/digests/run`, b.orgId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});

describe("identity health", () => {
  it("reports a clean window as healthy", async () => {
    const res = await call("/api/health/identity");
    const body = (await res.json()) as { healthy: boolean };
    expect(body.healthy).toBe(true);
  });

  it("reports a confirmation with no attributable sender as unhealthy", async () => {
    const t = await seedTenant("aaa");
    await testEnv.DB.prepare(
      `INSERT INTO confirmation
         (id, organization_id, decision_id, version, line_group_id, action, channel,
          confirmed_by_user_id, identity_source, identity_confidence, resolution_status,
          confirm_text, content_sha256_at_confirm, line_provider_id, line_channel_id,
          server_received_at, created_at)
       VALUES (?, ?, ?, 1, ?, 'confirm', 'postback', NULL, 'postback_no_uid', 'unknown',
               'unidentified', 'x', 'h', 'p', 'c', ?, ?)`,
    ).bind(newId("cfm"), t.orgId, t.decisionId, t.lineGroupId, Date.now(), Date.now()).run();

    const res = await call("/api/health/identity");
    const body = (await res.json()) as { healthy: boolean; confirmations: { missingUserId: number } };
    expect(body.healthy).toBe(false);
    expect(body.confirmations.missingUserId).toBe(1);
  });
});
