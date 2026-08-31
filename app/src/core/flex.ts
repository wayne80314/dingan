/**
 * The decision card as it appears in a LINE group.
 *
 * This is the only part of the product a client ever sees, and they see it on
 * a phone, mid-conversation, usually without much context. So the card leads
 * with what they are being asked to agree to and what it costs, and it says
 * plainly that tapping is recorded — nobody should be able to say afterwards
 * that they did not realise the button meant anything.
 *
 * What it deliberately does not do is overstate itself. It records an
 * agreement; it is not a signature and does not claim to be.
 */

import { formatTwd, formatQuantity } from "./money";
import { shortHash } from "./canonical";
import { encodePostbackData } from "../hook/postback";

const BRAND_GREEN = "#1F7A4D";
const INK = "#24211D";
const MUTED = "#6B6459";
const ADD_RED = "#B4402F";

export interface CardLineItem {
  description: string;
  area?: string | null;
  unit: string;
  quantityMilli: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface DecisionCardInput {
  decisionNo: string;
  version: number;
  title: string;
  changeScope?: string | null;
  changeReason?: string | null;
  amountIncTaxCents: number;
  scheduleDeltaDays: number;
  lineItems?: CardLineItem[];
  contentSha256: string;
  requiredApprovalCount: number;
  decisionId: string;
  nonce: string;
  /** Set when a group has previously produced a tap we could not attribute;
   * the card then routes through LIFF instead of a plain postback. */
  liffUrl?: string | null;
  expiresAtText?: string | null;
}

function textRow(label: string, value: string, valueColor = INK): unknown {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: MUTED, size: "sm", flex: 2 },
      { type: "text", text: value, color: valueColor, size: "sm", flex: 5, wrap: true },
    ],
  };
}

function lineItemRow(item: CardLineItem): unknown {
  const qty = `${formatQuantity(item.quantityMilli)} ${item.unit}`;
  const label = item.area ? `${item.area}／${item.description}` : item.description;
  return {
    type: "box",
    layout: "vertical",
    spacing: "none",
    margin: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: INK, wrap: true },
      {
        type: "box",
        layout: "baseline",
        contents: [
          { type: "text", text: qty, size: "xs", color: MUTED, flex: 3 },
          {
            type: "text",
            text: formatTwd(item.lineTotalCents, { withSign: true }),
            size: "xs",
            color: item.lineTotalCents < 0 ? BRAND_GREEN : ADD_RED,
            align: "end",
            flex: 2,
          },
        ],
      },
    ],
  };
}

/**
 * Removes text components whose text is empty.
 *
 * LINE rejects the whole message if any text component is blank, so a single
 * conditional field that renders to "" takes down the entire card. That
 * shipped once and made every version-1 card undeliverable while the dashboard
 * showed it as published. Building the tree conditionally is the real fix;
 * this is the net underneath it.
 */
function stripEmptyText(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node
      .map(stripEmptyText)
      .filter((n) => !(typeof n === "object" && n !== null && (n as Record<string, unknown>).__drop));
  }
  if (typeof node !== "object" || node === null) return node;

  const rec = node as Record<string, unknown>;
  if (rec.type === "text" && (typeof rec.text !== "string" || rec.text.trim() === "")) {
    return { __drop: true };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = stripEmptyText(v);
  return out;
}

/**
 * Builds the card.
 *
 * The amount is the largest thing on it. A change that costs money and is
 * agreed to in passing is the exact failure this product exists to prevent, so
 * the cost is not something a reader has to look for.
 */
export function buildDecisionCard(input: DecisionCardInput): unknown {
  const isAddition = input.amountIncTaxCents > 0;
  const hasAmount = input.amountIncTaxCents !== 0;

  const bodyContents: unknown[] = [
    {
      type: "box",
      layout: "baseline",
      // The version marker is omitted rather than emitted empty: LINE rejects
      // a text component whose text is "", failing the whole message. A card
      // at version 1 has nothing to say here, so it says nothing.
      contents: [
        { type: "text", text: input.decisionNo, weight: "bold", size: "sm", color: BRAND_GREEN, flex: 0 },
        ...(input.version > 1
          ? [{ type: "text", text: `  v${input.version}`, size: "xs", color: MUTED, flex: 0 }]
          : []),
      ],
    },
    { type: "text", text: input.title, weight: "bold", size: "lg", color: INK, wrap: true, margin: "sm" },
  ];

  if (input.changeScope) {
    bodyContents.push({
      type: "text",
      text: input.changeScope,
      size: "sm",
      color: MUTED,
      wrap: true,
      margin: "sm",
    });
  }

  if (hasAmount) {
    bodyContents.push({ type: "separator", margin: "lg" });
    bodyContents.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      contents: [
        {
          type: "text",
          text: isAddition ? "追加金額（含稅）" : "減帳金額（含稅）",
          size: "xs",
          color: MUTED,
        },
        {
          type: "text",
          text: formatTwd(input.amountIncTaxCents, { withSign: true }),
          size: "xxl",
          weight: "bold",
          color: isAddition ? ADD_RED : BRAND_GREEN,
        },
      ],
    });
  }

  if (input.lineItems && input.lineItems.length > 0) {
    bodyContents.push({ type: "separator", margin: "lg" });
    bodyContents.push({
      type: "text",
      text: "明細",
      size: "xs",
      color: MUTED,
      margin: "lg",
    });
    // Long itemisations are truncated rather than making the card unreadable;
    // the full breakdown belongs in the exported statement.
    for (const item of input.lineItems.slice(0, 6)) {
      bodyContents.push(lineItemRow(item));
    }
    if (input.lineItems.length > 6) {
      bodyContents.push({
        type: "text",
        text: `⋯ 另有 ${input.lineItems.length - 6} 項，完整明細請見追加減帳表`,
        size: "xs",
        color: MUTED,
        margin: "sm",
        wrap: true,
      });
    }
  }

  const metaRows: unknown[] = [];
  if (input.scheduleDeltaDays !== 0) {
    metaRows.push(
      textRow(
        "工期影響",
        input.scheduleDeltaDays > 0
          ? `延後 ${input.scheduleDeltaDays} 天`
          : `提前 ${Math.abs(input.scheduleDeltaDays)} 天`,
      ),
    );
  }
  if (input.requiredApprovalCount > 1) {
    metaRows.push(textRow("需確認人數", `${input.requiredApprovalCount} 位`));
  }
  if (input.expiresAtText) {
    metaRows.push(textRow("有效期限", input.expiresAtText));
  }
  if (metaRows.length > 0) {
    bodyContents.push({ type: "separator", margin: "lg" });
    bodyContents.push({ type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: metaRows });
  }

  // Stated before the buttons, not after: the consequence of tapping should be
  // known at the moment of tapping.
  bodyContents.push({
    type: "text",
    text: "點選下方按鈕即表示您已閱讀並同意本項內容、金額及工期影響，系統會記錄確認人與時間。",
    size: "xxs",
    color: MUTED,
    wrap: true,
    margin: "lg",
  });

  const confirmAction = input.liffUrl
    ? { type: "uri", label: "確認", uri: input.liffUrl }
    : {
        type: "postback",
        label: "確認",
        data: encodePostbackData({
          action: "confirm",
          decisionId: input.decisionId,
          version: input.version,
          nonce: input.nonce,
        }),
        displayText: `我確認 ${input.decisionNo}`,
      };

  return stripEmptyText({
    type: "flex",
    altText: `${input.decisionNo} ${input.title}${hasAmount ? ` ${formatTwd(input.amountIncTaxCents, { withSign: true })}` : ""}`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: bodyContents },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: BRAND_GREEN, action: confirmAction },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "secondary",
                height: "sm",
                action: {
                  type: "postback",
                  label: "要求修改",
                  data: encodePostbackData({
                    action: "request_changes",
                    decisionId: input.decisionId,
                    version: input.version,
                    nonce: input.nonce,
                  }),
                  displayText: `我要求修改 ${input.decisionNo}`,
                },
              },
              {
                type: "button",
                style: "secondary",
                height: "sm",
                action: {
                  type: "postback",
                  label: "不同意",
                  data: encodePostbackData({
                    action: "reject",
                    decisionId: input.decisionId,
                    version: input.version,
                    nonce: input.nonce,
                  }),
                  displayText: `我不同意 ${input.decisionNo}`,
                },
              },
            ],
          },
          // A short checksum, so a printed statement and the card someone
          // remembers seeing can be matched up later.
          {
            type: "text",
            text: `校驗碼 ${shortHash(input.contentSha256)}｜定案`,
            size: "xxs",
            color: MUTED,
            align: "center",
            margin: "sm",
          },
        ],
      },
    },
  });
}
