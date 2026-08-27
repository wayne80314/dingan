/**
 * Money and quantity arithmetic.
 *
 * Everything is integer: amounts in cents (1/100 TWD), quantities in
 * thousandths. No value in this module is ever a float, because a quotation
 * that does not add up is a quotation the client stops trusting.
 *
 * Signs carry meaning: a positive amount is an addition (追加), a negative one
 * a deduction (減帳). There is no separate "kind" field to disagree with the
 * number.
 */

export type TaxMode = "inclusive" | "exclusive" | "exempt" | "zero";

/** Rounds a rational value to an integer, half away from zero.
 *
 * Half away from zero (rather than JS's Math.round, which is half-up toward
 * +Infinity) keeps a deduction the exact mirror of the addition it reverses:
 * -0.5 must round to -1 when 0.5 rounds to 1, or reversing a change leaves a
 * one-cent residue behind. */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Line total for one row of a quotation.
 *
 * Rounded per line and then summed, which is how a printed quotation is read:
 * every line shows a whole-cent figure and the total must equal what a client
 * gets by adding the visible numbers. Summing unrounded values and rounding
 * once yields a total that fails that check by a cent or two -- small enough
 * to look like carelessness, which is worse than being wrong by a lot.
 */
export function lineTotalCents(quantityMilli: number, unitPriceCents: number): number {
  return roundHalfAwayFromZero((quantityMilli * unitPriceCents) / 1000);
}

export interface TaxBreakdown {
  exTaxCents: number;
  taxCents: number;
  incTaxCents: number;
}

/**
 * Splits a subtotal into ex-tax / tax / inc-tax according to how the quotation
 * was written.
 *
 * `subtotalCents` is interpreted per `mode`: for 'exclusive' it is the pre-tax
 * figure, for 'inclusive' it already contains tax. Taiwanese interior-design
 * quotations use both conventions, sometimes from the same firm, so the mode
 * travels with the record rather than being assumed.
 */
export function splitTax(
  subtotalCents: number,
  mode: TaxMode,
  taxRateBp: number,
): TaxBreakdown {
  if (mode === "exempt" || mode === "zero" || taxRateBp === 0) {
    return { exTaxCents: subtotalCents, taxCents: 0, incTaxCents: subtotalCents };
  }

  if (mode === "inclusive") {
    // subtotal already contains tax: ex = subtotal / (1 + rate)
    const exTaxCents = roundHalfAwayFromZero((subtotalCents * 10000) / (10000 + taxRateBp));
    return {
      exTaxCents,
      taxCents: subtotalCents - exTaxCents,
      incTaxCents: subtotalCents,
    };
  }

  const taxCents = roundHalfAwayFromZero((subtotalCents * taxRateBp) / 10000);
  return {
    exTaxCents: subtotalCents,
    taxCents,
    incTaxCents: subtotalCents + taxCents,
  };
}

/** Sums already-rounded line totals. Trivial, but named so call sites read as
 * "sum of the printed lines" rather than an ad-hoc reduce. */
export function sumLineTotals(lineTotalsCents: readonly number[]): number {
  return lineTotalsCents.reduce((acc, n) => acc + n, 0);
}

/** Formats cents as a TWD figure for display and exports, e.g. 追加 +NT$35,000.
 * The sign is explicit: on an invoice attachment, "35,000" that turns out to
 * be a deduction is the kind of ambiguity this product exists to remove. */
export function formatTwd(cents: number, opts: { withSign?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const wholeText = whole.toLocaleString("zh-TW");
  const body = frac === 0 ? wholeText : `${wholeText}.${String(frac).padStart(2, "0")}`;
  // Zero has no direction; signing it reads as an addition of nothing.
  const sign = negative ? "-" : opts.withSign && cents !== 0 ? "+" : "";
  return `${sign}NT$${body}`;
}

/** Renders quantity_milli as a fixed three-decimal string. Used both for
 * display and inside canonical JSON, where a stable textual form is what keeps
 * a content hash reproducible. */
export function formatQuantity(quantityMilli: number): string {
  const negative = quantityMilli < 0;
  const abs = Math.abs(quantityMilli);
  const whole = Math.trunc(abs / 1000);
  const frac = abs % 1000;
  return `${negative ? "-" : ""}${whole}.${String(frac).padStart(3, "0")}`;
}
