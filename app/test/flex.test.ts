import { describe, expect, it } from "vitest";
import { buildDecisionCard, type DecisionCardInput } from "../src/core/flex";

function card(over: Partial<DecisionCardInput> = {}): Record<string, unknown> {
  return buildDecisionCard({
    decisionNo: "D-001",
    version: 1,
    title: "廚房電路追加",
    amountIncTaxCents: 3675000,
    scheduleDeltaDays: 0,
    contentSha256: "abc123def456",
    requiredApprovalCount: 1,
    decisionId: "dec_x",
    nonce: "n1",
    ...over,
  }) as Record<string, unknown>;
}

/** Every text component anywhere in the tree. */
function textNodes(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const n of node) textNodes(n, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const rec = node as Record<string, unknown>;
  if (rec.type === "text") out.push(rec);
  for (const v of Object.values(rec)) textNodes(v, out);
  return out;
}

describe("decision card", () => {
  // LINE rejects the entire message if any text component is blank. A version
  // marker that rendered to "" made every version-1 card undeliverable while
  // the dashboard reported it as published -- the client saw nothing and the
  // designer had no way to tell.
  it("contains no empty text component at version 1", () => {
    const nodes = textNodes(card({ version: 1 }));
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(typeof n.text).toBe("string");
      expect(String(n.text).trim()).not.toBe("");
    }
  });

  it("contains no empty text component with every optional field absent", () => {
    const nodes = textNodes(
      card({
        version: 1,
        changeScope: null,
        changeReason: null,
        amountIncTaxCents: 0,
        scheduleDeltaDays: 0,
        lineItems: [],
        expiresAtText: null,
      }),
    );
    for (const n of nodes) expect(String(n.text).trim()).not.toBe("");
  });

  it("contains no empty text component with every optional field present", () => {
    const nodes = textNodes(
      card({
        version: 3,
        changeScope: "增設專用迴路",
        changeReason: "業主新增設備",
        scheduleDeltaDays: 3,
        requiredApprovalCount: 2,
        expiresAtText: "2026/09/30",
        lineItems: [
          { description: "220V 迴路", area: "廚房", unit: "式", quantityMilli: 2000, unitPriceCents: 1750000, lineTotalCents: 3500000 },
        ],
      }),
    );
    for (const n of nodes) expect(String(n.text).trim()).not.toBe("");
  });

  it("shows the version only when there is more than one", () => {
    // Asserted on the header box rather than the serialized card: postback
    // payloads carry their own format version ("v1|confirm|..."), so a string
    // search would match that instead of the card's version marker.
    const header = (c: Record<string, unknown>) => {
      const contents = ((c.contents as Record<string, unknown>).body as Record<string, unknown>)
        .contents as Array<Record<string, unknown>>;
      return header0(contents[0]);
    };
    const header0 = (box: Record<string, unknown>) => box.contents as Array<Record<string, unknown>>;

    expect(header(card({ version: 1 }))).toHaveLength(1);

    const v2 = header(card({ version: 2 }));
    expect(v2).toHaveLength(2);
    expect(String(v2[1].text)).toContain("v2");
  });

  it("still carries the decision number, title and amount", () => {
    const json = JSON.stringify(card());
    expect(json).toContain("D-001");
    expect(json).toContain("廚房電路追加");
    expect(json).toContain("36,750");
  });

  it("omits the amount block entirely when there is no cost impact", () => {
    const json = JSON.stringify(card({ amountIncTaxCents: 0 }));
    expect(json).not.toContain("追加金額");
    expect(json).not.toContain("減帳金額");
  });

  it("labels a deduction as such", () => {
    expect(JSON.stringify(card({ amountIncTaxCents: -1260000 }))).toContain("減帳金額");
  });

  it("says plainly that tapping is recorded, before the buttons", () => {
    const json = JSON.stringify(card());
    expect(json).toContain("系統會記錄確認人與時間");
  });

  it("routes through LIFF when the group has produced an unattributable tap", () => {
    const json = JSON.stringify(card({ liffUrl: "https://liff.line.me/x" }));
    expect(json).toContain("https://liff.line.me/x");
  });

  // The net under the conditional construction above: a future field that
  // renders blank should be dropped rather than taking the message down.
  it("drops a blank text node rather than emitting it", () => {
    const nodes = textNodes(card({ title: "有效標題", changeScope: "   " }));
    for (const n of nodes) expect(String(n.text).trim()).not.toBe("");
  });
});
