import type { Env } from "./types";

const LINE_API_BASE = "https://api.line.me";
const LINE_DATA_API_BASE = "https://api-data.line.me";

// Media larger than this are not fully buffered/stored -- streamed and
// truncated at the cap so one huge file can't blow past Worker memory/R2
// write limits during this spike. 10MB matches the ceiling noted in the
// product plan this spike validates against.
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

function authHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
  };
}

export interface PushMessageResult {
  success: boolean;
  statusCode: number;
  body: string;
}

/**
 * POST /v2/bot/message/push. Billing/quota note (verified against LINE's
 * docs 2026-08-27): counted per recipient, not per API call and not per
 * message object -- pushing to a group of 5 people always counts as 5
 * messages sent regardless of how many `messages` entries are in this call.
 */
export async function pushMessage(
  env: Env,
  to: string,
  messages: unknown[],
): Promise<PushMessageResult> {
  try {
    const res = await fetch(`${LINE_API_BASE}/v2/bot/message/push`, {
      method: "POST",
      headers: {
        ...authHeaders(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, messages }),
    });
    const body = await res.text();
    return { success: res.ok, statusCode: res.status, body };
  } catch (err) {
    return {
      success: false,
      statusCode: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface GetContentResult {
  success: boolean;
  mime: string | null;
  sizeBytes: number | null;
  durationMs: number;
  error: string | null;
}

/**
 * GET /v2/bot/message/{messageId}/content (api-data.line.me host).
 * Streams the response body straight into R2 rather than buffering the
 * whole file in memory first; stops after MAX_MEDIA_BYTES.
 */
export async function getContent(
  env: Env,
  messageId: string,
): Promise<GetContentResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      `${LINE_DATA_API_BASE}/v2/bot/message/${encodeURIComponent(messageId)}/content`,
      { headers: authHeaders(env) },
    );

    if (!res.ok || !res.body) {
      return {
        success: false,
        mime: res.headers.get("content-type"),
        sizeBytes: null,
        durationMs: Date.now() - start,
        error: `HTTP ${res.status}`,
      };
    }

    const mime = res.headers.get("content-type");
    const key = `media/${messageId}`;

    // Cap the stream at MAX_MEDIA_BYTES by piping through a TransformStream
    // that counts bytes and terminates the stream once the cap is hit.
    let total = 0;
    let truncated = false;
    const limited = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (total >= MAX_MEDIA_BYTES) {
            truncated = true;
            return;
          }
          const remaining = MAX_MEDIA_BYTES - total;
          const piece = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
          total += piece.byteLength;
          if (piece.byteLength > 0) controller.enqueue(piece);
          if (chunk.byteLength > remaining) truncated = true;
        },
      }),
    );

    await env.MEDIA.put(key, limited, {
      httpMetadata: mime ? { contentType: mime } : undefined,
    });

    return {
      success: true,
      mime,
      sizeBytes: total,
      durationMs: Date.now() - start,
      error: truncated ? "truncated_at_10mb_cap" : null,
    };
  } catch (err) {
    return {
      success: false,
      mime: null,
      sizeBytes: null,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface GroupMemberProfileResult {
  success: boolean;
  statusCode: number;
  displayName: string | null;
  raw: string;
}

/**
 * GET /v2/bot/group/{groupId}/member/{userId} (verified path -- no
 * trailing /profile segment). Never throws: any network/DNS/fetch-level
 * error is caught and returned as a `success: false` result so the caller
 * always has something to log to profile_probes, instead of the failure
 * silently vanishing from a fire-and-forget waitUntil task.
 */
export async function getGroupMemberProfile(
  env: Env,
  groupId: string,
  userId: string,
): Promise<GroupMemberProfileResult> {
  try {
    const res = await fetch(
      `${LINE_API_BASE}/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
      { headers: authHeaders(env) },
    );
    const body = await res.text();
    let displayName: string | null = null;
    if (res.ok) {
      try {
        const parsed = JSON.parse(body) as { displayName?: string };
        displayName = parsed.displayName ?? null;
      } catch {
        // Non-JSON 200 body would be unexpected; keep raw body for the
        // report, just leave displayName null.
      }
    }
    return { success: res.ok, statusCode: res.status, displayName, raw: body };
  } catch (err) {
    return {
      success: false,
      statusCode: 0,
      displayName: null,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface GroupMemberCountResult {
  success: boolean;
  statusCode: number;
  count: number | null;
}

/** GET /v2/bot/group/{groupId}/members/count. Also never throws, matching
 * getGroupMemberProfile -- callers (panel.ts's push flow in particular)
 * need a usable fallback, not an unhandled rejection, when this fails. */
export async function getGroupMemberCount(
  env: Env,
  groupId: string,
): Promise<GroupMemberCountResult> {
  try {
    const res = await fetch(
      `${LINE_API_BASE}/v2/bot/group/${encodeURIComponent(groupId)}/members/count`,
      { headers: authHeaders(env) },
    );
    if (!res.ok) {
      return { success: false, statusCode: res.status, count: null };
    }
    const parsed = (await res.json()) as { count?: number };
    return { success: true, statusCode: res.status, count: parsed.count ?? null };
  } catch {
    return { success: false, statusCode: 0, count: null };
  }
}
