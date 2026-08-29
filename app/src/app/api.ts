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
import { dispatchOne, enqueue } from "../core/outbox";
import { formatTwd, splitTax } from "../core/money";
import { newId, formatDecisionNo } from "../core/ids";
import { ensureNoticeSent, getConsentState, markNoticeDelivered } from "../core/consent";
import { runDigestForGroup } from "../core/digest";
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
// First-run setup
// ---------------------------------------------------------------------------

/** The firm this instance belongs to, or null before anything is set up. */
api.get("/org", async (c) => {
  const row = await unscoped(c.env)
    .prepare(
      `SELECT id, name, tax_id, timezone FROM organization
        WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    )
    .first<Record<string, unknown>>();
  return c.json({ organization: row ?? null });
});

/**
 * Registers the firm.
 *
 * Everything else hangs off an organization row, so without a way to create
 * one the dashboard cannot be used at all on a fresh deployment -- the first
 * screen would offer a group waiting to be assigned and no way to proceed.
 * Doing it in the interface rather than by hand-written SQL also means the
 * provider and channel ids are captured from configuration, where they have
 * already been verified, instead of retyped.
 */
api.post("/org", async (c) => {
  const existing = await unscoped(c.env)
    .prepare(`SELECT id FROM organization WHERE deleted_at IS NULL LIMIT 1`)
    .first<{ id: string }>();
  // M0.1 serves one firm. Refusing a second here keeps a stray request from
  // creating an organization nothing points at.
  if (existing) return c.json({ error: "organization already configured", id: existing.id }, 409);

  const body = (await c.req.json().catch(() => ({}))) as { name?: string; taxId?: string };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "公司名稱為必填" }, 400);

  const id = newId("org");
  await unscoped(c.env)
    .prepare(
      `INSERT INTO organization (id, name, tax_id, line_provider_id, line_channel_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, body.taxId?.trim() || null, c.env.LINE_PROVIDER_ID ?? "", c.env.LINE_CHANNEL_ID ?? "", Date.now())
    .run();

  return c.json({ ok: true, id, name });
});

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

  // Claiming is the moment the group's conversation starts being recorded and
  // becomes eligible for summarising abroad, so the notice goes out now rather
  // than at some later point when the transfer has already happened.
  const group = await unscoped(c.env)
    .prepare(`SELECT line_group_id FROM line_group WHERE id = ?`)
    .bind(c.req.param("id"))
    .first<{ line_group_id: string }>();

  if (group) {
    const notice = await ensureNoticeSent(c.env, c.req.param("id"), group.line_group_id);
    if (notice.queued) {
      const row = await unscoped(c.env)
        .prepare(`SELECT outbox_id FROM consent_notice WHERE line_group_id = ?`)
        .bind(c.req.param("id"))
        .first<{ outbox_id: string | null }>();
      if (row?.outbox_id) {
        c.executionCtx.waitUntil(
          dispatchOne(c.env, row.outbox_id)
            .then(() => markNoticeDelivered(c.env, row.outbox_id!))
            .catch(() => undefined),
        );
      }
    }
  }

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

/**
 * Creates a project.
 *
 * Without this the dashboard is a dead end on first use: a group arrives
 * waiting to be assigned, and there is nothing to assign it to. Kept to the
 * few fields a designer knows when a job starts -- the rest is editable once
 * the work is under way.
 */
api.post("/projects", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    clientName?: string;
    siteAddress?: string;
    contractNo?: string;
    contractAmountIncTaxCents?: number;
  };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "案名為必填" }, 400);

  const id = newId("prj");
  const now = Date.now();

  // An insert carries its tenant as a written value rather than a filter, so
  // there is no predicate to forget and nothing for withOrg to enforce. The
  // org id comes from the authenticated caller, never from the request body.
  await unscoped(c.env)
    .prepare(
      `INSERT INTO project
         (id, organization_id, name, client_name, site_address, contract_no,
          contract_amount_inc_tax_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      orgId,
      name,
      body.clientName?.trim() || null,
      body.siteAddress?.trim() || null,
      body.contractNo?.trim() || null,
      typeof body.contractAmountIncTaxCents === "number" ? body.contractAmountIncTaxCents : null,
      now,
    )
    .run();

  return c.json({ ok: true, id, name });
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
// Daily minutes
// ---------------------------------------------------------------------------

/** Whether a group has been told its conversation may be summarised abroad.
 * Read by the interface to explain an absent digest rather than leaving it
 * looking broken. */
api.get("/groups/:id/consent", async (c) => {
  const state = await getConsentState(c.env, c.req.param("id"));
  return c.json(state);
});

api.get("/projects/:projectId/digests", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ digests: [] });

  const digests = await withOrg(c.env, orgId).all(
    `SELECT d.id, d.digest_date, d.message_count, d.segment_count, d.status,
            d.summary_text, d.edited_at, d.published_at, d.error, d.created_at,
            (SELECT COUNT(*) FROM digest_item i WHERE i.digest_id = d.id) AS item_count
       FROM digest d
      WHERE d.project_id = ? AND d.{{ORG}}
      ORDER BY d.digest_date DESC
      LIMIT 60`,
    c.req.param("projectId"),
  );
  return c.json({ digests });
});

/**
 * Generates a digest now, instead of waiting for the evening run.
 *
 * Exists for testing and for the case where a designer wants the minutes
 * before the scheduler gets to them. It goes through exactly the same path as
 * the scheduled run -- including the consent gate -- so what it produces is
 * what the nightly job would have produced, not a shortcut around it.
 */
api.post("/projects/:projectId/digests/run", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const db = withOrg(c.env, orgId);
  const group = await db.first<{
    id: string;
    organization_id: string;
    project_id: string;
    line_group_id: string;
    last_digest_to: number | null;
  }>(
    `SELECT g.id, g.organization_id, g.project_id, g.line_group_id,
            (SELECT MAX(covered_to) FROM digest d WHERE d.line_group_id = g.id) AS last_digest_to
       FROM line_group g
      WHERE g.project_id = ? AND g.status = 'active' AND g.purpose = 'owner' AND g.{{ORG}}
      ORDER BY g.claimed_at DESC LIMIT 1`,
    c.req.param("projectId"),
  );
  if (!group) return c.json({ error: "這個案子還沒有綁定業主群組" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as { hours?: number };
  // Defaults to a day. A manual run is usually "summarise what we just said",
  // so it reaches back over the recent conversation rather than resuming the
  // scheduler's cursor -- which would cover only the minutes since the last
  // run and look like nothing happened.
  const hours = typeof body.hours === "number" && body.hours > 0 && body.hours <= 168 ? body.hours : 24;
  const now = Date.now();
  const from = now - hours * 60 * 60 * 1000;

  const result = await runDigestForGroup(
    c.env,
    {
      id: group.id,
      organization_id: group.organization_id,
      project_id: group.project_id,
      line_group_id: group.line_group_id,
    },
    from,
    now,
  );

  // Each outcome is something the person who pressed the button needs to act
  // on differently, so they are distinguished rather than collapsed into a
  // generic failure.
  if (result.status === "skipped_no_consent") {
    return c.json(
      { error: "這個群組還沒收到個資告知，尚不能整理對話。請確認告知訊息已送達群組。" },
      409,
    );
  }
  if (result.status === "skipped_quiet") {
    return c.json({ error: `過去 ${hours} 小時內的對話太少，沒有可整理的內容。` }, 409);
  }
  if (result.status === "failed") {
    return c.json({ error: `整理失敗：${result.error ?? "未知原因"}` }, 502);
  }

  return c.json({ ok: true, digestId: result.digestId, itemCount: result.itemCount, dropped: result.dropped });
});

api.get("/digests/:id", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "not found" }, 404);

  const db = withOrg(c.env, orgId);
  const digest = await db.first(`SELECT * FROM digest WHERE id = ? AND {{ORG}}`, c.req.param("id"));
  if (!digest) return c.json({ error: "not found" }, 404);

  const items = await db.all(
    `SELECT * FROM digest_item WHERE digest_id = ? AND {{ORG}} ORDER BY seq`,
    c.req.param("id"),
  );

  // The messages each claim cites, so the designer can read the original
  // rather than taking the summary's word for it.
  const ids = new Set<string>();
  for (const item of items) {
    try {
      for (const id of JSON.parse(String(item.source_message_ids ?? "[]")) as string[]) ids.add(id);
    } catch {
      // A malformed citation list means that item simply shows no sources.
    }
  }

  let sources: Record<string, unknown>[] = [];
  if (ids.size > 0) {
    const placeholders = [...ids].map(() => "?").join(",");
    sources = await db.all(
      `SELECT line_message_id, display_name_snapshot, text_content, line_timestamp
         FROM line_message
        WHERE line_message_id IN (${placeholders}) AND {{ORG}}
        ORDER BY line_timestamp`,
      ...ids,
    );
  }

  return c.json({ digest, items, sources });
});

/** Saves the designer's edits. The generated text stays in `raw_json`, so an
 * edit never destroys the record of what the model actually produced. */
api.post("/digests/:id/edit", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as { summaryText?: string };
  if (typeof body.summaryText !== "string") return c.json({ error: "summaryText is required" }, 400);

  const result = await withOrg(c.env, orgId).run(
    `UPDATE digest
        SET summary_text = ?, edited_at = ?,
            status = CASE WHEN status = 'published' THEN status ELSE 'reviewed' END
      WHERE id = ? AND {{ORG}}`,
    body.summaryText,
    Date.now(),
    c.req.param("id"),
  );
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/**
 * Publishes the minutes to the group.
 *
 * Only ever from a deliberate action: the whole point of holding the digest
 * back is that a person checks it before the client sees it.
 */
api.post("/digests/:id/publish", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const db = withOrg(c.env, orgId);
  const digest = await db.first<{
    id: string;
    project_id: string;
    line_group_id: string;
    digest_date: string;
    summary_text: string | null;
    status: string;
  }>(
    `SELECT id, project_id, line_group_id, digest_date, summary_text, status
       FROM digest WHERE id = ? AND {{ORG}}`,
    c.req.param("id"),
  );
  if (!digest) return c.json({ error: "not found" }, 404);
  if (digest.status === "published") return c.json({ error: "already published" }, 409);
  if (!digest.summary_text?.trim()) return c.json({ error: "沒有可發佈的內容" }, 400);

  const group = await db.first<{ line_group_id: string; member_count: number | null }>(
    `SELECT line_group_id, member_count FROM line_group WHERE id = ? AND {{ORG}}`,
    digest.line_group_id,
  );
  if (!group) return c.json({ error: "group not found" }, 404);

  const text =
    `📋 ${digest.digest_date} 討論記錄\n\n${digest.summary_text.trim()}\n\n` +
    `（本記錄由設計師整理後發佈，如有出入請直接在群組指正。）`;

  const { outboxId } = await enqueue(c.env, {
    organizationId: orgId,
    projectId: digest.project_id,
    lineGroupId: group.line_group_id,
    kind: "digest",
    messages: [{ type: "text", text }],
    recipientCount: group.member_count ?? 1,
    dedupeKey: `digest:${digest.id}`,
  });

  await db.run(
    `UPDATE digest SET status = 'published', published_at = ?, published_outbox_id = ?
      WHERE id = ? AND {{ORG}}`,
    Date.now(),
    outboxId,
    digest.id,
  );

  c.executionCtx.waitUntil(dispatchOne(c.env, outboxId).then(() => undefined));
  return c.json({ ok: true });
});

/**
 * Turns one candidate into a decision-card draft.
 *
 * The only path from a summary to a record, and it stays manual: what the
 * model produced is a suggestion, and it becomes something a client can be
 * held to only after a person has written it as a decision and the client has
 * confirmed it.
 */
api.post("/digest-items/:id/promote", async (c) => {
  const orgId = await resolveOrgId(c);
  if (!orgId) return c.json({ error: "no organization configured" }, 400);

  const db = withOrg(c.env, orgId);
  const item = await db.first<{
    id: string;
    digest_id: string;
    title: string;
    detail: string | null;
    amount_inc_tax_cents: number | null;
    source_message_ids: string;
    promoted_decision_id: string | null;
  }>(
    `SELECT id, digest_id, title, detail, amount_inc_tax_cents, source_message_ids,
            promoted_decision_id
       FROM digest_item WHERE id = ? AND {{ORG}}`,
    c.req.param("id"),
  );
  if (!item) return c.json({ error: "not found" }, 404);
  if (item.promoted_decision_id) {
    return c.json({ error: "already promoted", decisionId: item.promoted_decision_id }, 409);
  }

  const digest = await db.first<{ project_id: string; line_group_id: string }>(
    `SELECT project_id, line_group_id FROM digest WHERE id = ? AND {{ORG}}`,
    item.digest_id,
  );
  if (!digest) return c.json({ error: "not found" }, 404);

  const project = await db.first<{ tax_rate_bp: number; decision_seq: number }>(
    `SELECT tax_rate_bp, decision_seq FROM project WHERE id = ? AND {{ORG}}`,
    digest.project_id,
  );
  if (!project) return c.json({ error: "project not found" }, 404);

  const seq = project.decision_seq + 1;
  const decisionId = newId("dec");
  const now = Date.now();

  // Treated as tax-inclusive regardless of the project's default, because a
  // figure quoted in conversation is the number someone said out loud -- and
  // in this trade that is the amount the client expects to pay. The designer
  // can change the basis when they finish the draft; guessing the other way
  // would silently inflate it.
  const { exTaxCents, taxCents, incTaxCents } = splitTax(
    item.amount_inc_tax_cents ?? 0,
    "inclusive",
    project.tax_rate_bp,
  );

  await unscoped(c.env).batch([
    unscoped(c.env)
      .prepare(
        `INSERT INTO decision
           (id, organization_id, project_id, decision_no, version, title, change_scope,
            tax_mode, tax_rate_bp, amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents,
            status, line_group_id, source_line_message_ids, created_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'inclusive', ?, ?, ?, ?, 'draft', ?, ?, 'digest', ?)`,
      )
      .bind(
        decisionId, orgId, digest.project_id, formatDecisionNo(seq), item.title,
        item.detail ?? null, project.tax_rate_bp, exTaxCents, taxCents, incTaxCents,
        digest.line_group_id, item.source_message_ids, now,
      ),
    unscoped(c.env)
      .prepare(`UPDATE project SET decision_seq = ? WHERE id = ?`)
      .bind(seq, digest.project_id),
    unscoped(c.env)
      .prepare(`UPDATE digest_item SET promoted_decision_id = ? WHERE id = ?`)
      .bind(decisionId, item.id),
  ]);

  return c.json({ ok: true, decisionId, decisionNo: formatDecisionNo(seq) });
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
/**
 * Checks the configured LINE identifiers against what LINE itself reports.
 *
 * `LINE_CHANNEL_ID` and `LINE_PROVIDER_ID` are stamped onto every confirmation
 * so a user id stays interpretable years later — LINE user ids are scoped to a
 * provider, so without them a historical record cannot be tied back to a
 * person. A wrong value corrupts that provenance on every row and produces no
 * error at all, which is exactly the kind of fault worth spending an endpoint
 * on.
 *
 * The access token is issued for one channel, so asking LINE to verify it
 * returns the true channel id to compare against.
 */
api.get("/health/config", async (c) => {
  const configuredChannelId = c.env.LINE_CHANNEL_ID ?? "";
  const configuredProviderId = c.env.LINE_PROVIDER_ID ?? "";

  // LINE has two verification endpoints and which one applies depends on how
  // the token was issued: long-lived tokens POST to /v2/oauth/verify, while
  // tokens with a user-specified expiry GET /oauth2/v2.1/verify. Both return
  // client_id, and we do not control which kind was generated, so try each.
  const token = c.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  let reportedChannelId: string | null = null;
  let error: string | null = null;

  async function readClientId(res: Response): Promise<boolean> {
    const body = (await res.json()) as { client_id?: string; error_description?: string };
    if (res.ok && body.client_id) {
      reportedChannelId = body.client_id;
      return true;
    }
    error = body.error_description ?? `HTTP ${res.status}`;
    return false;
  }

  try {
    const longLived = await fetch("https://api.line.me/v2/oauth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token }).toString(),
    });
    if (!(await readClientId(longLived))) {
      const v21 = await fetch(
        `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`,
      );
      if (await readClientId(v21)) error = null;
    } else {
      error = null;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const channelIdMatches = reportedChannelId !== null && reportedChannelId === configuredChannelId;

  return c.json({
    configuredChannelId,
    configuredProviderId,
    reportedChannelId,
    channelIdMatches,
    // A provider id equal to the channel id is almost certainly a copy of the
    // wrong value: they are separate identifiers.
    providerLooksLikeChannel:
      configuredProviderId !== "" && configuredProviderId === configuredChannelId,
    error,
  });
});

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
