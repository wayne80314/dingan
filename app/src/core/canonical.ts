/**
 * Canonical serialization and content hashing.
 *
 * A confirmation attests to a specific decision content. For that to mean
 * anything later, the same content must always produce the same hash --
 * across processes, across deploys, and after the text has made a round trip
 * through LINE, a database, and a PDF.
 *
 * Two things break that if left alone:
 *
 *   1. Key order. JSON objects have no inherent order, and JS preserves
 *      insertion order, so two equal records can serialize differently.
 *      Keys are sorted.
 *
 *   2. Unicode normalization. Chinese text entered on different platforms can
 *      carry different-but-equivalent code point sequences, and the same is
 *      true of the full-width punctuation common in Taiwanese quotations.
 *      Everything is normalized to NFC before hashing.
 *
 * Numbers are emitted as integers only. Decimal quantities are carried as
 * pre-formatted strings (see money.formatQuantity) so no float ever reaches
 * the hash, where its textual form would be platform-dependent.
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function normalizeString(s: string): string {
  return s.normalize("NFC");
}

/** Serializes to JSON with sorted keys and NFC-normalized strings. */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(normalizeString(value));

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number ${value}`);
    }
    if (!Number.isInteger(value)) {
      // Floats have no stable textual form worth hashing. Callers convert
      // decimals to strings (money.formatQuantity) before they get here.
      throw new Error(
        `canonicalize: non-integer number ${value}; convert to a fixed-precision string first`,
      );
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(normalizeString(k))}:${canonicalize(value[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a canonical string, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(digest);
}

export interface CanonicalResult {
  canonicalJson: string;
  contentSha256: string;
}

/** Canonicalizes and hashes in one step; what the publish path stores. */
export async function canonicalizeAndHash(value: CanonicalValue): Promise<CanonicalResult> {
  const canonicalJson = canonicalize(value);
  return { canonicalJson, contentSha256: await sha256Hex(canonicalJson) };
}

/** Short human-facing form of a content hash, for printing on a card or an
 * export where a full 64-character digest would just be visual noise. It is a
 * cross-check for people, never a substitute for the full value. */
export function shortHash(contentSha256: string): string {
  return contentSha256.slice(0, 8).toUpperCase();
}
