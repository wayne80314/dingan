/**
 * Identifier generation.
 *
 * ULIDs rather than autoincrement integers: ids stay unique if the database is
 * ever split per organization, and they sort by creation time, which makes
 * "what happened around then" answerable without a separate index.
 *
 * A type prefix travels with every id (dec_, cfm_, obx_ ...) so an id pasted
 * into a support conversation or a log line says what it refers to.
 */

// Crockford base32: no I, L, O or U, so ids survive being read aloud or
// retyped from a screenshot.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(nowMs: number): string {
  let out = "";
  let now = nowMs;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[now % ENCODING_LEN] + out;
    now = Math.floor(now / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return out;
}

export function ulid(nowMs: number = Date.now()): string {
  return encodeTime(nowMs) + encodeRandom();
}

export type IdPrefix =
  | "org"
  | "prj"
  | "grp"
  | "dec"
  | "snp"
  | "itm"
  | "cfm"
  | "msg"
  | "obx"
  | "aud"
  | "dl";

export function newId(prefix: IdPrefix, nowMs: number = Date.now()): string {
  return `${prefix}_${ulid(nowMs)}`;
}

/**
 * Nonce for a decision-card button.
 *
 * Not a ULID: this one is a capability, and a time-ordered value would let an
 * observer guess neighbouring nonces. 160 bits from the CSPRNG, hex-encoded.
 */
export function newNonce(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Formats a decision number: D-001, or D-001-R1 for a revision. */
export function formatDecisionNo(seq: number, revision = 0): string {
  const base = `D-${String(seq).padStart(3, "0")}`;
  return revision > 0 ? `${base}-R${revision}` : base;
}
