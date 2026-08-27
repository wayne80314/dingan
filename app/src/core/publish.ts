/**
 * Publishing a decision to a group.
 *
 * Four things have to become true together: the content is frozen, a nonce
 * exists that the resulting tap can be checked against, the card is queued for
 * sending, and the decision is marked as awaiting an answer. Any subset is a
 * defect — a queued card with no nonce cannot be confirmed, a nonce with no
 * card is a token for something nobody saw.
 *
 * D1 batches roll back as a unit (verified against real D1 in M0.0), so this
 * is written as one batch rather than a sequence with compensating cleanup.
 */

import { canonicalizeAndHash, type CanonicalValue } from "./canonical";
import { buildDecisionCard, type CardLineItem } from "./flex";
import { newId, newNonce } from "./ids";
import { enqueueStatement } from "./outbox";
import { formatQuantity } from "./money";
import { unscoped } from "./db";
import { getGroupMemberCount } from "./line";
import type { Env } from "./types";

export interface PublishInput {
  organizationId: string;
  projectId: string;
  decisionId: string;
  /** LINE's C-prefixed group id. */
  lineGroupId: string;
  /** Optional override; otherwise looked up from LINE, which excludes the bot
   * and so is already the billable recipient count. */
  recipientCount?: number;
  expiresAt?: number | null;
  liffUrl?: string | null;
}

export type PublishResult =
  | { ok: true; version: number; nonce: string; contentSha256: string; outboxId: string }
  | { ok: false; reason: "not_found" | "not_publishable" | "no_recipient_count"; detail?: string };

interface DecisionRow {
  id: string;
  organization_id: string;
  project_id: string;
  decision_no: string;
  version: number;
  title: string;
  change_scope: string | null;
  change_reason: string | null;
  tax_mode: string;
  tax_rate_bp: number;
  amount_ex_tax_cents: number;
  amount_tax_cents: number;
  amount_inc_tax_cents: number;
  schedule_delta_days: number;
  required_approval_count: number;
  status: string;
}

interface LineItemRow {
  seq: number;
  area: string | null;
  description: string;
  spec_note: string | null;
  unit: string;
  quantity_milli: number;
  unit_price_cents: number;
  line_total_cents: number;
}

/**
 * The exact content a confirmation attests to.
 *
 * Quantities become fixed-precision strings here: a float has no stable
 * textual form, and this value has to hash identically when recomputed later
 * on a different machine.
 */
function buildCanonicalContent(
  decision: DecisionRow,
  items: LineItemRow[],
  version: number,
): CanonicalValue {
  return {
    decisionNo: decision.decision_no,
    version,
    title: decision.title,
    changeScope: decision.change_scope ?? "",
    changeReason: decision.change_reason ?? "",
    taxMode: decision.tax_mode,
    taxRateBp: decision.tax_rate_bp,
    amountExTaxCents: decision.amount_ex_tax_cents,
    amountTaxCents: decision.amount_tax_cents,
    amountIncTaxCents: decision.amount_inc_tax_cents,
    scheduleDeltaDays: decision.schedule_delta_days,
    requiredApprovalCount: decision.required_approval_count,
    lineItems: items.map((i) => ({
      seq: i.seq,
      area: i.area ?? "",
      description: i.description,
      specNote: i.spec_note ?? "",
      unit: i.unit,
      quantity: formatQuantity(i.quantity_milli),
      unitPriceCents: i.unit_price_cents,
      lineTotalCents: i.line_total_cents,
    })),
  };
}

export async function publishDecision(
  env: Env,
  input: PublishInput,
): Promise<PublishResult> {
  const db = unscoped(env);

  const decision = await db
    .prepare(
      `SELECT id, organization_id, project_id, decision_no, version, title,
              change_scope, change_reason, tax_mode, tax_rate_bp,
              amount_ex_tax_cents, amount_tax_cents, amount_inc_tax_cents,
              schedule_delta_days, required_approval_count, status
         FROM decision
        WHERE id = ? AND organization_id = ?`,
    )
    .bind(input.decisionId, input.organizationId)
    .first<DecisionRow>();

  if (!decision) return { ok: false, reason: "not_found" };

  // A confirmed decision is never re-published; correcting one means issuing a
  // revision, so that the original and its approvals stay intact.
  if (decision.status !== "draft" && decision.status !== "request_changes") {
    return { ok: false, reason: "not_publishable", detail: decision.status };
  }

  const itemsResult = await db
    .prepare(
      `SELECT seq, area, description, spec_note, unit, quantity_milli,
              unit_price_cents, line_total_cents
         FROM decision_line_item
        WHERE decision_id = ? AND version = ?
        ORDER BY seq ASC`,
    )
    .bind(decision.id, decision.version)
    .all<LineItemRow>();
  const items = itemsResult.results ?? [];

  // Re-publishing after a change request produces a new version, so a card
  // still sitting in chat history cannot approve content it never displayed.
  const version = decision.status === "request_changes" ? decision.version + 1 : decision.version;

  let recipientCount = input.recipientCount ?? null;
  if (recipientCount === null) {
    const count = await getGroupMemberCount(env, input.lineGroupId);
    recipientCount = count.count;
  }
  if (recipientCount === null) {
    // Sending without knowing the recipient count would mean charging quota we
    // cannot account for, so the publish stops here rather than guessing.
    return { ok: false, reason: "no_recipient_count" };
  }

  const { canonicalJson, contentSha256 } = await canonicalizeAndHash(
    buildCanonicalContent(decision, items, version),
  );

  // Already published at this version.
  //
  // The batch below is atomic, so a snapshot here means the whole publish
  // succeeded — the caller simply did not learn that, typically because the
  // response was lost. Returning the existing state makes publishing idempotent
  // rather than throwing on a unique-constraint violation, which would surface
  // as a server error for what is really a duplicate request.
  const existing = await db
    .prepare(
      `SELECT s.content_sha256, n.nonce, o.id AS outbox_id
         FROM decision_snapshot s
         LEFT JOIN decision_nonce n
           ON n.decision_id = s.decision_id AND n.version = s.version
          AND n.invalidated_at IS NULL
         LEFT JOIN outbox o ON o.dedupe_key = ?
        WHERE s.decision_id = ? AND s.version = ?`,
    )
    .bind(`decision_card:${decision.id}:${version}`, decision.id, version)
    .first<{ content_sha256: string; nonce: string | null; outbox_id: string | null }>();

  if (existing) {
    return {
      ok: true,
      version,
      nonce: existing.nonce ?? "",
      contentSha256: existing.content_sha256,
      outboxId: existing.outbox_id ?? "",
    };
  }

  const nonce = newNonce();
  const snapshotId = newId("snp");
  const outboxId = newId("obx");
  const now = Date.now();

  const cardLineItems: CardLineItem[] = items.map((i) => ({
    description: i.description,
    area: i.area,
    unit: i.unit,
    quantityMilli: i.quantity_milli,
    unitPriceCents: i.unit_price_cents,
    lineTotalCents: i.line_total_cents,
  }));

  const card = buildDecisionCard({
    decisionNo: decision.decision_no,
    version,
    title: decision.title,
    changeScope: decision.change_scope,
    changeReason: decision.change_reason,
    amountIncTaxCents: decision.amount_inc_tax_cents,
    scheduleDeltaDays: decision.schedule_delta_days,
    lineItems: cardLineItems,
    contentSha256,
    requiredApprovalCount: decision.required_approval_count,
    decisionId: decision.id,
    nonce,
    liffUrl: input.liffUrl ?? null,
  });

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO decision_snapshot
           (id, organization_id, decision_id, version, canonical_json, content_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(snapshotId, decision.organization_id, decision.id, version, canonicalJson, contentSha256, now),

    db
      .prepare(
        `INSERT INTO decision_nonce
           (nonce, organization_id, decision_id, version, action, bound_line_group_id,
            issued_at, expires_at)
         VALUES (?, ?, ?, ?, 'confirm', ?, ?, ?)`,
      )
      .bind(
        nonce,
        decision.organization_id,
        decision.id,
        version,
        input.lineGroupId,
        now,
        input.expiresAt ?? null,
      ),

    // Superseding earlier nonces for this decision is what stops an older card
    // in the chat from still being tappable after a revision goes out.
    db
      .prepare(
        `UPDATE decision_nonce SET invalidated_at = ?
          WHERE decision_id = ? AND version < ? AND invalidated_at IS NULL`,
      )
      .bind(now, decision.id, version),

    enqueueStatement(env, outboxId, crypto.randomUUID(), {
      organizationId: decision.organization_id,
      projectId: decision.project_id,
      lineGroupId: input.lineGroupId,
      kind: "decision_card",
      messages: [card],
      recipientCount,
      // Same decision and version means the same card: a retried publish
      // cannot put two of them in front of a client.
      dedupeKey: `decision_card:${decision.id}:${version}`,
      priority: 2,
    }),

    db
      .prepare(
        `UPDATE decision
            SET status = 'pending', version = ?, published_at = ?, line_group_id =
                  (SELECT id FROM line_group WHERE line_group_id = ? AND status = 'active')
          WHERE id = ?`,
      )
      .bind(version, now, input.lineGroupId, decision.id),
  ];

  await db.batch(statements);

  return { ok: true, version, nonce, contentSha256, outboxId };
}
