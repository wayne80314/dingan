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
import { runDailyDigests, runFrequentTasks, taipeiHour } from "../core/schedule";

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
   * Runs every five minutes: retries pending sends, and marks consent notices
   * delivered so a group becomes eligible for summarising only after it has
   * actually been told.
   *
   * Once a day, in the evening, it also produces the daily minutes. The hour
   * is checked here rather than configured as a second cron so there is one
   * schedule to reason about, and because the window is a cursor -- a tick
   * that misses its hour is picked up by the next day's run rather than
   * losing the conversation.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await runFrequentTasks(env);

        const hour = taipeiHour(Date.now());
        if (hour === 21) {
          await runDailyDigests(env);
        }
      })(),
    );
  },
};
