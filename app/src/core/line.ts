/**
 * LINE Messaging API client.
 *
 * Every call returns a result object instead of throwing. These run inside
 * `waitUntil` tasks and outbox dispatch, where an unhandled rejection would
 * disappear without a trace; a returned failure can at least be recorded.
 *
 * Verified against the live API in M0.0 (see docs/m0-plan.md):
 *   * Push quota is charged per recipient, and `members/count` excludes the
 *     bot -- so its value is exactly the billable recipient count, with no
 *     adjustment.
 *   * `members/count` works on an unverified account; `members/ids` does not,
 *     so nothing may depend on enumerating members.
 *   * Replaying `X-Line-Retry-Key` after a success returns 409 along with the
 *     original `sentMessages`, which lets an uncertain send be resolved
 *     rather than duplicated.
 */

import type { Env } from "./types";

const API = "https://api.line.me";
const DATA_API = "https://api-data.line.me";

/** Media is capped so a single large file cannot exhaust a Worker's memory.
 * Anything larger is stored truncated and flagged, never silently accepted. */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

function authHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendResult {
  /** True when the message is known to have reached LINE -- including the 409
   * case, where LINE is telling us it already accepted this retry key. */
  delivered: boolean;
  /** True when we cannot tell whether LINE received it (network failure,
   * timeout). The outbox retries these with the same retry key. */
  uncertain: boolean;
  statusCode: number;
  /** Present when LINE reported the message id, including via a 409. */
  sentMessageId: string | null;
  body: string;
}

interface SentMessagesBody {
  sentMessages?: Array<{ id?: string }>;
}

function extractSentMessageId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as SentMessagesBody;
    return parsed.sentMessages?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Pushes messages to a group.
 *
 * `retryKey` must be stable across retries of the same logical send. LINE
 * treats a repeated key as already-handled and answers 409 rather than
 * delivering a second copy -- which is what stops a retry from putting two
 * identical decision cards in front of a client.
 */
export async function pushMessage(
  env: Env,
  to: string,
  messages: unknown[],
  retryKey: string,
): Promise<SendResult> {
  try {
    const res = await fetch(`${API}/v2/bot/message/push`, {
      method: "POST",
      headers: {
        ...authHeaders(env),
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ to, messages }),
    });
    const body = await res.text();

    if (res.status === 409) {
      // Already accepted under this key. The body carries the original
      // sentMessages, so the send is resolved rather than merely assumed.
      return {
        delivered: true,
        uncertain: false,
        statusCode: 409,
        sentMessageId: extractSentMessageId(body),
        body,
      };
    }

    if (res.ok) {
      return {
        delivered: true,
        uncertain: false,
        statusCode: res.status,
        sentMessageId: extractSentMessageId(body),
        body,
      };
    }

    // 5xx may mean LINE accepted it and failed to answer; 4xx means it was
    // rejected outright and retrying unchanged will not help.
    return {
      delivered: false,
      uncertain: res.status >= 500,
      statusCode: res.status,
      sentMessageId: null,
      body,
    };
  } catch (err) {
    return {
      delivered: false,
      uncertain: true,
      statusCode: 0,
      sentMessageId: null,
      body: errText(err),
    };
  }
}

/**
 * Replies to an event. Replies are free of quota, so the visible receipt after
 * a confirmation costs nothing -- but the token is short-lived and single-use,
 * which is why receipts are sent from the request path rather than deferred to
 * a queue. When it fails, the caller falls back to a push.
 */
export async function replyMessage(
  env: Env,
  replyToken: string,
  messages: unknown[],
): Promise<SendResult> {
  try {
    const res = await fetch(`${API}/v2/bot/message/reply`, {
      method: "POST",
      headers: { ...authHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ replyToken, messages }),
    });
    const body = await res.text();
    return {
      delivered: res.ok,
      uncertain: !res.ok && res.status >= 500,
      statusCode: res.status,
      sentMessageId: res.ok ? extractSentMessageId(body) : null,
      body,
    };
  } catch (err) {
    return {
      delivered: false,
      uncertain: true,
      statusCode: 0,
      sentMessageId: null,
      body: errText(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Group and member lookups
// ---------------------------------------------------------------------------

export interface MemberCountResult {
  ok: boolean;
  statusCode: number;
  /** Excludes the bot, so this is the billable recipient count as-is. */
  count: number | null;
}

export async function getGroupMemberCount(
  env: Env,
  lineGroupId: string,
): Promise<MemberCountResult> {
  try {
    const res = await fetch(
      `${API}/v2/bot/group/${encodeURIComponent(lineGroupId)}/members/count`,
      { headers: authHeaders(env) },
    );
    if (!res.ok) return { ok: false, statusCode: res.status, count: null };
    const parsed = (await res.json()) as { count?: number };
    return { ok: true, statusCode: res.status, count: parsed.count ?? null };
  } catch {
    return { ok: false, statusCode: 0, count: null };
  }
}

export interface MemberProfileResult {
  ok: boolean;
  statusCode: number;
  displayName: string | null;
  raw: string;
}

/**
 * Fetches a group member's profile.
 *
 * LINE guarantees this works for members who have not added the account as a
 * friend and even for those who have blocked it -- which is what makes naming
 * a confirming client possible at all, since few clients add a design firm's
 * official account. It stops working once the member or the bot leaves the
 * group, hence the display-name snapshot taken at confirmation time.
 */
export async function getGroupMemberProfile(
  env: Env,
  lineGroupId: string,
  lineUserId: string,
): Promise<MemberProfileResult> {
  try {
    const res = await fetch(
      `${API}/v2/bot/group/${encodeURIComponent(lineGroupId)}/member/${encodeURIComponent(lineUserId)}`,
      { headers: authHeaders(env) },
    );
    const raw = await res.text();
    let displayName: string | null = null;
    if (res.ok) {
      try {
        displayName = (JSON.parse(raw) as { displayName?: string }).displayName ?? null;
      } catch {
        // Unexpected non-JSON success body; keep the raw text for diagnosis.
      }
    }
    return { ok: res.ok, statusCode: res.status, displayName, raw };
  } catch (err) {
    return { ok: false, statusCode: 0, displayName: null, raw: errText(err) };
  }
}

export interface GroupSummaryResult {
  ok: boolean;
  statusCode: number;
  groupName: string | null;
}

export async function getGroupSummary(
  env: Env,
  lineGroupId: string,
): Promise<GroupSummaryResult> {
  try {
    const res = await fetch(
      `${API}/v2/bot/group/${encodeURIComponent(lineGroupId)}/summary`,
      { headers: authHeaders(env) },
    );
    if (!res.ok) return { ok: false, statusCode: res.status, groupName: null };
    const parsed = (await res.json()) as { groupName?: string };
    return { ok: true, statusCode: res.status, groupName: parsed.groupName ?? null };
  } catch {
    return { ok: false, statusCode: 0, groupName: null };
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface GetContentResult {
  ok: boolean;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  durationMs: number;
  truncated: boolean;
  error: string | null;
}

/**
 * Reads a stream into one buffer, stopping at `cap` bytes and reporting
 * whether more was available.
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
        truncated = value.byteLength > remaining || total >= cap;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
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

/**
 * Downloads message content into R2.
 *
 * Buffered rather than streamed straight through: R2 rejects a stream whose
 * length it cannot determine, and a byte-capping transform erases that length.
 * That combination shipped once during F0 and made every image fetch fail in
 * production while the test suite stayed green, because Miniflare's R2 is more
 * permissive than the real service. Handing R2 the untouched response body
 * would restore streaming when LINE sends Content-Length, but no test can
 * construct a stream with intrinsic length, and an unverifiable path is what
 * caused the bug. With a hard cap the buffer is bounded well inside a Worker's
 * budget, so one always-tested path is the better trade.
 *
 * LINE expires message content after a retention window, so a failure here is
 * not recoverable later -- it is recorded, not retried indefinitely.
 */
export async function getContentToR2(
  env: Env,
  lineMessageId: string,
  r2Key: string,
): Promise<GetContentResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      `${DATA_API}/v2/bot/message/${encodeURIComponent(lineMessageId)}/content`,
      { headers: authHeaders(env) },
    );

    if (!res.ok || !res.body) {
      return {
        ok: false,
        mime: res.headers.get("content-type"),
        sizeBytes: null,
        sha256: null,
        durationMs: Date.now() - start,
        truncated: false,
        error: `HTTP ${res.status}`,
      };
    }

    const mime = res.headers.get("content-type");
    const { bytes, truncated } = await readCapped(res.body, MAX_MEDIA_BYTES);

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await env.MEDIA.put(r2Key, bytes, {
      httpMetadata: mime ? { contentType: mime } : undefined,
    });

    return {
      ok: true,
      mime,
      sizeBytes: bytes.byteLength,
      sha256,
      durationMs: Date.now() - start,
      truncated,
      error: truncated ? "truncated_at_cap" : null,
    };
  } catch (err) {
    return {
      ok: false,
      mime: null,
      sizeBytes: null,
      sha256: null,
      durationMs: Date.now() - start,
      truncated: false,
      error: errText(err),
    };
  }
}
