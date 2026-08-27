/**
 * Postback handling — turning a button tap into a recorded confirmation.
 *
 * This is the moment the product exists for, and the one place where being
 * wrong is worse than being unavailable: a confirmation recorded against the
 * wrong person, or silently not recorded at all, destroys the record's value
 * precisely when someone is relying on it.
 *
 * So every tap passes six gates, in this order, and a tap that fails any of
 * them still produces something visible rather than nothing.
 */

import { newId } from "../core/ids";
import { unscoped } from "../core/db";
import { getGroupMemberProfile } from "../core/line";
import type {
  ConfirmAction,
  Env,
  IdentityConfidence,
  ResolutionStatus,
} from "../core/types";

export interface PostbackData {
  action: ConfirmAction;
  decisionId: string;
  version: number;
  nonce: string;
}

/**
 * Postback payloads are `v1|action|decisionId|version|nonce`.
 *
 * Positional rather than JSON to stay well inside LINE's 300-character limit,
 * and versioned so an old card still in someone's chat history is recognisable
 * after the format changes rather than being misread.
 */
export function encodePostbackData(d: PostbackData): string {
  return `v1|${d.action}|${d.decisionId}|${d.version}|${d.nonce}`;
}

export function parsePostbackData(raw: string): PostbackData | null {
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== "v1") return null;

  const [, action, decisionId, versionText, nonce] = parts;
  if (action !== "confirm" && action !== "reject" && action !== "request_changes") return null;

  const version = Number(versionText);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!decisionId || !nonce) return null;

  return { action, decisionId, version, nonce };
}

export type PostbackOutcome =
  | { kind: "recorded"; confirmationId: string; decisionId: string; action: ConfirmAction;
      displayName: string | null; approvals: number; required: number; decided: boolean }
  | { kind: "unidentified"; confirmationId: string; decisionId: string; decisionNo: string }
  | { kind: "duplicate"; decisionId: string }
  | { kind: "rejected"; reason: PostbackRejection; detail?: string };

export type PostbackRejection =
  | "malformed_data"
  | "unknown_nonce"
  | "nonce_invalidated"
  | "nonce_expired"
  | "version_mismatch"
  | "group_mismatch"
  | "not_pending"
  | "not_an_approver";

interface NonceRow {
  nonce: string;
  organization_id: string;
  decision_id: string;
  version: number;
  action: string;
  bound_line_group_id: string;
  expires_at: number | null;
  invalidated_at: number | null;
}

interface DecisionRow {
  id: string;
  organization_id: string;
  project_id: string;
  decision_no: string;
  version: number;
  status: string;
  required_approval_count: number;
  line_group_id: string | null;
}

interface MemberRow {
  role: string;
  declared_name: string | null;
  display_name_last_seen: string | null;
  identity_confidence: string;
}

/** Roles permitted to confirm on the client's behalf. A crew member tapping a
 * card by accident must not be recorded as the client agreeing to a cost. */
const APPROVER_ROLES = new Set(["owner", "co_owner"]);

export interface PostbackInput {
  webhookEventId: string;
  data: string;
  sourceGroupId: string | null;
  sourceUserId: string | null;
  lineTimestamp: number;
  snapshotSha256Lookup?: (decisionId: string, version: number) => Promise<string | null>;
}

export async function handlePostback(
  env: Env,
  input: PostbackInput,
): Promise<PostbackOutcome> {
  const db = unscoped(env);

  // Gate 1 — the payload is one of ours and intact.
  const parsed = parsePostbackData(input.data);
  if (!parsed) return { kind: "rejected", reason: "malformed_data", detail: input.data.slice(0, 100) };

  // Redelivery check, ahead of every state gate.
  //
  // LINE retries an event it thinks we did not acknowledge. By then the first
  // delivery has usually already settled the decision, so the state gates
  // below would reject the retry as "already closed" and announce that to the
  // group -- a second message about an event that only happened once. Treating
  // a known event id as a no-op keeps a retry invisible, which is what it
  // should be.
  const alreadySeen = await db
    .prepare(
      `SELECT decision_id FROM confirmation WHERE webhook_event_id = ?`,
    )
    .bind(input.webhookEventId)
    .first<{ decision_id: string }>();
  if (alreadySeen) return { kind: "duplicate", decisionId: alreadySeen.decision_id };

  // Gate 2 — the nonce exists, is live, and has not expired.
  const nonce = await db
    .prepare(
      `SELECT nonce, organization_id, decision_id, version, action,
              bound_line_group_id, expires_at, invalidated_at
         FROM decision_nonce WHERE nonce = ?`,
    )
    .bind(parsed.nonce)
    .first<NonceRow>();
  if (!nonce) return { kind: "rejected", reason: "unknown_nonce" };
  if (nonce.invalidated_at) return { kind: "rejected", reason: "nonce_invalidated" };
  if (nonce.expires_at && nonce.expires_at < Date.now()) {
    return { kind: "rejected", reason: "nonce_expired" };
  }

  // Gate 3 — the tap belongs to the version the card was published at, so a
  // card still sitting in chat history cannot approve content it never showed.
  if (nonce.version !== parsed.version) {
    return { kind: "rejected", reason: "version_mismatch" };
  }

  // Gate 4 — the tap came from the group the card was published to. This is
  // what stops a forwarded card from being confirmed somewhere else.
  if (!input.sourceGroupId || input.sourceGroupId !== nonce.bound_line_group_id) {
    return { kind: "rejected", reason: "group_mismatch" };
  }

  const decision = await db
    .prepare(
      `SELECT id, organization_id, project_id, decision_no, version, status,
              required_approval_count, line_group_id
         FROM decision WHERE id = ? AND organization_id = ?`,
    )
    .bind(nonce.decision_id, nonce.organization_id)
    .first<DecisionRow>();
  if (!decision) return { kind: "rejected", reason: "unknown_nonce" };

  // Gate 5 — the decision is still open. A tap after the fact is recorded as
  // 'late' rather than discarded: the person did press it, and the record
  // should say so.
  const isLate = decision.status !== "pending";
  if (isLate && decision.status !== "expired") {
    return { kind: "rejected", reason: "not_pending", detail: decision.status };
  }

  const snapshotSha =
    (await input.snapshotSha256Lookup?.(decision.id, parsed.version)) ??
    (
      await db
        .prepare(
          `SELECT content_sha256 FROM decision_snapshot
            WHERE decision_id = ? AND version = ?`,
        )
        .bind(decision.id, parsed.version)
        .first<{ content_sha256: string }>()
    )?.content_sha256 ??
    "";

  const now = Date.now();
  const confirmationId = newId("cfm");

  // The documented-optional case. LINE supplies source.userId for group
  // postbacks in practice, but its own specification says otherwise, so an
  // absent id is handled as a first-class outcome: the act is recorded, the
  // decision does NOT advance, and the group is told what to do next.
  if (!input.sourceUserId) {
    await db
      .prepare(
        `INSERT INTO confirmation
           (id, organization_id, decision_id, version, line_group_id, action, channel,
            confirmed_by_user_id, identity_source, identity_confidence, resolution_status,
            confirm_text, content_sha256_at_confirm,
            line_provider_id, line_channel_id, line_event_timestamp, server_received_at,
            webhook_event_id, nonce_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'postback', NULL, 'postback_no_uid', 'unknown',
                 'unidentified', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        confirmationId,
        decision.organization_id,
        decision.id,
        parsed.version,
        nonce.bound_line_group_id,
        parsed.action,
        `（未能識別身分的${parsed.action === "confirm" ? "確認" : "回應"}點擊）`,
        snapshotSha,
        env.LINE_PROVIDER_ID,
        env.LINE_CHANNEL_ID,
        input.lineTimestamp,
        now,
        input.webhookEventId,
        parsed.nonce,
        now,
      )
      .run();

    // Escalate this group to LIFF-backed confirmation so the next attempt has
    // a path that can identify the person.
    await db
      .prepare(`UPDATE line_group SET liff_required = 1 WHERE line_group_id = ?`)
      .bind(nonce.bound_line_group_id)
      .run();

    return {
      kind: "unidentified",
      confirmationId,
      decisionId: decision.id,
      decisionNo: decision.decision_no,
    };
  }

  // Gate 6 — the person is entitled to answer for this decision.
  const member = await db
    .prepare(
      `SELECT gm.role, gm.declared_name, gm.display_name_last_seen, gm.identity_confidence
         FROM group_member gm
         JOIN line_group lg ON lg.id = gm.line_group_id
        WHERE lg.line_group_id = ? AND gm.line_user_id = ?`,
    )
    .bind(nonce.bound_line_group_id, input.sourceUserId)
    .first<MemberRow>();

  if (member && !APPROVER_ROLES.has(member.role) && member.role !== "unknown") {
    return { kind: "rejected", reason: "not_an_approver", detail: member.role };
  }

  // Names change and members leave, after which they can no longer be looked
  // up — so the name is captured now, at the moment being attested to.
  let displayName = member?.display_name_last_seen ?? null;
  let snapshotSource = "group_member";
  if (!displayName) {
    const profile = await getGroupMemberProfile(env, nonce.bound_line_group_id, input.sourceUserId);
    if (profile.ok) {
      displayName = profile.displayName;
      snapshotSource = "member_profile";
    }
  }

  const confidence: IdentityConfidence =
    (member?.identity_confidence as IdentityConfidence | undefined) ??
    (displayName ? "seen_before" : "unknown");
  const resolution: ResolutionStatus = isLate ? "late" : "resolved";

  const confirmText =
    parsed.action === "confirm"
      ? `我已閱讀並同意 ${decision.decision_no} 所載內容、金額及工期影響`
      : parsed.action === "reject"
        ? `我不同意 ${decision.decision_no}`
        : `我要求修改 ${decision.decision_no}`;

  const insert = await db
    .prepare(
      `INSERT INTO confirmation
         (id, organization_id, decision_id, version, line_group_id, action, channel,
          confirmed_by_user_id, identity_source, identity_confidence, resolution_status,
          display_name_snapshot, snapshot_source, declared_name, declared_role,
          confirm_text, content_sha256_at_confirm,
          line_provider_id, line_channel_id, line_event_timestamp, server_received_at,
          webhook_event_id, nonce_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'postback', ?, 'postback', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      confirmationId,
      decision.organization_id,
      decision.id,
      parsed.version,
      nonce.bound_line_group_id,
      parsed.action,
      input.sourceUserId,
      confidence,
      resolution,
      displayName,
      snapshotSource,
      member?.declared_name ?? null,
      member?.role ?? null,
      confirmText,
      snapshotSha,
      env.LINE_PROVIDER_ID,
      env.LINE_CHANNEL_ID,
      input.lineTimestamp,
      now,
      input.webhookEventId,
      parsed.nonce,
      now,
    )
    .run();

  // Either LINE redelivered this event, or this person already voted. Both
  // mean: change nothing, and do not announce it a second time.
  if ((insert.meta.changes ?? 0) === 0) {
    return { kind: "duplicate", decisionId: decision.id };
  }

  const tally = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM confirmation
        WHERE decision_id = ? AND version = ? AND action = 'confirm'
          AND resolution_status IN ('resolved', 'late')
          AND confirmed_by_user_id IS NOT NULL`,
    )
    .bind(decision.id, parsed.version)
    .first<{ n: number }>();
  const approvals = tally?.n ?? 0;
  const required = decision.required_approval_count;

  // A rejection lands immediately; there is no point waiting for a second
  // opinion once someone has said no.
  let decided = false;
  if (parsed.action === "reject") {
    await db
      .prepare(`UPDATE decision SET status = 'rejected', decided_at = ? WHERE id = ?`)
      .bind(now, decision.id)
      .run();
    decided = true;
  } else if (parsed.action === "request_changes") {
    await db
      .prepare(`UPDATE decision SET status = 'request_changes', decided_at = ? WHERE id = ?`)
      .bind(now, decision.id)
      .run();
    decided = true;
  } else if (approvals >= required && !isLate) {
    await db
      .prepare(`UPDATE decision SET status = 'confirmed', decided_at = ? WHERE id = ?`)
      .bind(now, decision.id)
      .run();
    decided = true;
  }

  return {
    kind: "recorded",
    confirmationId,
    decisionId: decision.id,
    action: parsed.action,
    displayName,
    approvals,
    required,
    decided,
  };
}
