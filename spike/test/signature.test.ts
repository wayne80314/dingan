import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "../src/signature";
import { TEST_CHANNEL_SECRET, signBody } from "./fixtures";

const BODY = JSON.stringify({ destination: "Uxxxx", events: [] });

describe("verifyLineSignature", () => {
  it("accepts a correctly signed body", async () => {
    const sig = await signBody(BODY);
    await expect(verifyLineSignature(BODY, sig, TEST_CHANNEL_SECRET)).resolves.toBe(true);
  });

  it("rejects a tampered body signed against the original bytes", async () => {
    const sig = await signBody(BODY);
    const tampered = BODY.replace("Uxxxx", "Uyyyy");
    await expect(verifyLineSignature(tampered, sig, TEST_CHANNEL_SECRET)).resolves.toBe(false);
  });

  it("rejects a signature produced with the wrong channel secret", async () => {
    const sig = await signBody(BODY, "wrong_secret");
    await expect(verifyLineSignature(BODY, sig, TEST_CHANNEL_SECRET)).resolves.toBe(false);
  });

  it("rejects a missing signature header", async () => {
    await expect(verifyLineSignature(BODY, null, TEST_CHANNEL_SECRET)).resolves.toBe(false);
  });

  it("rejects an empty-string signature header", async () => {
    await expect(verifyLineSignature(BODY, "", TEST_CHANNEL_SECRET)).resolves.toBe(false);
  });

  it("rejects a non-base64 signature header without throwing", async () => {
    await expect(
      verifyLineSignature(BODY, "not-valid-base64!!!", TEST_CHANNEL_SECRET),
    ).resolves.toBe(false);
  });

  it("rejects when channelSecret is empty (short-circuits before any WebCrypto call, which would reject a zero-length HMAC key anyway)", async () => {
    const sig = await signBody(BODY);
    await expect(verifyLineSignature(BODY, sig, "")).resolves.toBe(false);
  });

  it("matches LINE's own documented openssl example", async () => {
    // From developers.line.biz's signature validation docs (verified
    // 2026-08-27): echo -n '{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}'
    // | openssl dgst -sha256 -hmac '8c570fa6dd201bb328f1c1eac23a96d8' -binary | openssl base64
    // => GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs=
    const docBody = '{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}';
    const docSecret = "8c570fa6dd201bb328f1c1eac23a96d8";
    const docSignature = "GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs=";
    await expect(verifyLineSignature(docBody, docSignature, docSecret)).resolves.toBe(true);
  });
});
