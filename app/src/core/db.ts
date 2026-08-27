/**
 * Database access, scoped to one organization.
 *
 * Tenant isolation is enforced here rather than at each call site. Every query
 * that touches tenant data goes through `withOrg(env, orgId)`, whose helpers
 * inject `organization_id = ?` into the WHERE clause. A route that forgets to
 * filter cannot leak another firm's decisions, because it has no unscoped
 * handle to forget with.
 *
 * The escape hatch (`unscoped`) exists for genuinely cross-tenant work --
 * webhook ingestion before a group is claimed, outbox dispatch, sweepers --
 * and is deliberately noisy to type so its uses stay countable and auditable.
 */

import type { Env } from "./types";

export interface ScopedDb {
  readonly organizationId: string;

  /** SELECT returning many rows, automatically scoped. `sql` must contain the
   * literal token `{{ORG}}` where the organization predicate belongs. */
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;

  /** SELECT returning one row or null, automatically scoped. */
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null>;

  /** INSERT/UPDATE/DELETE, automatically scoped. */
  run(sql: string, ...binds: unknown[]): Promise<D1Result>;

  /** Builds a statement for use inside `batch`, automatically scoped. */
  stmt(sql: string, ...binds: unknown[]): D1PreparedStatement;

  /**
   * Runs statements as a unit. Verified against real D1 in M0.0: if any
   * statement fails the whole batch rolls back, so publish can write
   * snapshot + nonce + outbox without a compensating path.
   */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

const ORG_TOKEN = "{{ORG}}";

/**
 * Replaces the `{{ORG}}` marker with a bound predicate and prepends the
 * organization id to the bind list.
 *
 * Requiring the marker rather than appending a WHERE clause keeps the author
 * in control of placement -- it may need to sit inside a join condition or an
 * EXISTS -- while still making its absence a loud failure instead of a silent
 * cross-tenant read.
 */
function scope(sql: string, orgId: string, binds: unknown[]): { sql: string; binds: unknown[] } {
  if (!sql.includes(ORG_TOKEN)) {
    throw new Error(
      `scoped query is missing the ${ORG_TOKEN} marker; use unscoped() if the query is genuinely cross-tenant:\n${sql}`,
    );
  }
  const occurrences = sql.split(ORG_TOKEN).length - 1;
  const scopedSql = sql.split(ORG_TOKEN).join("organization_id = ?");
  // One bound org id per marker, in source order, ahead of the caller's binds.
  return { sql: scopedSql, binds: [...Array(occurrences).fill(orgId), ...binds] };
}

export function withOrg(env: Env, organizationId: string): ScopedDb {
  if (!organizationId) throw new Error("withOrg requires an organization id");

  const prepare = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const scoped = scope(sql, organizationId, binds);
    return env.DB.prepare(scoped.sql).bind(...scoped.binds);
  };

  return {
    organizationId,

    async all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
      const result = await prepare(sql, binds).all<T>();
      return result.results ?? [];
    },

    async first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
      return (await prepare(sql, binds).first<T>()) ?? null;
    },

    async run(sql: string, ...binds: unknown[]): Promise<D1Result> {
      return prepare(sql, binds).run();
    },

    stmt(sql: string, ...binds: unknown[]): D1PreparedStatement {
      return prepare(sql, binds);
    },

    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      return env.DB.batch(statements);
    },
  };
}

/**
 * Unscoped access, for work that legitimately spans tenants.
 *
 * Legitimate uses are: webhook ingestion before a group has been claimed into
 * a project, outbox dispatch, retry sweepers, and diagnostics. Anything
 * serving a dashboard request belongs in `withOrg` instead -- if a route needs
 * this, the reason should be obvious from the surrounding code.
 */
export function unscoped(env: Env): D1Database {
  return env.DB;
}

/** Records a failure without ever throwing. For catch blocks whose job is to
 * keep the request alive: if the log write itself fails there is nowhere left
 * to report it, so it is swallowed rather than escalated into a 500. */
export async function recordDeadLetter(
  env: Env,
  entry: {
    id: string;
    reason: string;
    detail?: string | null;
    rawSha256?: string | null;
    r2Key?: string | null;
    statusCode?: number | null;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO dead_letter (id, reason, detail, raw_sha256, r2_key, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        entry.id,
        entry.reason,
        entry.detail ?? null,
        entry.rawSha256 ?? null,
        entry.r2Key ?? null,
        entry.statusCode ?? null,
        Date.now(),
      )
      .run();
  } catch {
    // Deliberately swallowed; see doc comment.
  }
}
