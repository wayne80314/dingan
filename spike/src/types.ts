/**
 * Shared types for the F0 Spike Worker.
 *
 * LINE Messaging API facts verified against developers.line.biz on
 * 2026-08-27 (WebFetch/WebSearch against the official reference docs and
 * the line-bot-sdk-nodejs source, which is generated from LINE's own OpenAPI
 * spec). Re-verify before reusing any of this in the M0 product build if
 * enough time has passed that LINE may have changed something.
 *
 * 1. Webhook signature: HMAC-SHA256 over the raw, unparsed request body
 *    bytes, keyed with the channel secret, output Base64-encoded, carried
 *    in the `x-line-signature` request header (header names are
 *    case-insensitive over HTTP, so `X-Line-Signature` is the same header).
 *
 * 2. Webhook event `type` values, full set as of verification date:
 *    message, messageEdited, unsend, follow, unfollow, join, leave,
 *    memberJoined, memberLeft, postback, videoPlayComplete, beacon,
 *    accountLink, membership.
 *    IMPORTANT CORRECTION vs. this spike's original brief: the brief
 *    assumed LINE has no "message edit" event and only has `unsend`. That
 *    assumption is now out of date -- LINE added an edit event, webhook
 *    `type` value `"messageEdited"`, group-chat only (not available in 1:1
 *    chats), text messages only, carries a `replyToken`. Multiple
 *    `messageEdited` events for the same message can arrive out of order;
 *    the event with the largest `timestamp` represents the latest edit.
 *    report.ts's redelivery/out-of-order matrix item must account for this
 *    when it looks at messageEdited specifically, not just at
 *    deliveryContext.isRedelivery.
 *
 * 3. Group/room `source.userId` guarantee: LINE's own docs are NOT
 *    consistent/clear on when a group-chat source object is guaranteed to
 *    carry `userId` (e.g. for a postback from someone who has not added the
 *    bot as a friend, or who has blocked it). Different doc passages and
 *    summaries give different, partial answers. This is exactly the
 *    open question this spike exists to answer empirically -- do NOT bake
 *    an assumed answer into code or types. `userId` is modeled as optional
 *    on GroupSource/RoomSource and that must stay optional.
 *
 * 4. Group member profile API: GET /v2/bot/group/{groupId}/member/{userId}
 *    (confirmed against the line-bot-sdk-nodejs generated client -- no
 *    trailing /profile segment). Group member count API:
 *    GET /v2/bot/group/{groupId}/members/count.
 *    Docs do not clearly specify status codes for "not a friend" / "has
 *    blocked the bot" -- also an open question for this spike.
 *
 * 5. Push message billing/quota: counted per recipient, not per API call
 *    and not per message object. Pushing one Flex Message (or four message
 *    objects in one call) to a 5-person group counts as 5 messages sent.
 *    Messages to a blocked/nonexistent user are not counted as sent.
 */

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  PANEL_TOKEN: string;
}

// ---------------------------------------------------------------------------
// LINE webhook payload types
// ---------------------------------------------------------------------------

export interface WebhookBody {
  destination: string;
  events: unknown[];
}

export type SourceType = "user" | "group" | "room";

export interface UserSource {
  type: "user";
  userId: string;
}

export interface GroupSource {
  type: "group";
  groupId: string;
  /**
   * NOT guaranteed present by LINE's docs in every case for group sources.
   * See file-level note (3) above -- this is what the spike measures.
   */
  userId?: string;
}

export interface RoomSource {
  type: "room";
  roomId: string;
  userId?: string;
}

export type EventSource = UserSource | GroupSource | RoomSource;

export interface DeliveryContext {
  isRedelivery: boolean;
}

interface WebhookEventBase {
  webhookEventId: string;
  deliveryContext: DeliveryContext;
  timestamp: number;
  mode: "active" | "standby";
  source: EventSource;
}

export interface MessageEvent extends WebhookEventBase {
  type: "message";
  replyToken: string;
  message: { id: string; type: string; [key: string]: unknown };
}

/**
 * Added by LINE after this spike's original brief was written -- see
 * file-level note (2). Group chats only, text messages only.
 */
export interface MessageEditedEvent extends WebhookEventBase {
  type: "messageEdited";
  replyToken: string;
  message: { id: string; type: "text"; text: string; [key: string]: unknown };
}

export interface UnsendEvent extends WebhookEventBase {
  type: "unsend";
  unsend: { messageId: string };
}

export interface FollowEvent extends WebhookEventBase {
  type: "follow";
  replyToken: string;
}

export interface UnfollowEvent extends WebhookEventBase {
  type: "unfollow";
}

export interface JoinEvent extends WebhookEventBase {
  type: "join";
  replyToken: string;
}

export interface LeaveEvent extends WebhookEventBase {
  type: "leave";
}

export interface MemberJoinedEvent extends WebhookEventBase {
  type: "memberJoined";
  replyToken: string;
  joined: { members: UserSource[] };
}

export interface MemberLeftEvent extends WebhookEventBase {
  type: "memberLeft";
  left: { members: UserSource[] };
}

export interface PostbackEvent extends WebhookEventBase {
  type: "postback";
  replyToken: string;
  postback: { data: string; params?: Record<string, unknown> };
}

export interface VideoPlayCompleteEvent extends WebhookEventBase {
  type: "videoPlayComplete";
  replyToken: string;
  videoPlayComplete: { trackingId: string };
}

export interface BeaconEvent extends WebhookEventBase {
  type: "beacon";
  replyToken: string;
  beacon: { hwid: string; type: string };
}

export interface AccountLinkEvent extends WebhookEventBase {
  type: "accountLink";
  replyToken: string;
  link: { result: "ok" | "failed"; nonce: string };
}

export interface MembershipEvent extends WebhookEventBase {
  type: "membership";
  replyToken: string;
  membership: { type: string; membershipId: number };
}

export type WebhookEvent =
  | MessageEvent
  | MessageEditedEvent
  | UnsendEvent
  | FollowEvent
  | UnfollowEvent
  | JoinEvent
  | LeaveEvent
  | MemberJoinedEvent
  | MemberLeftEvent
  | PostbackEvent
  | VideoPlayCompleteEvent
  | BeaconEvent
  | AccountLinkEvent
  | MembershipEvent;

export const KNOWN_EVENT_TYPES = [
  "message",
  "messageEdited",
  "unsend",
  "follow",
  "unfollow",
  "join",
  "leave",
  "memberJoined",
  "memberLeft",
  "postback",
  "videoPlayComplete",
  "beacon",
  "accountLink",
  "membership",
] as const;

/** Narrow an unknown array element into a WebhookEvent-shaped record without
 * assuming any field beyond what we need to route/store it -- the whole
 * point of this spike is to store whatever LINE actually sends, even if it
 * doesn't match our assumptions. */
export function isPlausibleWebhookEvent(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

// ---------------------------------------------------------------------------
// D1 row types (mirror migrations/0001_init.sql exactly)
// ---------------------------------------------------------------------------

export interface RawEventRow {
  id: number;
  webhook_event_id: string | null;
  received_at: number;
  line_timestamp: number | null;
  source_type: string | null;
  group_id: string | null;
  user_id: string | null;
  event_type: string | null;
  is_redelivery: number;
  raw_json: string;
}

export interface MediaFetchRow {
  id: number;
  message_id: string | null;
  webhook_event_id: string | null;
  mime: string | null;
  size_bytes: number | null;
  success: number;
  duration_ms: number | null;
  error: string | null;
  fetched_at: number;
}

export interface ProfileProbeRow {
  id: number;
  group_id: string | null;
  user_id: string | null;
  display_name: string | null;
  status_code: number | null;
  success: number;
  raw_response: string | null;
  probed_at: number;
}

export interface PushLogRow {
  id: number;
  card_type: string | null;
  group_id: string | null;
  recipient_count: number | null;
  status_code: number | null;
  pushed_at: number;
}

export interface ErrorRow {
  id: number;
  context: string | null;
  message: string | null;
  stack: string | null;
  occurred_at: number;
}

export type PushCardType = "postback" | "message-action" | "text";
