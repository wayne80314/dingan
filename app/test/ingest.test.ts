import { beforeEach, describe, expect, it } from "vitest";
import { ingestEvent } from "../src/hook/ingest";
import { newId } from "../src/core/ids";
import { resetDb, testEnv } from "./helpers";
import type { ParsedEvent } from "../src/hook/webhook";

const LINE_GROUP = "Cingestgroup00000000000000000001";
const SPEAKER = "Uspeaker0000000000000000000000001";

let seq = 0;
function event(type: string, raw: Record<string, unknown>): ParsedEvent {
  seq += 1;
  const webhookEventId = `evt-ing-${seq}`;
  return {
    webhookEventId,
    eventType: type,
    lineGroupId: LINE_GROUP,
    isRedelivery: false,
    raw: { type, webhookEventId, timestamp: Date.now(), ...raw },
  };
}

function messageEvent(text: string, userId: string | null = SPEAKER): ParsedEvent {
  seq += 1;
  return event("message", {
    source: userId
      ? { type: "group", groupId: LINE_GROUP, userId }
      : { type: "group", groupId: LINE_GROUP },
    message: { id: `linemsg-${seq}`, type: "text", text },
  });
}

async function seedGroup(status: "unclaimed" | "active"): Promise<{ orgId: string; projectId: string; groupRowId: string }> {
  const now = Date.now();
  const orgId = newId("org");
  const projectId = newId("prj");
  const groupRowId = newId("grp");

  await testEnv.DB.prepare(
    `INSERT INTO organization (id, name, line_provider_id, line_channel_id, created_at)
     VALUES (?, '工作室', 'test_provider', 'test_channel', ?)`,
  ).bind(orgId, now).run();
  await testEnv.DB.prepare(
    `INSERT INTO project (id, organization_id, name, created_at) VALUES (?, ?, '案件', ?)`,
  ).bind(projectId, orgId, now).run();
  await testEnv.DB.prepare(
    `INSERT INTO line_group
       (id, organization_id, project_id, line_provider_id, line_channel_id,
        line_group_id, status, joined_at)
     VALUES (?, ?, ?, 'test_provider', 'test_channel', ?, ?, ?)`,
  ).bind(
    groupRowId,
    status === "active" ? orgId : null,
    status === "active" ? projectId : null,
    LINE_GROUP,
    status,
    now,
  ).run();

  return { orgId, projectId, groupRowId };
}

async function messageCount(): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM line_message`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(resetDb);

describe("the privacy gate", () => {
  // Until someone claims the group into a project, the bot is in a chat whose
  // purpose it does not know. Storing the conversation and filtering later is
  // a different promise from never storing it.
  it("stores no message content for an unclaimed group", async () => {
    await seedGroup("unclaimed");
    await ingestEvent(testEnv, messageEvent("客廳磁磚想換成薄板"));
    expect(await messageCount()).toBe(0);
  });

  it("stores messages once the group has been claimed", async () => {
    await seedGroup("active");
    await ingestEvent(testEnv, messageEvent("客廳磁磚想換成薄板"));
    expect(await messageCount()).toBe(1);

    const row = await testEnv.DB.prepare(
      `SELECT text_content, has_user_id FROM line_message`,
    ).first<{ text_content: string; has_user_id: number }>();
    expect(row?.text_content).toBe("客廳磁磚想換成薄板");
    expect(row?.has_user_id).toBe(1);
  });

  it("ignores messages from a group it has never been added to", async () => {
    await ingestEvent(testEnv, messageEvent("hello"));
    expect(await messageCount()).toBe(0);
  });
});

describe("passive monitoring of sender identity", () => {
  // The product leans on group events carrying the sender's id, which LINE
  // does not promise. This column is the cheapest possible early warning that
  // the behaviour changed.
  it("flags a message that arrived without a sender id", async () => {
    await seedGroup("active");
    await ingestEvent(testEnv, messageEvent("誰傳的不知道", null));

    const row = await testEnv.DB.prepare(
      `SELECT has_user_id, line_user_id FROM line_message`,
    ).first<{ has_user_id: number; line_user_id: string | null }>();
    expect(row?.has_user_id).toBe(0);
    expect(row?.line_user_id).toBeNull();
  });

  it("supports reading the ratio across recent messages", async () => {
    await seedGroup("active");
    await ingestEvent(testEnv, messageEvent("a"));
    await ingestEvent(testEnv, messageEvent("b"));
    await ingestEvent(testEnv, messageEvent("c", null));

    const row = await testEnv.DB.prepare(
      `SELECT SUM(has_user_id) AS withId, COUNT(*) AS total FROM line_message`,
    ).first<{ withId: number; total: number }>();
    expect(row?.withId).toBe(2);
    expect(row?.total).toBe(3);
  });
});

describe("membership", () => {
  it("records an unfamiliar speaker so they can later be assigned a role", async () => {
    const g = await seedGroup("active");
    await ingestEvent(testEnv, messageEvent("我是業主"));

    const member = await testEnv.DB.prepare(
      `SELECT role, identity_confidence FROM group_member
        WHERE line_group_id = ? AND line_user_id = ?`,
    ).bind(g.groupRowId, SPEAKER).first<{ role: string; identity_confidence: string }>();

    expect(member?.role).toBe("unknown");
    // Merely having spoken is the weakest form of identity, and is labelled
    // as such rather than being treated as confirmed.
    expect(member?.identity_confidence).toBe("seen_before");
  });

  it("marks a departing member instead of deleting them", async () => {
    const g = await seedGroup("active");
    await ingestEvent(testEnv, messageEvent("bye"));

    await ingestEvent(
      testEnv,
      event("memberLeft", {
        source: { type: "group", groupId: LINE_GROUP },
        left: { members: [{ type: "user", userId: SPEAKER }] },
      }),
    );

    // A confirmation they gave still refers to them, so the row stays.
    const member = await testEnv.DB.prepare(
      `SELECT left_at FROM group_member WHERE line_group_id = ? AND line_user_id = ?`,
    ).bind(g.groupRowId, SPEAKER).first<{ left_at: number | null }>();
    expect(member?.left_at).toBeTruthy();
  });
});

describe("leaving a group", () => {
  it("stops recording without erasing what was already stored", async () => {
    await seedGroup("active");
    await ingestEvent(testEnv, messageEvent("先前的討論"));
    expect(await messageCount()).toBe(1);

    await ingestEvent(testEnv, event("leave", { source: { type: "group", groupId: LINE_GROUP } }));

    const group = await testEnv.DB.prepare(
      `SELECT status, left_at FROM line_group WHERE line_group_id = ?`,
    ).bind(LINE_GROUP).first<{ status: string; left_at: number | null }>();
    expect(group?.status).toBe("left");
    expect(group?.left_at).toBeTruthy();

    // Already-stored history may be cited by a decision, so it stays.
    expect(await messageCount()).toBe(1);

    // Nothing further is recorded.
    await ingestEvent(testEnv, messageEvent("之後的討論"));
    expect(await messageCount()).toBe(1);
  });
});

describe("unsend", () => {
  // The sender withdrew the message, so the content goes; the fact that a
  // message existed and was withdrawn stays, because a decision citing it
  // would otherwise point at a gap.
  it("clears the content but keeps the record of withdrawal", async () => {
    await seedGroup("active");
    const msg = messageEvent("這句話我要收回");
    await ingestEvent(testEnv, msg);

    const stored = await testEnv.DB.prepare(
      `SELECT line_message_id FROM line_message`,
    ).first<{ line_message_id: string }>();
    expect(stored).toBeTruthy();

    await ingestEvent(
      testEnv,
      event("unsend", {
        source: { type: "group", groupId: LINE_GROUP, userId: SPEAKER },
        unsend: { messageId: stored!.line_message_id },
      }),
    );

    const row = await testEnv.DB.prepare(
      `SELECT text_content, unsent_at FROM line_message WHERE line_message_id = ?`,
    ).bind(stored!.line_message_id).first<{ text_content: string | null; unsent_at: number | null }>();
    expect(row?.text_content).toBeNull();
    expect(row?.unsent_at).toBeTruthy();
    expect(await messageCount()).toBe(1);
  });
});

describe("redelivery", () => {
  it("stores a repeated message only once", async () => {
    await seedGroup("active");
    const msg = messageEvent("重送測試");
    await ingestEvent(testEnv, msg);
    await ingestEvent(testEnv, msg);
    expect(await messageCount()).toBe(1);
  });
});

describe("unknown event types", () => {
  it("passes over an event type it does not handle without failing", async () => {
    await seedGroup("active");
    await expect(
      ingestEvent(testEnv, event("somethingNewFromLine", { source: { type: "group", groupId: LINE_GROUP } })),
    ).resolves.toBeUndefined();
  });
});
