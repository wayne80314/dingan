import type { Context } from "hono";
import { constantTimeStringEqual } from "./signature";
import { queryAllEventsForReport, type ReportData } from "./db";
import type { Env, MediaFetchRow, ProfileProbeRow, RawEventRow } from "./types";

// ---------------------------------------------------------------------------
// Pure analysis. No I/O in here -- report.test.ts feeds it fixture rows
// directly, and the GET /report handler below feeds it real D1 rows via
// queryAllEventsForReport.
// ---------------------------------------------------------------------------

interface ParsedEvent {
  row: RawEventRow;
  json: Record<string, unknown> | null;
}

function parseRawEvents(rows: RawEventRow[]): ParsedEvent[] {
  return rows.map((row) => {
    try {
      const json = JSON.parse(row.raw_json) as Record<string, unknown>;
      return { row, json };
    } catch {
      return { row, json: null };
    }
  });
}

function sourceUserId(json: Record<string, unknown> | null): string | undefined {
  if (!json) return undefined;
  const source = json.source;
  if (typeof source !== "object" || source === null) return undefined;
  const uid = (source as Record<string, unknown>).userId;
  return typeof uid === "string" ? uid : undefined;
}

interface UserIdPresenceBucket {
  groupId: string;
  userId: string | "(missing)";
  count: number;
}

/** Buckets events with a group/room source by (groupId, userId-or-missing).
 * This is how the spike answers "依好友/非好友分組統計" without inventing a
 * friend-status signal LINE doesn't send us in the webhook payload itself:
 * spike-protocol.md has Wayne run the two test accounts through known,
 * labeled roles (friend vs non-friend) against known groupIds, so he can
 * map each userId bucket back to a role when reading this. */
function bucketByGroupAndUserId(events: ParsedEvent[]): UserIdPresenceBucket[] {
  const counts = new Map<string, UserIdPresenceBucket>();
  for (const { row, json } of events) {
    if (row.source_type !== "group" && row.source_type !== "room") continue;
    const groupId = row.group_id ?? "(unknown-group)";
    const userId = sourceUserId(json) ?? row.user_id ?? "(missing)";
    const key = `${groupId}::${userId}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { groupId, userId, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => a.groupId.localeCompare(b.groupId));
}

export interface UserIdCoverageAnalysis {
  totalEvents: number;
  withUserId: number;
  withoutUserId: number;
  byGroupAndUserId: UserIdPresenceBucket[];
}

function analyzeUserIdCoverage(events: ParsedEvent[]): UserIdCoverageAnalysis {
  const buckets = bucketByGroupAndUserId(events);
  const withUserId = buckets.filter((b) => b.userId !== "(missing)").reduce((s, b) => s + b.count, 0);
  const withoutUserId = buckets.filter((b) => b.userId === "(missing)").reduce((s, b) => s + b.count, 0);
  return {
    totalEvents: events.length,
    withUserId,
    withoutUserId,
    byGroupAndUserId: buckets,
  };
}

export interface EventTypeSample {
  eventType: string;
  count: number;
  samples: unknown[];
}

function summarizeEventType(
  events: ParsedEvent[],
  eventType: string,
  sampleLimit = 5,
): EventTypeSample {
  const matches = events.filter((e) => e.row.event_type === eventType);
  return {
    eventType,
    count: matches.length,
    samples: matches.slice(0, sampleLimit).map((e) => e.json ?? { raw_json_unparseable: e.row.raw_json }),
  };
}

export interface MediaAnalysis {
  total: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  byMime: Record<string, { count: number; successCount: number }>;
  avgDurationMs: number | null;
}

function analyzeMedia(rows: MediaFetchRow[]): MediaAnalysis {
  const total = rows.length;
  const successCount = rows.filter((r) => r.success === 1).length;
  const byMime: Record<string, { count: number; successCount: number }> = {};
  let durationSum = 0;
  let durationCount = 0;

  for (const r of rows) {
    const mime = r.mime ?? "(unknown)";
    if (!byMime[mime]) byMime[mime] = { count: 0, successCount: 0 };
    byMime[mime].count += 1;
    if (r.success === 1) byMime[mime].successCount += 1;
    if (typeof r.duration_ms === "number") {
      durationSum += r.duration_ms;
      durationCount += 1;
    }
  }

  return {
    total,
    successCount,
    failureCount: total - successCount,
    successRate: total > 0 ? successCount / total : null,
    byMime,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
  };
}

export interface RedeliveryAnalysis {
  redeliveryFlaggedCount: number;
  totalEvents: number;
  messageEditedOutOfOrder: Array<{
    messageId: string;
    eventCount: number;
    receivedOrderTimestamps: number[];
    isOutOfOrder: boolean;
  }>;
}

/** `deliveryContext.isRedelivery` is LINE's own signal for "we already sent
 * this webhookEventId before"; `messageEdited` additionally warns (per
 * LINE's docs) that repeated edits of the same message can arrive
 * out-of-order, which isRedelivery alone would not catch since each edit
 * has a distinct webhookEventId. So this checks both. */
function analyzeRedelivery(events: ParsedEvent[]): RedeliveryAnalysis {
  const redeliveryFlaggedCount = events.filter((e) => e.row.is_redelivery === 1).length;

  const byMessageId = new Map<string, ParsedEvent[]>();
  for (const e of events) {
    if (e.row.event_type !== "messageEdited") continue;
    const messageId =
      e.json && typeof e.json.message === "object" && e.json.message !== null
        ? (e.json.message as Record<string, unknown>).id
        : undefined;
    if (typeof messageId !== "string") continue;
    const list = byMessageId.get(messageId) ?? [];
    list.push(e);
    byMessageId.set(messageId, list);
  }

  const messageEditedOutOfOrder = [...byMessageId.entries()].map(([messageId, list]) => {
    // list is already in received/insertion order (rawEvents queried ORDER
    // BY id ASC upstream). "Out of order" means line_timestamp does not
    // monotonically increase in that received order.
    const timestamps = list.map((e) => e.row.line_timestamp ?? 0);
    let isOutOfOrder = false;
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        isOutOfOrder = true;
        break;
      }
    }
    return {
      messageId,
      eventCount: list.length,
      receivedOrderTimestamps: timestamps,
      isOutOfOrder,
    };
  });

  return {
    redeliveryFlaggedCount,
    totalEvents: events.length,
    messageEditedOutOfOrder,
  };
}

export interface ProfileApiAnalysis {
  total: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  byStatusCode: Record<string, number>;
  displayNameChanges: Array<{
    groupId: string;
    userId: string;
    observedDisplayNames: string[];
  }>;
}

function analyzeProfileApi(rows: ProfileProbeRow[]): ProfileApiAnalysis {
  const total = rows.length;
  const successCount = rows.filter((r) => r.success === 1).length;
  const byStatusCode: Record<string, number> = {};
  for (const r of rows) {
    const code = String(r.status_code ?? "(none)");
    byStatusCode[code] = (byStatusCode[code] ?? 0) + 1;
  }

  const byPair = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.group_id || !r.user_id || !r.display_name) continue;
    const key = `${r.group_id}::${r.user_id}`;
    const set = byPair.get(key) ?? new Set<string>();
    set.add(r.display_name);
    byPair.set(key, set);
  }
  const displayNameChanges = [...byPair.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([key, names]) => {
      const [groupId, userId] = key.split("::");
      return { groupId, userId, observedDisplayNames: [...names] };
    });

  return {
    total,
    successCount,
    failureCount: total - successCount,
    successRate: total > 0 ? successCount / total : null,
    byStatusCode,
    displayNameChanges,
  };
}

export interface AnalysisResult {
  generatedAt: number;
  totalRawEvents: number;
  eventTypeCounts: Record<string, number>;
  /** (1) group source postback: userId presence, bucketed by group+userId
   * for manual friend/non-friend cross-reference against spike-protocol.md. */
  postbackUserIdCoverage: UserIdCoverageAnalysis;
  /** (2) message-action-triggered text messages: userId presence, same
   * bucketing. LINE's own model implies this should always carry userId
   * (the "user" sent a real message, not just tapped a button) -- this
   * confirms or refutes that empirically. */
  messageUserIdCoverage: UserIdCoverageAnalysis;
  /** (3) actual payload shape for structural/membership events, including
   * messageEdited (see types.ts note: added after this spike's original
   * brief, group-chat/text-only, can arrive out of order) and unsend. */
  structuralEventSamples: EventTypeSample[];
  /** (4) media fetch success rate. */
  media: MediaAnalysis;
  /** (5) redelivery / out-of-order occurrences. */
  redelivery: RedeliveryAnalysis;
  /** (6) profile API availability + displayName-change tracking. */
  profileApi: ProfileApiAnalysis;
}

export function analyzeEvents(data: ReportData): AnalysisResult {
  const events = parseRawEvents(data.rawEvents);

  const eventTypeCounts: Record<string, number> = {};
  for (const e of events) {
    const t = e.row.event_type ?? "(unknown)";
    eventTypeCounts[t] = (eventTypeCounts[t] ?? 0) + 1;
  }

  const postbackEvents = events.filter((e) => e.row.event_type === "postback");
  const messageEvents = events.filter((e) => e.row.event_type === "message");

  const structuralEventTypes = [
    "join",
    "leave",
    "memberJoined",
    "memberLeft",
    "messageEdited",
    "unsend",
  ];

  return {
    generatedAt: Date.now(),
    totalRawEvents: data.rawEvents.length,
    eventTypeCounts,
    postbackUserIdCoverage: analyzeUserIdCoverage(postbackEvents),
    messageUserIdCoverage: analyzeUserIdCoverage(messageEvents),
    structuralEventSamples: structuralEventTypes.map((t) => summarizeEventType(events, t)),
    media: analyzeMedia(data.mediaFetches),
    redelivery: analyzeRedelivery(events),
    profileApi: analyzeProfileApi(data.profileProbes),
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function renderHtml(result: AnalysisResult): string {
  const row = (label: string, value: string | number) =>
    `<tr><td>${label}</td><td>${value}</td></tr>`;

  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);

  return `<!doctype html>
<meta charset="utf-8">
<title>定案 F0 Spike Report</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  td, th { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  pre { background: #f6f6f6; padding: 0.6rem; overflow-x: auto; font-size: 0.8rem; }
  h2 { margin-top: 2rem; }
</style>
<h1>定案 F0 Spike Report</h1>
<p>產生時間：${new Date(result.generatedAt).toISOString()}／已捕獲 raw_events：${result.totalRawEvents}</p>

<h2>事件型別分布</h2>
<table>${Object.entries(result.eventTypeCounts).map(([k, v]) => row(k, v)).join("")}</table>

<h2>(1) postback userId 覆蓋率</h2>
<table>
  ${row("含 userId", result.postbackUserIdCoverage.withUserId)}
  ${row("缺 userId", result.postbackUserIdCoverage.withoutUserId)}
</table>
<table>
  <tr><th>groupId</th><th>userId</th><th>次數</th></tr>
  ${result.postbackUserIdCoverage.byGroupAndUserId.map((b) => `<tr><td>${b.groupId}</td><td>${b.userId}</td><td>${b.count}</td></tr>`).join("")}
</table>

<h2>(2) message-action 文字訊息 userId 覆蓋率</h2>
<table>
  ${row("含 userId", result.messageUserIdCoverage.withUserId)}
  ${row("缺 userId", result.messageUserIdCoverage.withoutUserId)}
</table>
<table>
  <tr><th>groupId</th><th>userId</th><th>次數</th></tr>
  ${result.messageUserIdCoverage.byGroupAndUserId.map((b) => `<tr><td>${b.groupId}</td><td>${b.userId}</td><td>${b.count}</td></tr>`).join("")}
</table>

<h2>(3) 結構性事件（join/leave/memberJoined/memberLeft/messageEdited/unsend）</h2>
${result.structuralEventSamples
  .map(
    (s) => `<h3>${s.eventType}（${s.count} 次）</h3><pre>${escapeHtml(JSON.stringify(s.samples, null, 2))}</pre>`,
  )
  .join("")}

<h2>(4) 媒體抓取成功率</h2>
<table>
  ${row("成功率", pct(result.media.successRate))}
  ${row("成功 / 總數", `${result.media.successCount} / ${result.media.total}`)}
  ${row("平均耗時 (ms)", result.media.avgDurationMs ?? "n/a")}
</table>
<table><tr><th>MIME</th><th>次數</th><th>成功</th></tr>${Object.entries(result.media.byMime)
    .map(([mime, s]) => `<tr><td>${mime}</td><td>${s.count}</td><td>${s.successCount}</td></tr>`)
    .join("")}</table>

<h2>(5) redelivery／亂序</h2>
<table>
  ${row("LINE 標記為 redelivery 的事件數", result.redelivery.redeliveryFlaggedCount)}
  ${row("總事件數", result.redelivery.totalEvents)}
</table>
<table><tr><th>message id</th><th>編輯次數</th><th>亂序？</th><th>timestamps（依收到順序）</th></tr>${result.redelivery.messageEditedOutOfOrder
    .map(
      (m) =>
        `<tr><td>${m.messageId}</td><td>${m.eventCount}</td><td>${m.isOutOfOrder ? "是" : "否"}</td><td>${m.receivedOrderTimestamps.join(", ")}</td></tr>`,
    )
    .join("")}</table>

<h2>(6) Profile API 可用性 / 改名追蹤</h2>
<table>
  ${row("成功率", pct(result.profileApi.successRate))}
  ${row("成功 / 總數", `${result.profileApi.successCount} / ${result.profileApi.total}`)}
</table>
<table><tr><th>status code</th><th>次數</th></tr>${Object.entries(result.profileApi.byStatusCode)
    .map(([code, n]) => `<tr><td>${code}</td><td>${n}</td></tr>`)
    .join("")}</table>
<h3>觀察到改名（同一 groupId+userId 出現多個 displayName）</h3>
<table><tr><th>groupId</th><th>userId</th><th>觀察到的名稱</th></tr>${result.profileApi.displayNameChanges
    .map((c) => `<tr><td>${c.groupId}</td><td>${c.userId}</td><td>${c.observedDisplayNames.join(" → ")}</td></tr>`)
    .join("")}</table>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function handleReport(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("token");
  if (!token || !constantTimeStringEqual(token, c.env.PANEL_TOKEN)) {
    return c.text("unauthorized", 401);
  }

  const format = c.req.query("format") === "json" ? "json" : "html";
  const data = await queryAllEventsForReport(c.env);
  const result = analyzeEvents(data);

  if (format === "json") {
    return c.json(result);
  }
  return c.html(renderHtml(result));
}
