import { describe, expect, it } from "vitest";
import { canonicalize, canonicalizeAndHash, sha256Hex, shortHash } from "../src/core/canonical";

describe("canonicalize", () => {
  it("orders keys so equal records serialize identically", () => {
    const a = canonicalize({ b: 2, a: 1, c: 3 });
    const b = canonicalize({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":3}');
  });

  it("orders nested keys too", () => {
    const a = canonicalize({ outer: { z: 1, a: 2 } });
    const b = canonicalize({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  // Chinese text entered on different platforms can carry different but
  // equivalent code point sequences; without normalization the same decision
  // would hash differently depending on where it was typed.
  it("treats canonically equivalent Unicode as the same text", () => {
    const composed = "高"; // 高
    const withCombining = "が"; // か + combining dakuten
    const precomposed = "が"; // が
    expect(canonicalize({ t: withCombining })).toBe(canonicalize({ t: precomposed }));
    expect(canonicalize({ t: composed })).toBe('{"t":"高"}');
  });

  it("normalizes keys as well as values", () => {
    const a: Record<string, string> = {};
    a["が"] = "x";
    const b: Record<string, string> = {};
    b["が"] = "x";
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("omits undefined properties rather than emitting null for them", () => {
    expect(canonicalize({ a: 1, b: undefined as never })).toBe('{"a":1}');
  });

  it("keeps an explicit null, which means something different", () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("handles empty containers", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  it("escapes quotes and control characters", () => {
    expect(canonicalize({ t: 'say "hi"' })).toBe('{"t":"say \\"hi\\""}');
    expect(canonicalize({ t: "line\nbreak" })).toBe('{"t":"line\\nbreak"}');
  });

  // Floats have no stable textual form across platforms, so they must never
  // reach a hash. Quantities are carried as fixed-precision strings instead.
  it("refuses a non-integer number", () => {
    expect(() => canonicalize({ n: 1.5 })).toThrow(/non-integer/);
  });

  it("refuses NaN and Infinity", () => {
    expect(() => canonicalize({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ n: Infinity })).toThrow(/non-finite/);
  });

  it("accepts negative integers, which deductions rely on", () => {
    expect(canonicalize({ amount: -3500000 })).toBe('{"amount":-3500000}');
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", () => {
    return expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", () => {
    return expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("canonicalizeAndHash", () => {
  it("gives the same hash regardless of key order", async () => {
    const a = await canonicalizeAndHash({ title: "廚房追加", amount: 3500000 });
    const b = await canonicalizeAndHash({ amount: 3500000, title: "廚房追加" });
    expect(a.contentSha256).toBe(b.contentSha256);
  });

  it("gives a different hash when the amount changes", async () => {
    const a = await canonicalizeAndHash({ title: "廚房追加", amount: 3500000 });
    const b = await canonicalizeAndHash({ title: "廚房追加", amount: 3500001 });
    expect(a.contentSha256).not.toBe(b.contentSha256);
  });

  it("gives a different hash when the text changes", async () => {
    const a = await canonicalizeAndHash({ title: "廚房追加" });
    const b = await canonicalizeAndHash({ title: "廚房追加." });
    expect(a.contentSha256).not.toBe(b.contentSha256);
  });

  // The hash is what a confirmation attests to, so it has to survive being
  // recomputed on another day, on another machine, after a round trip through
  // storage. This pins the exact value for a representative record.
  it("is stable for a representative decision record", async () => {
    const record = {
      decisionNo: "D-001",
      version: 1,
      title: "廚房電路追加",
      amountIncTaxCents: 3675000,
      lineItems: [{ description: "專用迴路", quantity: "2.000", unitPriceCents: 750000 }],
    };
    const first = await canonicalizeAndHash(record);
    const second = await canonicalizeAndHash(JSON.parse(JSON.stringify(record)));
    expect(second.contentSha256).toBe(first.contentSha256);
    expect(first.canonicalJson).toBe(
      '{"amountIncTaxCents":3675000,"decisionNo":"D-001","lineItems":[{"description":"專用迴路","quantity":"2.000","unitPriceCents":750000}],"title":"廚房電路追加","version":1}',
    );
  });
});

describe("shortHash", () => {
  it("takes the first eight characters, uppercased", () => {
    expect(shortHash("ba7816bf8f01cfea414140de5dae2223")).toBe("BA7816BF");
  });
});
