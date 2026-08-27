/**
 * Dashboard worker.
 *
 * Separate from the webhook worker so a dashboard release cannot disturb LINE
 * ingestion. Put behind Cloudflare Access for M0.1: one firm, a handful of
 * staff, and no self-service sign-up to build yet.
 */

import { Hono } from "hono";
import type { Env } from "../core/types";
import { api } from "./api";
import { dispatchDue } from "../core/outbox";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));
app.route("/api", api);

// The dashboard keeps its view state in memory rather than in the URL, so a
// path other than "/" only ever comes from a mistyped or stale link. Send
// those to the app rather than a bare 404. API paths never reach here: they
// matched above, and an unknown /api route should stay a 404 so a broken
// client call fails loudly instead of receiving HTML.
app.notFound((c) =>
  c.req.path.startsWith("/api")
    ? c.json({ error: "not found" }, 404)
    : c.redirect("/", 302),
);

export default {
  fetch: app.fetch,

  /**
   * Sweeper. Picks up sends that failed or timed out earlier -- retrying with
   * the same key is safe, since LINE refuses a key it already accepted.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchDue(env, 50).then(() => undefined));
  },
};
