import { Hono } from "hono";
import type { Env } from "./types";
import { handleWebhook } from "./webhook";
import { handlePanelGet, handlePanelPush } from "./panel";
import { handleReport } from "./report";
import { handleM0Verify } from "./m0verify";
import { handleLiffPage, handleLiffVerify, handleLiffResults } from "./liff";
import { safeInsertError } from "./db";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

app.post("/webhook", handleWebhook);
app.get("/panel", handlePanelGet);
app.post("/panel/push", handlePanelPush);
app.get("/report", handleReport);

// M0.0 verification sprint -- temporary, remove once the answers are
// recorded in docs/m0-plan.md.
app.get("/m0verify", handleM0Verify);
// LIFF identity probe. The page and its POST target are deliberately open:
// LINE opens them in the user's own in-app browser, where no shared secret
// can be hidden. Reading the collected results is token-protected.
app.get("/liff", handleLiffPage);
app.post("/liff/verify", handleLiffVerify);
app.get("/liff/results", handleLiffResults);

// Defense-in-depth backstop: even if a bug somewhere upstream of
// handleWebhook's own try/catch layers throws, /webhook must still answer
// 200 so LINE doesn't treat this endpoint as down and retry-storm the whole
// batch. Every other route gets Hono's normal error surface.
app.onError((err, c) => {
  if (c.req.path === "/webhook") {
    c.executionCtx.waitUntil(safeInsertError(c.env, "webhook_onerror", err));
    return c.text("ok", 200);
  }
  console.error(err);
  return c.text("internal error", 500);
});

export default app;
