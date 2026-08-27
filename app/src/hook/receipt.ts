/**
 * Group receipts.
 *
 * The single highest-value defence in the design, and it costs one free reply:
 * after any tap, the group sees what was recorded. A confirmation nobody can
 * see is indistinguishable from one that never happened, so every failure mode
 * this product has — an identity that could not be resolved, a webhook that
 * went missing, someone tapping a card meant for someone else — becomes
 * visible to the people in the room at the moment it occurs, instead of
 * surfacing months later when the invoice is disputed.
 */

import type { PostbackOutcome, PostbackRejection } from "./postback";

function timestampText(nowMs: number, timeZone = "Asia/Taipei"): string {
  const fmt = new Intl.DateTimeFormat("zh-TW", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(new Date(nowMs));
}

function textMessage(text: string): unknown {
  return { type: "text", text };
}

/**
 * Builds the message announcing what was recorded.
 *
 * Names the person, the decision, and the time, so anyone in the group can
 * contradict it immediately if it is wrong. Where several approvals are
 * required, it says who is still outstanding — otherwise a half-approved
 * change reads as settled.
 */
export function buildReceiptMessages(
  outcome: PostbackOutcome,
  decisionNo: string,
  nowMs: number,
): unknown[] {
  switch (outcome.kind) {
    case "recorded": {
      const who = outcome.displayName ?? "（未知名稱）";
      const when = timestampText(nowMs);

      if (outcome.action === "reject") {
        return [textMessage(`🚫 已記錄：${who} 於 ${when} 不同意 ${decisionNo}。\n設計師會再與您聯繫。`)];
      }
      if (outcome.action === "request_changes") {
        return [textMessage(`✏️ 已記錄：${who} 於 ${when} 對 ${decisionNo} 要求修改。\n設計師會提出修訂版本。`)];
      }

      const head = `✅ 已記錄確認\n${decisionNo}\n確認人：${who}\n時間：${when}`;
      if (outcome.required > 1) {
        const remaining = Math.max(0, outcome.required - outcome.approvals);
        return [
          textMessage(
            remaining > 0
              ? `${head}\n狀態：${outcome.approvals}/${outcome.required} 已確認，尚待 ${remaining} 位確認`
              : `${head}\n狀態：${outcome.approvals}/${outcome.required} 已確認，本項決策成立`,
          ),
        ];
      }
      return [textMessage(`${head}\n狀態：已確認`)];
    }

    // The documented-but-unobserved case. Rather than dropping the tap, the
    // group is told plainly that it did not count and given the one action
    // that always carries an identity: sending a message.
    case "unidentified":
      return [
        textMessage(
          `⚠️ 收到 ${outcome.decisionNo} 的確認點擊，但無法識別是誰按的，因此尚未記錄為正式確認。\n` +
            `請確認人直接在群組中傳一則訊息：「我確認 ${outcome.decisionNo}」\n` +
            `（訊息一定帶得到身分資訊，按鈕在少數情況下不會。）`,
        ),
      ];

    case "duplicate":
      // Silent on purpose: this is a redelivery or a second tap by the same
      // person, and repeating the announcement would suggest a second event.
      return [];

    case "rejected":
      return buildRejectionMessages(outcome.reason, decisionNo);
  }
}

/**
 * Explains a tap that could not be accepted.
 *
 * Written to be read by a client in front of their designer, so none of it
 * accuses anyone of anything: the common causes are an old card resurfacing in
 * chat history or the wrong person tapping by accident, neither of which is
 * misconduct.
 */
function buildRejectionMessages(reason: PostbackRejection, decisionNo: string): unknown[] {
  switch (reason) {
    case "version_mismatch":
      return [
        textMessage(
          `ℹ️ 這張 ${decisionNo} 卡片已有更新版本，這次點擊未被記錄。\n請改用群組中最新的那張卡片。`,
        ),
      ];
    case "nonce_expired":
      return [textMessage(`ℹ️ 這張 ${decisionNo} 卡片已逾期，未記錄。如仍需確認，請設計師重新發送。`)];
    case "nonce_invalidated":
      return [textMessage(`ℹ️ 這張 ${decisionNo} 卡片已失效（可能已被新版本取代），未記錄。`)];
    case "not_pending":
      return [textMessage(`ℹ️ ${decisionNo} 已經結案，這次點擊未重複記錄。`)];
    case "not_an_approver":
      return [
        textMessage(
          `ℹ️ 這張卡片需要由業主本人確認，因此這次點擊未記錄為確認。\n若指定確認人有誤，請告知設計師調整。`,
        ),
      ];
    case "group_mismatch":
      // A card confirmed outside the group it was issued to would be a record
      // of an agreement made somewhere nobody can see. Stay silent here: the
      // tap happened in a chat that has nothing to do with this project.
      return [];
    case "unknown_nonce":
    case "malformed_data":
      return [];
  }
}
