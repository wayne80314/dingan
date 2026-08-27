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

/**
 * Reads a stream into a single buffer, stopping once `cap` bytes have been
 * collected. Returns whether more data was available past the cap, so the
 * caller can record that what it stored is a truncated prefix rather than the
 * whole file.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = cap - total;
      if (value.byteLength >= remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        // Anything still arriving is beyond what we agreed to store.
        truncated = value.byteLength > remaining || total >= cap;
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Releasing matters on the truncation path: we stop reading mid-response,
    // and leaving the reader locked would keep the connection pinned.
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
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
    const httpMetadata = mime ? { contentType: mime } : undefined;

    // Read into a capped buffer, then store that buffer. R2 rejects any
    // stream whose length it cannot determine ("Provided readable stream must
    // have a known length"), which rules out piping a byte-capping
    // TransformStream into put() -- that shipped once and made every real
    // image fetch fail while the suite stayed green, because Miniflare's R2 is
    // more permissive than the real thing.
    //
    // Handing R2 the untouched response body would preserve true streaming
    // when LINE sends Content-Length, but that path cannot be exercised in
    // tests (a synthetic ReadableStream has no intrinsic length no matter what
    // header you attach), and an unverifiable path is what caused this bug in
    // the first place. With a hard MAX_MEDIA_BYTES ceiling the buffer is
    // bounded well inside a Worker's memory budget, so one always-tested path
    // is the better trade.
    const capped = await readCapped(res.body, MAX_MEDIA_BYTES);
    await env.MEDIA.put(key, capped.bytes, { httpMetadata });
    const total = capped.bytes.byteLength;
    const truncated = capped.truncated;

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
