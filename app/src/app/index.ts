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
