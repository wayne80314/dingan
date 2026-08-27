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
