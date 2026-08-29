/**
 * Shared types and environment bindings.
 *
 * LINE platform facts encoded here were verified against the live API during
 * F0 and M0.0; see docs/spike-results.md and docs/m0-plan.md. The one that
 * shapes the most code: group-source `userId` is present in practice for
 * postbacks but LINE documents it as message-events-only, so it is optional
 * everywhere and must stay that way.
 */

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;          // message media
  RAW: R2Bucket;            // verbatim webhook bodies
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_PROVIDER_ID: string;
  LINE_CHANNEL_ID: string;
  LIFF_ID?: string;
  /** Only the digest path needs this; absent elsewhere. */
  ANTHROPIC_API_KEY?: string;
}

// ---------------------------------------------------------------------------
// LINE webhook shapes
// ---------------------------------------------------------------------------

export type LineSourceType = "user" | "group" | "room";

export interface LineSource {
  type: LineSourceType;
  groupId?: string;
  roomId?: string;
  /** Optional by LINE's specification. Its absence is a supported state, not
   * an error: see confirmation.identity_source = 'postback_no_uid'. */
  userId?: string;
}

export interface LineDeliveryContext {
  isRedelivery: boolean;
}

export interface LineWebhookEventBase {
  type: string;
  webhookEventId: string;
  deliveryContext: LineDeliveryContext;
  timestamp: number;
  mode: string;
  source: LineSource;
  replyToken?: string;
}

export interface LineMessageEvent extends LineWebhookEventBase {
  type: "message";
  message: {
    id: string;
    type: string;
    text?: string;
    [k: string]: unknown;
  };
}

export interface LinePostbackEvent extends LineWebhookEventBase {
  type: "postback";
  postback: { data: string; params?: Record<string, unknown> };
}

export interface LineWebhookBody {
  destination: string;
  events: unknown[];
}

/** Message types whose content is fetched and stored. */
export const MEDIA_MESSAGE_TYPES = new Set(["image", "video", "audio", "file"]);

/** Every webhook event type LINE currently defines, as of 2026-08-27.
 * Anything outside this set is still stored verbatim -- the point of keeping
 * raw bodies is that unknown events are recoverable later. */
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

// ---------------------------------------------------------------------------
// Domain enums, mirroring the CHECK constraints in migrations/0001_init.sql
// ---------------------------------------------------------------------------

export type DecisionStatus =
  | "draft"
  | "pending"
  | "confirmed"
  | "rejected"
  | "request_changes"
  | "expired"
  | "withdrawn";

export type ConfirmAction = "confirm" | "reject" | "request_changes";

export type ConfirmChannel = "postback" | "message" | "liff" | "dashboard";

export type IdentitySource =
  | "postback"
  | "postback_no_uid"
  | "message"
  | "member_profile"
  | "liff_id_token"
  | "dashboard";

/** How much the recorded identity is worth.
 *
 * 'whitelisted' is reserved for identity a person asserted themselves.
 * A designer naming someone on their behalf is 'asserted' -- weaker, and
 * rendered differently in exports, because presenting the two as equivalent
 * would overstate what the record actually proves. */
export type IdentityConfidence = "whitelisted" | "asserted" | "seen_before" | "unknown";

export type ResolutionStatus =
  | "resolved"
  | "unidentified"
  | "late"
  | "revoked"
  | "superseded";

export type GroupStatus = "unclaimed" | "active" | "left" | "revoked";

export type OutboxState = "pending" | "sent" | "failed" | "uncertain";
