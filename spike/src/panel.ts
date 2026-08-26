import type { Context } from "hono";
import { constantTimeStringEqual } from "./signature";
import { insertPushLog, queryPushUsageThisMonth, queryRecentGroupIds, safeInsertError } from "./db";
import { getGroupMemberCount, pushMessage } from "./line";
import type { Env, PushCardType } from "./types";

// Reference baseline only -- LINE's actual free-tier monthly push cap as of
// this spike's research (200 messages/month on the lightest plan). This is
// NOT read from any LINE API and does NOT reflect whichever plan (輕用量
// 200 / 中用量 3,000 / 高用量 6,000, see docs/pricing.md) the account is
// really provisioned on. Treat the /panel usage bar as a rough F0-only
// sanity check, never as the authoritative quota source -- that's LINE
// Official Account Manager's billing/usage page. See RUNBOOK.md.
const FREE_TIER_MONTHLY_PUSH_LIMIT_BASELINE = 200;

function checkToken(c: Context<{ Bindings: Env }>, token: string | undefined | null): boolean {
  if (!token) return false;
  return constantTimeStringEqual(token, c.env.PANEL_TOKEN);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function handlePanelGet(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("token");
  if (!checkToken(c, token)) return c.text("unauthorized", 401);

  const [groupIds, usage] = await Promise.all([
    queryRecentGroupIds(c.env, 50),
    queryPushUsageThisMonth(c.env),
  ]);

  const t = encodeURIComponent(token!);
  const pct = Math.min(
    100,
    Math.round((usage.totalRecipients / FREE_TIER_MONTHLY_PUSH_LIMIT_BASELINE) * 100),
  );

  const groupOptions = groupIds.length
    ? groupIds.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("")
    : `<option value="" disabled>尚無已捕獲的 group_id -- 先在群組裡送一則訊息</option>`;

  const html = `<!doctype html>
<meta charset="utf-8">
<title>定案 F0 Spike Panel</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  fieldset { margin-bottom: 1.5rem; }
  label { display: block; margin: 0.5rem 0 0.2rem; }
  select, button { padding: 0.4rem; font-size: 1rem; }
  .bar-track { background: #eee; border-radius: 4px; height: 10px; overflow: hidden; }
  .bar-fill { background: ${pct >= 90 ? "#c0392b" : "#2d7a3e"}; height: 100%; }
  .note { color: #666; font-size: 0.85rem; }
</style>
<h1>定案 F0 Spike Panel</h1>

<section>
  <h2>本月 push 用量（粗估，非官方額度來源）</h2>
  <p>已推播 <strong>${usage.totalRecipients}</strong> 則（依收件人數計，非 API 呼叫次數）／基準線 ${FREE_TIER_MONTHLY_PUSH_LIMIT_BASELINE} 則（LINE 最輕量方案）。共 ${usage.pushCount} 次推播操作。</p>
  <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
  <p class="note">此基準線是 F0 內部參考值，不代表 Wayne 實際開通的 LINE 方案（輕用量/中用量/高用量）真實額度。真實用量與額度請以 LINE Official Account Manager 的帳務頁為準。</p>
</section>

<section>
  <h2>推播測試卡</h2>
  <form method="post" action="/panel/push?token=${t}">
    <label for="groupId">目標 groupId</label>
    <select name="groupId" id="groupId" required>${groupOptions}</select>
    <label for="cardType">卡片類型</label>
    <select name="cardType" id="cardType">
      <option value="postback">postback 按鈕</option>
      <option value="message-action">message action 按鈕</option>
      <option value="text">純文字對照組</option>
    </select>
    <button type="submit">推播</button>
  </form>
</section>

<section>
  <h2>已捕獲的 group_id</h2>
  <p>${groupIds.length} 個。用 <a href="/report?token=${t}&format=html">/report</a> 看完整分析矩陣。</p>
</section>
`;

  return c.html(html);
}

function buildMessages(cardType: PushCardType): unknown[] {
  if (cardType === "text") {
    return [
      {
        type: "text",
        text: "【定案 Spike 對照組】這是一則純文字訊息，不含任何按鈕。",
      },
    ];
  }

  const action =
    cardType === "postback"
      ? { type: "postback", label: "確認 D-001", data: "confirm:D-001", displayText: "確認 D-001" }
      : { type: "message", label: "確認 D-001", text: "我確認 D-001" };

  return [
    {
      type: "flex",
      altText: "定案 Spike 測試卡：確認 D-001",
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "測試決策卡 D-001", weight: "bold", size: "md" },
            { type: "text", text: `按鈕類型：${cardType}`, size: "sm", color: "#888888", wrap: true },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "button",
              style: "primary",
              action,
            },
          ],
        },
      },
    },
  ];
}

export async function handlePanelPush(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("token");
  if (!checkToken(c, token)) return c.text("unauthorized", 401);

  let body: { groupId?: unknown; cardType?: unknown };
  try {
    body = await c.req.json();
  } catch (err) {
    await safeInsertError(c.env, "panel_push", err);
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const groupId = typeof body.groupId === "string" ? body.groupId : null;
  const cardType =
    body.cardType === "postback" || body.cardType === "message-action" || body.cardType === "text"
      ? (body.cardType as PushCardType)
      : null;

  if (!groupId || !cardType) {
    return c.json({ ok: false, error: "groupId and cardType (postback|message-action|text) are required" }, 400);
  }

  // Push billing is per recipient, so we look up the group's member count
  // first to log an accurate recipient_count -- not "1 API call = 1 unit".
  const countResult = await getGroupMemberCount(c.env, groupId);
  const recipientCount = countResult.count;

  const messages = buildMessages(cardType);
  const pushResult = await pushMessage(c.env, groupId, messages);

  await insertPushLog(c.env, {
    cardType,
    groupId,
    recipientCount,
    statusCode: pushResult.statusCode,
    pushedAt: Date.now(),
  });

  return c.json({
    ok: pushResult.success,
    statusCode: pushResult.statusCode,
    recipientCount,
    memberCountLookupOk: countResult.success,
    lineResponseBody: pushResult.body,
  });
}
