/**
 * Shared fixture builders + signing helper for tests. Deliberately lives as
 * a .ts helper (not static .json files) so every fixture is always signed
 * against whatever TEST_CHANNEL_SECRET the current test run actually uses
 * (see vitest.config.ts's LINE_CHANNEL_SECRET binding) instead of a
 * separately-maintained pre-computed signature going stale.
 */

export const TEST_CHANNEL_SECRET = "test_channel_secret";

export async function signBody(body: string, secret = TEST_CHANNEL_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function textMessageEvent(opts: {
  groupId: string;
  userId?: string;
  text?: string;
  webhookEventId?: string;
  isRedelivery?: boolean;
  timestamp?: number;
}) {
  return {
    type: "message",
    webhookEventId: opts.webhookEventId ?? nextId("wh"),
    deliveryContext: { isRedelivery: opts.isRedelivery ?? false },
    timestamp: opts.timestamp ?? Date.now(),
    mode: "active",
    source: opts.userId
      ? { type: "group", groupId: opts.groupId, userId: opts.userId }
      : { type: "group", groupId: opts.groupId },
    replyToken: nextId("reply"),
    message: { id: nextId("msg"), type: "text", text: opts.text ?? "hello" },
  };
}

export function postbackEvent(opts: {
  groupId: string;
  userId?: string;
  data?: string;
  webhookEventId?: string;
  isRedelivery?: boolean;
}) {
  return {
    type: "postback",
    webhookEventId: opts.webhookEventId ?? nextId("wh"),
    deliveryContext: { isRedelivery: opts.isRedelivery ?? false },
    timestamp: Date.now(),
    mode: "active",
    source: opts.userId
      ? { type: "group", groupId: opts.groupId, userId: opts.userId }
      : { type: "group", groupId: opts.groupId },
    replyToken: nextId("reply"),
    postback: { data: opts.data ?? "confirm:D-001" },
  };
}

export function messageEditedEvent(opts: {
  groupId: string;
  userId?: string;
  messageId: string;
  text: string;
  timestamp?: number;
  webhookEventId?: string;
}) {
  return {
    type: "messageEdited",
    webhookEventId: opts.webhookEventId ?? nextId("wh"),
    deliveryContext: { isRedelivery: false },
    timestamp: opts.timestamp ?? Date.now(),
    mode: "active",
    source: opts.userId
      ? { type: "group", groupId: opts.groupId, userId: opts.userId }
      : { type: "group", groupId: opts.groupId },
    replyToken: nextId("reply"),
    message: { id: opts.messageId, type: "text", text: opts.text },
  };
}

export function unsendEvent(opts: { groupId: string; userId?: string; messageId: string }) {
  return {
    type: "unsend",
    webhookEventId: nextId("wh"),
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    mode: "active",
    source: opts.userId
      ? { type: "group", groupId: opts.groupId, userId: opts.userId }
      : { type: "group", groupId: opts.groupId },
    unsend: { messageId: opts.messageId },
  };
}

export function memberJoinedEvent(opts: { groupId: string; userIds: string[] }) {
  return {
    type: "memberJoined",
    webhookEventId: nextId("wh"),
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    mode: "active",
    source: { type: "group", groupId: opts.groupId },
    replyToken: nextId("reply"),
    joined: { members: opts.userIds.map((userId) => ({ type: "user", userId })) },
  };
}

export function webhookBody(events: unknown[]) {
  return JSON.stringify({ destination: "Uxxxxdestination", events });
}
