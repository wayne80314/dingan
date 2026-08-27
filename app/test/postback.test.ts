import { beforeEach, describe, expect, it } from "vitest";
import { encodePostbackData, handlePostback, parsePostbackData } from "../src/hook/postback";
import { newNonce } from "../src/core/ids";
import {
  CREW_USER_ID,
  OWNER_USER_ID,
  confirmationCount,
  decisionStatus,
  resetDb,
  seedPublishedDecision,
  testEnv,
} from "./helpers";

let eventSeq = 0;
function nextEventId(): string {
  eventSeq += 1;
  return `evt-${eventSeq}-${Date.now()}`;
}

beforeEach(resetDb);

describe("postback data encoding", () => {
  it("round-trips", () => {
    const d = { action: "confirm" as const, decisionId: "dec_X", version: 2, nonce: "abc" };
    expect(parsePostbackData(encodePostbackData(d))).toEqual(d);
  });

  it("rejects a payload from an unknown format version", () => {
    expect(parsePostbackData("v2|confirm|dec_X|1|abc")).toBeNull();
  });

  it("rejects an unknown action", () => {
    expect(parsePostbackData("v1|delete|dec_X|1|abc")).toBeNull();
  });

  it("rejects a non-numeric version", () => {
    expect(parsePostbackData("v1|confirm|dec_X|abc|nonce")).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(parsePostbackData("v1|confirm|dec_X")).toBeNull();
    expect(parsePostbackData("")).toBeNull();
  });

  it("stays inside LINE's 300-character postback limit for realistic ids", () => {
    const encoded = encodePostbackData({
      action: "request_changes",
      decisionId: "dec_01J9ZQ8XYZABCDEFGHJKMNPQRS",
      version: 12,
      nonce: newNonce(),
    });
    expect(encoded.length).toBeLessThan(300);
  });
});

describe("the six gates", () => {
  it("records a confirmation when every gate passes", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });

    expect(outcome.kind).toBe("recorded");
    if (outcome.kind !== "recorded") return;
    expect(outcome.displayName).toBe("大明");
    expect(outcome.decided).toBe(true);
    expect(await decisionStatus(f.decisionId)).toBe("confirmed");
  });

  it("gate 1: refuses a payload it cannot parse", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: "garbage",
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "malformed_data" });
    expect(await confirmationCount(f.decisionId)).toBe(0);
  });

  it("gate 2: refuses a nonce it has never issued", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: newNonce() }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "unknown_nonce" });
  });

  it("gate 2: refuses an invalidated nonce", async () => {
    const f = await seedPublishedDecision();
    await testEnv.DB.prepare(`UPDATE decision_nonce SET invalidated_at = ? WHERE nonce = ?`)
      .bind(Date.now(), f.nonce)
      .run();

    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "nonce_invalidated" });
  });

  it("gate 2: refuses an expired nonce", async () => {
    const f = await seedPublishedDecision({ nonceExpiresAt: Date.now() - 1000 });
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "nonce_expired" });
  });

  // An old card sitting in chat history must not approve content it never
  // displayed.
  it("gate 3: refuses a tap whose version no longer matches", async () => {
    const f = await seedPublishedDecision({ version: 2 });
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "version_mismatch" });
    expect(await confirmationCount(f.decisionId)).toBe(0);
  });

  // The defence against a forwarded card: an agreement recorded from a chat
  // nobody involved can see would be worse than no record at all.
  it("gate 4: refuses a tap from a different group", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: "Csomewhereelse0000000000000000",
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "group_mismatch" });
    expect(await confirmationCount(f.decisionId)).toBe(0);
  });

  it("gate 4: refuses a tap with no group at all, such as a 1:1 chat", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: null,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "group_mismatch" });
  });

  it("gate 5: refuses a tap on a decision that is already settled", async () => {
    const f = await seedPublishedDecision({ decisionStatus: "confirmed" });
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "not_pending" });
  });

  // The person really did press it, so the act is recorded -- just marked as
  // arriving after the decision lapsed.
  it("gate 5: records a tap on an expired decision, flagged as late", async () => {
    const f = await seedPublishedDecision({ decisionStatus: "expired" });
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome.kind).toBe("recorded");

    const row = await testEnv.DB.prepare(
      `SELECT resolution_status FROM confirmation WHERE decision_id = ?`,
    )
      .bind(f.decisionId)
      .first<{ resolution_status: string }>();
    expect(row?.resolution_status).toBe("late");
    // A late tap must not resurrect a lapsed decision.
    expect(await decisionStatus(f.decisionId)).toBe("expired");
  });

  it("gate 6: refuses a tap from someone who is not an approver", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: CREW_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "rejected", reason: "not_an_approver" });
    expect(await confirmationCount(f.decisionId)).toBe(0);
    expect(await decisionStatus(f.decisionId)).toBe("pending");
  });
});

describe("identity that cannot be resolved", () => {
  // LINE supplies source.userId for group postbacks in practice, but documents
  // it as message-events-only. The absent case is recorded as a visible
  // non-event rather than silently dropped or silently attributed.
  it("records the tap, withholds the decision, and escalates the group", async () => {
    const f = await seedPublishedDecision();
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: null,
      lineTimestamp: Date.now(),
    });

    expect(outcome.kind).toBe("unidentified");
    expect(await confirmationCount(f.decisionId)).toBe(1);
    expect(await decisionStatus(f.decisionId)).toBe("pending");

    const row = await testEnv.DB.prepare(
      `SELECT confirmed_by_user_id, identity_source, resolution_status
         FROM confirmation WHERE decision_id = ?`,
    )
      .bind(f.decisionId)
      .first<{ confirmed_by_user_id: string | null; identity_source: string; resolution_status: string }>();
    expect(row?.confirmed_by_user_id).toBeNull();
    expect(row?.identity_source).toBe("postback_no_uid");
    expect(row?.resolution_status).toBe("unidentified");

    const grp = await testEnv.DB.prepare(
      `SELECT liff_required FROM line_group WHERE line_group_id = ?`,
    )
      .bind(f.lineGroupId)
      .first<{ liff_required: number }>();
    expect(grp?.liff_required).toBe(1);
  });
});

describe("idempotency and repeat taps", () => {
  it("treats a redelivered webhook event as a duplicate", async () => {
    const f = await seedPublishedDecision();
    const eventId = nextEventId();
    const data = encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce });

    const first = await handlePostback(testEnv, {
      webhookEventId: eventId,
      data,
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(first.kind).toBe("recorded");

    const second = await handlePostback(testEnv, {
      webhookEventId: eventId,
      data,
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(second.kind).toBe("duplicate");
    expect(await confirmationCount(f.decisionId)).toBe(1);
  });

  it("counts one vote per person even when they tap twice", async () => {
    const f = await seedPublishedDecision({ requiredApprovalCount: 2 });
    const data = encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce });

    await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data,
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    const second = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data,
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });

    expect(second.kind).toBe("duplicate");
    expect(await confirmationCount(f.decisionId)).toBe(1);
    // One person cannot satisfy a two-approver requirement by tapping twice.
    expect(await decisionStatus(f.decisionId)).toBe("pending");
  });
});

describe("multiple approvers", () => {
  it("waits for the required count before settling", async () => {
    const f = await seedPublishedDecision({ requiredApprovalCount: 2 });
    await testEnv.DB.prepare(
      `INSERT INTO group_member
         (line_group_id, line_user_id, organization_id, project_id, role,
          declared_name, display_name_last_seen, identity_confidence, first_seen_at)
       VALUES (?, ?, ?, ?, 'co_owner', '陳美華', '美華', 'whitelisted', ?)`,
    )
      .bind(f.groupRowId, "Uspouse0000000000000000000000001", f.orgId, f.projectId, Date.now())
      .run();

    const data = encodePostbackData({ action: "confirm", decisionId: f.decisionId, version: 1, nonce: f.nonce });

    const first = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data,
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(first).toMatchObject({ kind: "recorded", approvals: 1, required: 2, decided: false });
    expect(await decisionStatus(f.decisionId)).toBe("pending");

    const second = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data,
      sourceGroupId: f.lineGroupId,
      sourceUserId: "Uspouse0000000000000000000000001",
      lineTimestamp: Date.now(),
    });
    expect(second).toMatchObject({ kind: "recorded", approvals: 2, decided: true });
    expect(await decisionStatus(f.decisionId)).toBe("confirmed");
  });

  // No point collecting a second opinion once someone has said no.
  it("settles a rejection immediately, without waiting for others", async () => {
    const f = await seedPublishedDecision({ requiredApprovalCount: 2 });
    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "reject", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(outcome).toMatchObject({ kind: "recorded", decided: true });
    expect(await decisionStatus(f.decisionId)).toBe("rejected");
  });

  it("routes a request for changes back to the designer", async () => {
    const f = await seedPublishedDecision();
    await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      data: encodePostbackData({ action: "request_changes", decisionId: f.decisionId, version: 1, nonce: f.nonce }),
      sourceGroupId: f.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });
    expect(await decisionStatus(f.decisionId)).toBe("request_changes");
  });
});

describe("tenant isolation", () => {
  // A nonce is scoped to the organization that issued it. Pairing it with a
  // decision belonging to someone else must find nothing, not cross the
  // boundary.
  it("will not apply one organization's nonce to another's decision", async () => {
    const a = await seedPublishedDecision({ lineGroupId: "Cgroup_a00000000000000000000001" });
    const b = await seedPublishedDecision({ lineGroupId: "Cgroup_b00000000000000000000001" });

    const outcome = await handlePostback(testEnv, {
      webhookEventId: nextEventId(),
      // b's nonce, pointed at a's decision.
      data: encodePostbackData({ action: "confirm", decisionId: a.decisionId, version: 1, nonce: b.nonce }),
      sourceGroupId: b.lineGroupId,
      sourceUserId: OWNER_USER_ID,
      lineTimestamp: Date.now(),
    });

    // The nonce resolves to b's decision, and the group matches b, so this is
    // recorded against b -- never against a.
    expect(await confirmationCount(a.decisionId)).toBe(0);
    if (outcome.kind === "recorded") {
      expect(outcome.decisionId).toBe(b.decisionId);
    }
  });
});
