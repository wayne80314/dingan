/**
 * Scheduled work.
 *
 * The digest window is a cursor, not a calendar boundary. A run that starts
 * late, or the first run after an outage, picks up where the last one finished
 * — otherwise a quiet failure at 21:00 would erase a day of conversation from
 * the record and nobody would notice, because the only evidence is a summary
 * that never appeared.
 */

import { unscoped } from "./db";
import { dispatchDue } from "./outbox";
import { runDigestForGroup } from "./digest";
import { markNoticeDelivered } from "./consent";
import type { Env } from "./types";

interface GroupRow {
  id: string;
  organization_id: string;
  project_id: string;
  line_group_id: string;
  last_digest_to: number | null;
}

/** How far back a first run reaches. Enough to cover a normal day without
 * summarising a group's entire history the first time it is switched on. */
const FIRST_RUN_LOOKBACK_MS = 36 * 60 * 60 * 1000;

/**
 * Minimum gap between digests for one group.
 *
 * The scheduler ticks every five minutes, so the evening hour comes round
 * twelve times. The cursor would make the later runs summarise almost nothing
 * and skip as quiet, but relying on that is relying on an accident: this makes
 * one-run-a-day the actual rule, while still letting a missed evening be
 * picked up the next time the tick lands.
 */
const MIN_DIGEST_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface DigestRunSummary {
  groups: number;
  created: number;
  quiet: number;
  blocked: number;
  failed: number;
}

export async function runDailyDigests(
  env: Env & { ANTHROPIC_API_KEY?: string },
  now = Date.now(),
): Promise<DigestRunSummary> {
  const groups = await unscoped(env)
    .prepare(
      `SELECT g.id, g.organization_id, g.project_id, g.line_group_id,
              (SELECT MAX(covered_to) FROM digest d WHERE d.line_group_id = g.id) AS last_digest_to
         FROM line_group g
        WHERE g.status = 'active'
          AND g.project_id IS NOT NULL
          AND g.purpose = 'owner'`,
    )
    .all<GroupRow>();

  const summary: DigestRunSummary = { groups: 0, created: 0, quiet: 0, blocked: 0, failed: 0 };

  for (const g of groups.results ?? []) {
    summary.groups += 1;
    const from = g.last_digest_to ?? now - FIRST_RUN_LOOKBACK_MS;
    if (from >= now) continue;
    if (g.last_digest_to !== null && now - g.last_digest_to < MIN_DIGEST_INTERVAL_MS) continue;

    try {
      const result = await runDigestForGroup(env, g, from, now);
      if (result.status === "created") summary.created += 1;
      else if (result.status === "skipped_quiet") summary.quiet += 1;
      else if (result.status === "skipped_no_consent") summary.blocked += 1;
      else summary.failed += 1;
    } catch {
      // One group's failure must not stop the rest; the digest row itself
      // records what went wrong for that group.
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * Marks consent notices as delivered once their send has actually succeeded.
 *
 * Until this runs, a queued notice does not unlock summarising — which is the
 * intended order: told first, then read.
 */
export async function reconcileConsentNotices(env: Env): Promise<number> {
  const sent = await unscoped(env)
    .prepare(
      `SELECT o.id FROM outbox o
         JOIN consent_notice c ON c.outbox_id = o.id
        WHERE o.state = 'sent' AND c.sent_at IS NULL`,
    )
    .all<{ id: string }>();

  for (const row of sent.results ?? []) {
    await markNoticeDelivered(env, row.id);
  }
  return (sent.results ?? []).length;
}

/**
 * The five-minute tick.
 *
 * Outbox first: a decision card waiting to go out matters more than a summary,
 * and a consent notice has to land before anything can be summarised at all.
 */
export async function runFrequentTasks(env: Env): Promise<void> {
  await dispatchDue(env, 50);
  await reconcileConsentNotices(env);
}

/** Local hour in the organization's timezone, for deciding when "evening" is
 * to the people reading it. */
export function taipeiHour(nowMs: number): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(nowMs)),
  );
}
