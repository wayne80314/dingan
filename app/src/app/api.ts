/**
 * Dashboard API.
 *
 * Access control is Cloudflare Access in front of the whole worker for M0.1 --
 * one design firm, one set of staff, no self-service sign-up yet. The
 * organization is still carried explicitly through `withOrg` on every query, so
 * adding real sessions later changes where the id comes from and nothing else.
 */

import { Hono } from "hono";
import { withOrg, unscoped } from "../core/db";
import { publishDecision } from "../core/publish";
import { dispatchOne } from "../core/outbox";
import { formatTwd } from "../core/money";
import type { Env } from "../core/types";

export const api = new Hono<{ Bindings: Env }>();

/**
 * Resolves which organization a request acts for.
 *
 * M0.1 has a single tenant, so this reads a header and falls back to the only
 * organization present. It exists as a seam: when sessions arrive, only this
 * function changes.
 */
async function resolveOrgId(c: { req: { header: (k: string) => string | undefined }; env: Env }): Promise<string | null> {
  const header = c.req.header("x-dingan-org");
  if (header) return header;
  const row = await unscoped(c.env)
    .prepare(`SELECT id FROM organization WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Groups awaiting assignment
// ---------------------------------------------------------------------------

/**
 * Groups the bot has been added to but that belong to no project yet.
 *
 * This replaces the pairing-code flow the earlier design called for: the join
 * event already tells us the group id, so making someone type a code into the
 * chat adds a step that can go wrong without adding certainty. The designer
 * still confirms the group name and member count before anything is recorded,
 * which is what that step was actually protecting.
 */
api.get("/groups/unclaimed", async (c) => {
  const rows = await unscoped(c.env)
    .prepare(
      `SELECT id, line_group_id, group_name_snapshot, member_count, joined_at
         FROM line_group
        WHERE status = 'unclaimed'
        ORDER BY joined_at DESC`,
    )
    .all<Record<string, unknown>>();
  return c.json({ groups: rows.results ?? [] });
});

api.post("/groups/:id/claim", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as { projectId?: string; purpose?: string };
  if (!body.projectId) return c.json({ error: "projectId is required" }, 400);

  const db = withOrg(c.env, orgId);
  const project = await db.first<{ id: string }>(
    `SELECT id FROM project WHERE id = ? AND {{ORG}}`,
    body.projectId,
  );
  if (!project) return c.json({ error: "project not found" }, 404);

  const result = await unscoped(c.env)
    .prepare(
      `UPDATE line_group
          SET organization_id = ?, project_id = ?, purpose = ?, status = 'active',
              claimed_at = ?
        WHERE id = ? AND status = 'unclaimed'`,
    )
    .bind(orgId, body.projectId, body.purpose ?? "owner", Date.now(), c.req.param("id"))
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: "group not found or already claimed" }, 409);
  }

  // Members recorded before the claim carry no tenant, since there was none.
  await unscoped(c.env)
    .prepare(
      `UPDATE group_member SET organization_id = ?, project_id = ?
        WHERE line_group_id = ? AND organization_id IS NULL`,
    )
    .bind(orgId, body.projectId, c.req.param("id"))
    .run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Projects and decisions
// ---------------------------------------------------------------------------

api.get("/projects", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ projects: [] });

  const db = withOrg(c.env, orgId);
  const projects = await db.all(
    `SELECT id, name, client_name, status, contract_amount_inc_tax_cents, created_at
       FROM project WHERE {{ORG}} ORDER BY created_at DESC`,
  );
  return c.json({ projects });
});

interface DecisionListRow {
  id: string;
  decision_no: string;
  version: number;
  title: string;
  status: string;
  amount_inc_tax_cents: number;
  schedule_delta_days: number;
  required_approval_count: number;
  published_at: number | null;
  decided_at: number | null;
  approvals: number;
  unidentified: number;
  undelivered_receipts: number;
}

api.get("/projects/:projectId/decisions", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ decisions: [] });

  const db = withOrg(c.env, orgId);
  const decisions = await db.all<DecisionListRow>(
    `SELECT d.id, d.decision_no, d.version, d.title, d.status,
            d.amount_inc_tax_cents, d.schedule_delta_days, d.required_approval_count,
            d.published_at, d.decided_at,
            (SELECT COUNT(*) FROM confirmation cf
              WHERE cf.decision_id = d.id AND cf.version = d.version
                AND cf.action = 'confirm' AND cf.confirmed_by_user_id IS NOT NULL) AS approvals,
            -- Surfaced rather than buried: a tap nobody could attribute is
            -- exactly what the designer needs to chase.
            (SELECT COUNT(*) FROM confirmation cf
              WHERE cf.decision_id = d.id AND cf.resolution_status = 'unidentified') AS unidentified,
            -- A confirmation whose receipt never reached the group is
            -- indistinguishable, to the people in it, from one that never
            -- happened.
            (SELECT COUNT(*) FROM confirmation cf
              WHERE cf.decision_id = d.id AND cf.receipt_status != 'sent') AS undelivered_receipts
       FROM decision d
      WHERE d.project_id = ? AND d.{{ORG}}
      ORDER BY d.created_at DESC`,
    c.req.param("projectId"),
  );

  const totals = decisions.reduce(
    (acc, d) => {
      if (d.status !== "confirmed") return acc;
      if (d.amount_inc_tax_cents > 0) acc.additions += d.amount_inc_tax_cents;
      else acc.deductions += d.amount_inc_tax_cents;
      acc.net += d.amount_inc_tax_cents;
      return acc;
    },
    { additions: 0, deductions: 0, net: 0 },
  );

  return c.json({
    decisions,
    // Only confirmed amounts are totalled: a pending change is not money the
    // client has agreed to.
    confirmedTotals: {
      ...totals,
      additionsText: formatTwd(totals.additions, { withSign: true }),
      deductionsText: formatTwd(totals.deductions, { withSign: true }),
      netText: formatTwd(totals.net, { withSign: true }),
    },
  });
});

api.get("/decisions/:id", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "not found" }, 404);

  const db = withOrg(c.env, orgId);
  const decision = await db.first(
    `SELECT * FROM decision WHERE id = ? AND {{ORG}}`,
    c.req.param("id"),
  );
  if (!decision) return c.json({ error: "not found" }, 404);

  const items = await db.all(
    `SELECT * FROM decision_line_item WHERE decision_id = ? AND {{ORG}} ORDER BY seq`,
    c.req.param("id"),
  );
  const confirmations = await db.all(
    `SELECT id, version, action, channel, confirmed_by_user_id, identity_source,
            identity_confidence, resolution_status, display_name_snapshot,
            declared_name, declared_role, confirm_text, content_sha256_at_confirm,
            line_event_timestamp, server_received_at, receipt_status, created_at
       FROM confirmation WHERE decision_id = ? AND {{ORG}} ORDER BY created_at`,
    c.req.param("id"),
  );

  return c.json({ decision, lineItems: items, confirmations });
});

api.post("/decisions/:id/publish", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    lineGroupId?: string;
    expiresAt?: number;
  };

  const db = withOrg(c.env, orgId);
  const decision = await db.first<{ project_id: string }>(
    `SELECT project_id FROM decision WHERE id = ? AND {{ORG}}`,
    c.req.param("id"),
  );
  if (!decision) return c.json({ error: "not found" }, 404);

  let lineGroupId = body.lineGroupId;
  if (!lineGroupId) {
    const group = await db.first<{ line_group_id: string }>(
      `SELECT line_group_id FROM line_group
        WHERE project_id = ? AND status = 'active' AND purpose = 'owner' AND {{ORG}}
        ORDER BY claimed_at DESC LIMIT 1`,
      decision.project_id,
    );
    lineGroupId = group?.line_group_id;
  }
  if (!lineGroupId) return c.json({ error: "no active owner group for this project" }, 400);

  const result = await publishDecision(c.env, {
    organizationId: orgId,
    projectId: decision.project_id,
    decisionId: c.req.param("id"),
    lineGroupId,
    expiresAt: body.expiresAt ?? null,
  });

  if (!result.ok) return c.json({ error: result.reason, detail: result.detail }, 409);

  // Sent immediately rather than waiting for the sweeper: a designer who just
  // pressed publish is watching the group.
  if (result.outboxId) {
    c.executionCtx.waitUntil(dispatchOne(c.env, result.outboxId).then(() => undefined));
  }

  return c.json({ ok: true, version: result.version, contentSha256: result.contentSha256 });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Local time, not UTC.
 *
 * This file is attached to an invoice and read by a designer and their client,
 * neither of whom should have to convert a Z-suffixed timestamp in their head
 * to check when something was agreed. */
function csvDateTime(ms: number | null): string {
  if (!ms) return "";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The additions-and-deductions statement, as CSV.
 *
 * Defaults to confirmed items only, because this is what gets attached to an
 * invoice: billing for a change the client has not agreed to is the dispute
 * this product exists to prevent. `?all=1` includes the rest for the
 * designer's own review.
 *
 * A UTF-8 BOM is included so Excel on a Taiwanese Windows machine reads the
 * Chinese correctly instead of showing mojibake.
 */
api.get("/projects/:projectId/export.csv", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.text("no organization configured", 400);

  const includeAll = c.req.query("all") === "1";
  const db = withOrg(c.env, orgId);

  const project = await db.first<{ name: string; client_name: string | null }>(
    `SELECT name, client_name FROM project WHERE id = ? AND {{ORG}}`,
    c.req.param("projectId"),
  );
  if (!project) return c.text("not found", 404);

  const rows = await db.all<{
    decision_no: string;
    version: number;
    title: string;
    status: string;
    amount_ex_tax_cents: number;
    amount_tax_cents: number;
    amount_inc_tax_cents: number;
    schedule_delta_days: number;
    decided_at: number | null;
    confirmed_names: string | null;
    identity_note: string | null;
  }>(
    `SELECT d.decision_no, d.version, d.title, d.status,
            d.amount_ex_tax_cents, d.amount_tax_cents, d.amount_inc_tax_cents,
            d.schedule_delta_days, d.decided_at,
            (SELECT GROUP_CONCAT(COALESCE(cf.declared_name, cf.display_name_snapshot), '、')
               FROM confirmation cf
              WHERE cf.decision_id = d.id AND cf.version = d.version
                AND cf.action = 'confirm' AND cf.confirmed_by_user_id IS NOT NULL) AS confirmed_names,
            (SELECT GROUP_CONCAT(DISTINCT cf.identity_confidence)
               FROM confirmation cf
              WHERE cf.decision_id = d.id AND cf.version = d.version
                AND cf.action = 'confirm' AND cf.confirmed_by_user_id IS NOT NULL) AS identity_note
       FROM decision d
      WHERE d.project_id = ? AND d.{{ORG}}
        ${includeAll ? "" : "AND d.status = 'confirmed'"}
      ORDER BY d.decision_no`,
    c.req.param("projectId"),
  );

  const header = [
    "編號", "版本", "項目", "狀態",
    "未稅金額", "稅額", "含稅金額",
    "工期影響(天)", "確認人", "身分依據", "確認時間",
  ];

  const lines = [header.map(csvCell).join(",")];
  let net = 0;

  for (const r of rows) {
    net += r.status === "confirmed" ? r.amount_inc_tax_cents : 0;
    lines.push(
      [
        r.decision_no,
        r.version,
        r.title,
        { draft: "草稿", pending: "待確認", confirmed: "已確認", rejected: "不同意",
          request_changes: "要求修改", expired: "已逾期", withdrawn: "已撤回" }[r.status] ?? r.status,
        formatTwd(r.amount_ex_tax_cents, { withSign: true }),
        formatTwd(r.amount_tax_cents, { withSign: true }),
        formatTwd(r.amount_inc_tax_cents, { withSign: true }),
        r.schedule_delta_days,
        r.confirmed_names ?? "",
        // Carried into the export on purpose: a name the designer entered on
        // someone's behalf is weaker evidence than one that person supplied,
        // and presenting them identically would overstate the record.
        { whitelisted: "本人登錄", asserted: "設計師指定", seen_before: "曾發言", unknown: "未知" }[
          r.identity_note ?? ""
        ] ?? r.identity_note ?? "",
        csvDateTime(r.decided_at),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  lines.push("");
  lines.push([csvCell(`${includeAll ? "全部項目" : "已確認項目"}淨額`), "", "", "", "", "", csvCell(formatTwd(net, { withSign: true }))].join(","));
  lines.push("");
  lines.push(csvCell(`案件：${project.name}${project.client_name ? `／業主：${project.client_name}` : ""}`));
  lines.push(csvCell(`匯出時間：${csvDateTime(Date.now())}`));
  // Stated on the document itself, so it travels with the file rather than
  // living only in a web page nobody keeps.
  lines.push(
    csvCell(
      "本表為「定案」系統依 LINE 群組確認紀錄產出之決策稽核紀錄，" +
        "用以輔助釐清溝通過程，非法律文件，不等同公證或具備自動法律效力。",
    ),
  );

  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="dingan-${c.req.param("projectId")}.csv"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Health of the assumption the product rests on
// ---------------------------------------------------------------------------

/**
 * The proportion of recent group events that carried a sender id.
 *
 * Group postbacks carry `userId` in practice but LINE documents otherwise, so
 * this is the earliest signal available that the behaviour changed. Anything
 * below 100% deserves a look before it becomes a confirmation nobody can
 * attribute.
 */
api.get("/health/identity", async (c) => {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const messages = await unscoped(c.env)
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(has_user_id), 0) AS withId
         FROM line_message WHERE received_at >= ?`,
    )
    .bind(since)
    .first<{ total: number; withId: number }>();

  const confirmations = await unscoped(c.env)
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN confirmed_by_user_id IS NULL THEN 1 ELSE 0 END), 0) AS missing,
              COALESCE(SUM(CASE WHEN receipt_status != 'sent' THEN 1 ELSE 0 END), 0) AS undeliveredReceipts
         FROM confirmation WHERE created_at >= ?`,
    )
    .bind(since)
    .first<{ total: number; missing: number; undeliveredReceipts: number }>();

  const msgTotal = messages?.total ?? 0;
  const cfmTotal = confirmations?.total ?? 0;

  return c.json({
    windowDays: 7,
    messages: {
      total: msgTotal,
      withUserId: messages?.withId ?? 0,
      ratio: msgTotal > 0 ? (messages?.withId ?? 0) / msgTotal : null,
    },
    confirmations: {
      total: cfmTotal,
      missingUserId: confirmations?.missing ?? 0,
      undeliveredReceipts: confirmations?.undeliveredReceipts ?? 0,
    },
    healthy: (messages?.withId ?? 0) === msgTotal && (confirmations?.missing ?? 0) === 0,
  });
});

export { resolveOrgId };
