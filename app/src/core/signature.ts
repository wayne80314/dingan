/**
 * LINE webhook signature verification.
 *
 * Per LINE's official docs (verified 2026-08-27): HMAC-SHA256 over the raw,
 * unmodified request body string, keyed with the channel secret, Base64
 * encoded, compared against the `x-line-signature` header.
 */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Always compare the same number of bytes regardless of where a mismatch
  // occurs, so timing does not leak how many leading bytes matched. Lengths
  // differing is itself safe to branch on (no secret-dependent early exit
  // WITHIN the loop).
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verifies a LINE webhook request signature.
 *
 * @param rawBody the exact, unparsed request body string as received
 * @param signatureHeader the `x-line-signature` header value, or null if absent
 * @param channelSecret the LINE channel secret
 */
export async function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  if (!channelSecret) return false;

  let expectedBytes: Uint8Array;
  try {
    expectedBytes = base64ToBytes(signatureHeader);
  } catch {
    // Not valid base64 -- can't possibly match, and atob() throwing must not
    // propagate as a 500.
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const macBytes = new Uint8Array(macBuffer);

  return constantTimeEqual(macBytes, expectedBytes);
}

/** Constant-time comparison for opaque bearer tokens (e.g. PANEL_TOKEN),
 * as plain strings rather than base64-decoded HMACs. */
export function constantTimeStringEqual(a: string, b: string): boolean {
  return constantTimeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
