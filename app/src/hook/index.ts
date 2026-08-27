/**
 * Webhook worker.
 *
 * Deployed separately from the dashboard so a dashboard release can never
 * disturb LINE ingestion — the two have very different risk profiles: one is
 * edited constantly, the other must simply never stop accepting events.
 */

import { Hono } from "hono";
import type { Env } from "../core/types";
import { recordDeadLetter } from "../core/db";
import { newId } from "../core/ids";
import { handleWebhook } from "./webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

app.post("/webhook", handleWebhook);

/**
 * Last-resort handler.
 *
 * A 5xx from /webhook makes LINE retry, which is right when we failed to
 * record something and wrong when we already did. handleWebhook decides that
 * deliberately; anything reaching here is an unanticipated throw, and the safe
 * reading is that recording did not happen — so let LINE send it again.
 */
app.onError((err, c) => {
  c.executionCtx.waitUntil(
    recordDeadLetter(c.env, {
      id: newId("dl"),
      reason: "unhandled_error",
      detail: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
      statusCode: 500,
    }),
  );
  return c.text("internal error", 500);
});

export default app;
