import { env } from "cloudflare:test";
import { newId, newNonce } from "../src/core/ids";
import type { Env } from "../src/core/types";

export const testEnv = env as unknown as Env;

export const LINE_GROUP_ID = "Ctestgroup000000000000000000001";
export const OWNER_USER_ID = "Uowner00000000000000000000000001";
export const CREW_USER_ID = "Ucrew000000000000000000000000001";

export interface Fixture {
  orgId: string;
  projectId: string;
  groupRowId: string;
  lineGroupId: string;
  decisionId: string;
  nonce: string;
}

/** Clears every table between tests so counts asserted below are unambiguous.
 * Ordered so children go before the rows they reference. */
export async function resetDb(): Promise<void> {
  const tables = [
    // Digest tables first: they reference decisions and groups.
    "digest_item",
    "digest",
    "consent_notice",
    "confirmation",
    "decision_nonce",
    "decision_line_item",
    "decision_snapshot",
    "decision",
    "group_member",
    "line_group",
    "line_message",
    "event_step",
    "raw_event",
    "usage_ledger",
    "outbox",
    "dead_letter",
    "audit_event",
    "project",
    "organization",
  ];
  for (const t of tables) {
    await testEnv.DB.exec(`DELETE FROM ${t}`);
  }
}

export interface SeedOptions {
  lineGroupId?: string;
  requiredApprovalCount?: number;
  decisionStatus?: string;
  nonceExpiresAt?: number | null;
  ownerRole?: string;
  version?: number;
}

/** Builds one organization with a published, pending decision and a live
 * nonce -- the state a group is in while waiting for a client to tap. */
export async function seedPublishedDecision(opts: SeedOptions = {}): Promise<Fixture> {
  const now = Date.now();
  const orgId = newId("org");
  const projectId = newId("prj");
  const groupRowId = newId("grp");
  const decisionId = newId("dec");
  const nonce = newNonce();
  const lineGroupId = opts.lineGroupId ?? LINE_GROUP_ID;
  const version = opts.version ?? 1;

  await testEnv.DB.prepare(
    `INSERT INTO organization (id, name, line_provider_id, line_channel_id, created_at)
     VALUES (?, ?, 'test_provider', 'test_channel', ?)`,
  )
    .bind(orgId, `工作室 ${orgId.slice(-4)}`, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO project (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(projectId, orgId, "測試案件", now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO line_group
       (id, organization_id, project_id, line_provider_id, line_channel_id,
        line_group_id, status, joined_at, claimed_at)
     VALUES (?, ?, ?, 'test_provider', 'test_channel', ?, 'active', ?, ?)`,
  )
    .bind(groupRowId, orgId, projectId, lineGroupId, now, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO group_member
       (line_group_id, line_user_id, organization_id, project_id, role,
        declared_name, display_name_last_seen, identity_confidence, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'whitelisted', ?)`,
  )
    .bind(
      groupRowId,
      OWNER_USER_ID,
      orgId,
      projectId,
      opts.ownerRole ?? "owner",
      "陳大明",
      "大明",
      now,
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO group_member
       (line_group_id, line_user_id, organization_id, project_id, role,
        display_name_last_seen, identity_confidence, first_seen_at)
     VALUES (?, ?, ?, ?, 'crew', '阿源師傅', 'seen_before', ?)`,
  )
    .bind(groupRowId, CREW_USER_ID, orgId, projectId, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO decision
       (id, organization_id, project_id, decision_no, version, title,
        amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents,
        required_approval_count, status, line_group_id, created_by, created_at, published_at)
     VALUES (?, ?, ?, 'D-001', ?, '廚房電路追加',
             3500000, 175000, 3675000, ?, ?, ?, 'test', ?, ?)`,
  )
    .bind(
      decisionId,
      orgId,
      projectId,
      version,
      opts.requiredApprovalCount ?? 1,
      opts.decisionStatus ?? "pending",
      groupRowId,
      now,
      now,
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO decision_snapshot
       (id, organization_id, decision_id, version, canonical_json, content_sha256, created_at)
     VALUES (?, ?, ?, ?, '{"t":"x"}', 'abc123', ?)`,
  )
    .bind(newId("snp"), orgId, decisionId, version, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO decision_nonce
       (nonce, organization_id, decision_id, version, action, bound_line_group_id,
        issued_at, expires_at)
     VALUES (?, ?, ?, ?, 'confirm', ?, ?, ?)`,
  )
    .bind(
      nonce,
      orgId,
      decisionId,
      version,
      lineGroupId,
      now,
      opts.nonceExpiresAt === undefined ? now + 86_400_000 : opts.nonceExpiresAt,
    )
    .run();

  return { orgId, projectId, groupRowId, lineGroupId, decisionId, nonce };
}

export async function decisionStatus(decisionId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare(`SELECT status FROM decision WHERE id = ?`)
    .bind(decisionId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

export async function confirmationCount(decisionId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) AS n FROM confirmation WHERE decision_id = ?`,
  )
    .bind(decisionId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
