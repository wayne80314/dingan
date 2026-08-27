import { describe, expect, it } from "vitest";
import {
  formatQuantity,
  formatTwd,
  lineTotalCents,
  roundHalfAwayFromZero,
  splitTax,
  sumLineTotals,
} from "../src/core/money";

describe("roundHalfAwayFromZero", () => {
  it("rounds a half away from zero in both directions", () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
  });

  // A deduction must be the exact mirror of the addition it reverses,
  // otherwise reversing a change leaves a residue on the invoice.
  it("makes a deduction the exact mirror of its addition", () => {
    for (const v of [0.5, 1.5, 2.5, 12.5, 1234.5]) {
      expect(roundHalfAwayFromZero(-v)).toBe(-roundHalfAwayFromZero(v));
    }
  });

  it("leaves whole numbers untouched", () => {
    expect(roundHalfAwayFromZero(7)).toBe(7);
    expect(roundHalfAwayFromZero(-7)).toBe(-7);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });
});

describe("lineTotalCents", () => {
  it("multiplies a fractional quantity by a unit price", () => {
    // 2.5 坪 × NT$1,200.00
    expect(lineTotalCents(2500, 120000)).toBe(300000);
  });

  it("rounds a fractional result to the cent", () => {
    // 0.333 × NT$100.00 = NT$33.30
    expect(lineTotalCents(333, 10000)).toBe(3330);
  });

  it("carries the sign of a deduction through", () => {
    expect(lineTotalCents(1000, -50000)).toBe(-50000);
    expect(lineTotalCents(-1000, 50000)).toBe(-50000);
  });

  it("handles a quantity of one expressed in thousandths", () => {
    expect(lineTotalCents(1000, 3500000)).toBe(3500000); // 1 式 × NT$35,000
  });
});

describe("splitTax", () => {
  it("adds tax on top for an exclusive quotation", () => {
    // NT$35,000 + 5%
    expect(splitTax(3500000, "exclusive", 500)).toEqual({
      exTaxCents: 3500000,
      taxCents: 175000,
      incTaxCents: 3675000,
    });
  });

  it("extracts tax from within an inclusive quotation", () => {
    const r = splitTax(3675000, "inclusive", 500);
    expect(r.incTaxCents).toBe(3675000);
    expect(r.exTaxCents).toBe(3500000);
    expect(r.taxCents).toBe(175000);
  });

  it("keeps inclusive components summing to the original total", () => {
    // Whatever the rounding, ex + tax must equal what the client was quoted.
    for (const total of [100001, 333333, 987654, 1, 7]) {
      const r = splitTax(total, "inclusive", 500);
      expect(r.exTaxCents + r.taxCents).toBe(total);
    }
  });

  it("charges nothing for exempt and zero-rated work", () => {
    expect(splitTax(500000, "exempt", 500).taxCents).toBe(0);
    expect(splitTax(500000, "zero", 500).taxCents).toBe(0);
    expect(splitTax(500000, "exempt", 500).incTaxCents).toBe(500000);
  });

  it("treats a zero rate as untaxed even in exclusive mode", () => {
    expect(splitTax(500000, "exclusive", 0)).toEqual({
      exTaxCents: 500000,
      taxCents: 0,
      incTaxCents: 500000,
    });
  });

  it("keeps a deduction negative through the tax split", () => {
    const r = splitTax(-3500000, "exclusive", 500);
    expect(r.exTaxCents).toBe(-3500000);
    expect(r.taxCents).toBe(-175000);
    expect(r.incTaxCents).toBe(-3675000);
  });

  it("makes a deduction exactly reverse its addition", () => {
    const add = splitTax(1234567, "exclusive", 500);
    const sub = splitTax(-1234567, "exclusive", 500);
    expect(sub.taxCents).toBe(-add.taxCents);
    expect(sub.incTaxCents).toBe(-add.incTaxCents);
  });
});

describe("sumLineTotals", () => {
  it("sums the printed line figures exactly", () => {
    expect(sumLineTotals([3330, 3330, 3330])).toBe(9990);
  });

  // The total a client gets by adding the visible lines must be the total we
  // print. Summing unrounded values first would differ by a cent here.
  it("agrees with adding up the rounded lines by hand", () => {
    const lines = [lineTotalCents(333, 10000), lineTotalCents(333, 10000), lineTotalCents(334, 10000)];
    expect(sumLineTotals(lines)).toBe(3330 + 3330 + 3340);
  });

  it("nets additions against deductions", () => {
    expect(sumLineTotals([3500000, -1200000])).toBe(2300000);
  });

  it("returns zero for no lines", () => {
    expect(sumLineTotals([])).toBe(0);
  });
});

describe("formatTwd", () => {
  it("groups thousands", () => {
    expect(formatTwd(3500000)).toBe("NT$35,000");
  });

  it("shows cents only when they are non-zero", () => {
    expect(formatTwd(3500050)).toBe("NT$35,000.50");
    expect(formatTwd(3500000)).toBe("NT$35,000");
  });

  it("always marks a deduction as negative", () => {
    expect(formatTwd(-3500000)).toBe("-NT$35,000");
  });

  // On an invoice attachment, an unsigned figure that turns out to be a
  // deduction is exactly the ambiguity this product exists to remove.
  it("can force a plus sign so additions are unmistakable", () => {
    expect(formatTwd(3500000, { withSign: true })).toBe("+NT$35,000");
    expect(formatTwd(-3500000, { withSign: true })).toBe("-NT$35,000");
  });

  it("formats zero without a sign", () => {
    expect(formatTwd(0)).toBe("NT$0");
    expect(formatTwd(0, { withSign: true })).toBe("+NT$0");
  });
});

describe("formatQuantity", () => {
  it("always shows three decimals", () => {
    expect(formatQuantity(2500)).toBe("2.500");
    expect(formatQuantity(1000)).toBe("1.000");
    expect(formatQuantity(333)).toBe("0.333");
  });

  it("keeps a negative quantity signed", () => {
    expect(formatQuantity(-2500)).toBe("-2.500");
  });

  it("formats zero", () => {
    expect(formatQuantity(0)).toBe("0.000");
  });
});
