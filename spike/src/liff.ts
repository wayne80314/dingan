/**
 * M0.0 (a) — LIFF identity probe.
 *
 * Question: for one person, does the `sub` claim of a LINE Login ID token
 * equal the `userId` the Messaging API reports in webhooks, given both
 * channels live under the same provider?
 *
 * Why it gates M0: spike-results.md established that group postback events
 * carry `userId` in practice but that LINE does not document this — the spec
 * says group-source userId appears only in message events. LIFF + LINE Login
 * is the designated fallback for recovering identity when a postback shows up
 * without one. If `sub` and `userId` are different namespaces, that fallback
 * silently identifies the wrong person, or nobody, and M0 needs a different
 * recovery path.
 *
 * Access model: the page itself is open, because LINE opens it inside the
 * user's own in-app browser where no shared secret can be hidden. Writes are
 * therefore unauthenticated, which is acceptable — an attacker can only
 * record their own claims. Reading results requires PANEL_TOKEN.
 *
 * Temporary: remove once the answer is recorded in docs/m0-plan.md.
 */

import type { Context } from "hono";
import { constantTimeStringEqual } from "./signature";
import { safeInsertError } from "./db";
import type { Env } from "./types";

/** Messaging-API userIds already captured from the real test group, so the
 * comparison can be made server-side instead of by eye. */
const KNOWN_USER_IDS: Record<string, string> = {
  U097bdaa0f1e6b00ea4e9a10ae2146aed: "Wayne（已加好友）",
  Udfbad354770791067b243a5d7552bf7b: "洪米奇（非好友）",
};

interface IdTokenClaims {
  sub?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  name?: string;
}

/** Decodes a JWT payload without verifying it. Verification happens
 * separately against LINE; this exists so a probe still yields the claim we
 * care about even when verification is unavailable. */
function decodeJwtPayload(token: string): IdTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)),
    );
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return null;
  }
}

export function renderLiffPage(liffId: string | undefined): string {
  if (!liffId) {
    return `<!doctype html><meta charset="utf-8">
<title>LIFF 驗證 — 缺少 liffId</title>
<body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem">
<h1>缺少 liffId</h1>
<p>請把 LIFF app 的 Endpoint URL 設成：</p>
<pre style="background:#f4f4f4;padding:1rem;overflow-x:auto">https://dingan-spike.wayne-7ef.workers.dev/liff?liffId=&lt;你的 LIFF ID&gt;</pre>
<p>LIFF ID 可在 LINE Developers Console 的 Login channel → LIFF 分頁取得，格式類似 <code>2001234567-AbCdEfGh</code>。</p>
</body>`;
  }

  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>定案 M0.0 — LIFF 身分驗證</title>
<style>
  body { font-family: -apple-system, system-ui, "PingFang TC", sans-serif;
         max-width: 640px; margin: 0 auto; padding: 1.5rem 1.1rem; line-height: 1.7;
         background: #faf8f5; color: #24211d; }
  h1 { font-size: 1.3rem; }
  .box { background: #fff; border: 1px solid #e7e1d6; border-radius: 12px;
         padding: 1rem 1.1rem; margin: 1rem 0; }
  .ok { border-color: #bfe0c8; background: #f0f8f2; }
  .bad { border-color: #e8c0bc; background: #fdf1f0; }
  code, pre { font-size: 0.82rem; word-break: break-all; }
  pre { background: #f4f2ee; padding: .7rem; border-radius: 8px; overflow-x: auto; }
  .muted { color: #6b6459; font-size: .85rem; }
</style>
<h1>定案 — LIFF 身分驗證</h1>
<p class="muted">這是 M0.0 驗證用的一次性頁面，用來確認 LINE Login 的使用者識別碼是否等於
Messaging API 的 userId。不會儲存你的登入憑證。</p>
<div id="status" class="box">初始化中…</div>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
const el = document.getElementById('status');
function show(html, cls) { el.className = 'box' + (cls ? ' ' + cls : ''); el.innerHTML = html; }

(async () => {
  try {
    await liff.init({ liffId: ${JSON.stringify(liffId)} });
  } catch (e) {
    show('<strong>liff.init 失敗</strong><pre>' + String(e && e.message || e) + '</pre>' +
         '<p class="muted">最常見原因：Endpoint URL 與實際開啟的網址不符，或 LIFF ID 填錯。</p>', 'bad');
    return;
  }

  if (!liff.isLoggedIn()) {
    show('尚未登入，導向 LINE Login…');
    liff.login();
    return;
  }

  const idToken = liff.getIDToken();
  if (!idToken) {
    show('<strong>取不到 ID token</strong><p class="muted">請確認 LIFF app 的 scope 有勾選 openid。</p>', 'bad');
    return;
  }

  show('已取得 ID token，比對中…');
  try {
    const res = await fetch('/liff/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: idToken, inClient: liff.isInClient(), os: liff.getOS() })
    });
    const r = await res.json();
    if (r.matched) {
      show('<strong>✅ 相符</strong><p>Login 的 <code>sub</code> 等於 Messaging API 的 userId。</p>' +
           '<p>識別為：<strong>' + r.matched + '</strong></p>' +
           '<pre>sub = ' + r.sub + '</pre>' +
           '<p class="muted">LIFF 降級路徑可行。可以關閉此頁了。</p>', 'ok');
    } else {
      show('<strong>⚠️ 不相符或無法比對</strong>' +
           '<pre>sub = ' + (r.sub || '(無)') + '</pre>' +
           '<p class="muted">' + (r.note || '') + '</p>', 'bad');
    }
  } catch (e) {
    show('<strong>送出失敗</strong><pre>' + String(e && e.message || e) + '</pre>', 'bad');
  }
})();
</script>`;
}

export async function handleLiffPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.html(renderLiffPage(c.req.query("liffId")));
}

export async function handleLiffVerify(c: Context<{ Bindings: Env }>): Promise<Response> {
  let idToken: string | undefined;
  try {
    const body = (await c.req.json()) as { idToken?: unknown };
    if (typeof body.idToken === "string") idToken = body.idToken;
  } catch {
    // fall through to the missing-token response
  }
  if (!idToken) return c.json({ matched: null, note: "缺少 idToken" }, 400);

  const claims = decodeJwtPayload(idToken);
  const sub = claims?.sub ?? null;

  // Ask LINE to validate the token as well. `aud` is the Login channel id, so
  // it can be used as client_id without configuring anything ahead of time.
  let verifiedByLine = 0;
  let verifyStatus = 0;
  let verifyError: string | null = null;
  if (claims?.aud) {
    try {
      const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id_token: idToken, client_id: claims.aud }).toString(),
      });
      verifyStatus = res.status;
      verifiedByLine = res.ok ? 1 : 0;
      if (!res.ok) verifyError = (await res.text()).slice(0, 300);
    } catch (err) {
      verifyError = err instanceof Error ? err.message : String(err);
    }
  }

  const matched = sub && KNOWN_USER_IDS[sub] ? KNOWN_USER_IDS[sub] : null;

  try {
    await c.env.DB.prepare(
      `INSERT INTO liff_probes
        (sub, aud, iss, token_exp, name_claim, verified_by_line, verify_status,
         verify_error, matched_known_user_id, user_agent, probed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        sub,
        claims?.aud ?? null,
        claims?.iss ?? null,
        claims?.exp ?? null,
        claims?.name ?? null,
        verifiedByLine,
        verifyStatus,
        verifyError,
        matched,
        (c.req.header("user-agent") ?? "").slice(0, 200),
        Date.now(),
      )
      .run();
  } catch (err) {
    await safeInsertError(c.env, "liff_verify", err);
  }

  return c.json({
    sub,
    matched,
    verifiedByLine: verifiedByLine === 1,
    note: matched
      ? null
      : sub
        ? "此 sub 不在已知的 Messaging userId 清單中。若你用的是第三支帳號，屬預期；若用的是 Wayne 或洪米奇的帳號，代表 sub 與 userId 不同命名空間，LIFF 降級路徑不可行。"
        : "無法解出 sub，ID token 格式異常。",
  });
}

export async function handleLiffResults(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("token");
  if (!token || !constantTimeStringEqual(token, c.env.PANEL_TOKEN)) {
    return c.text("unauthorized", 401);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, sub, aud, iss, verified_by_line, verify_status, verify_error,
            matched_known_user_id, name_claim, probed_at
       FROM liff_probes ORDER BY id DESC LIMIT 50`,
  ).all();
  return c.json({ knownUserIds: KNOWN_USER_IDS, probes: rows.results ?? [] });
}
