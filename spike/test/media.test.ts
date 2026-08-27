import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContent } from "../src/line";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serves `bytes` as a fetch Response, optionally omitting Content-Length to
 * mimic LINE's content endpoint, which does not always send it. */
function mockContentResponse(bytes: Uint8Array, opts: { withContentLength: boolean; mime?: string }) {
  globalThis.fetch = vi.fn(async () => {
    const headers = new Headers({ "content-type": opts.mime ?? "image/jpeg" });
    if (opts.withContentLength) headers.set("content-length", String(bytes.byteLength));

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split across chunks so the capped reader's
        // chunk-boundary handling is actually exercised.
        const mid = Math.floor(bytes.byteLength / 2);
        controller.enqueue(bytes.subarray(0, mid));
        controller.enqueue(bytes.subarray(mid));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers });
  }) as unknown as typeof fetch;
}

function makeBytes(n: number, fill = 7): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("getContent", () => {
  it("stores media and reports its size when Content-Length is present", async () => {
    const bytes = makeBytes(2048);
    mockContentResponse(bytes, { withContentLength: true });

    const result = await getContent(testEnv, "msg-with-length");
    expect(result.success).toBe(true);
    expect(result.sizeBytes).toBe(2048);
    expect(result.error).toBeNull();

    const stored = await testEnv.MEDIA.get("media/msg-with-length");
    expect(stored).not.toBeNull();
    expect((await stored!.arrayBuffer()).byteLength).toBe(2048);
  });

  // Regression guard: R2 rejects streams of indeterminate length with
  // "Provided readable stream must have a known length". An earlier version
  // piped a byte-capping TransformStream straight into put(), which stripped
  // the length and made every real image fetch fail in production while the
  // suite stayed green.
  it("stores media even when Content-Length is absent", async () => {
    const bytes = makeBytes(3000, 9);
    mockContentResponse(bytes, { withContentLength: false });

    const result = await getContent(testEnv, "msg-no-length");
    expect(result.success).toBe(true);
    expect(result.sizeBytes).toBe(3000);

    const stored = await testEnv.MEDIA.get("media/msg-no-length");
    expect(stored).not.toBeNull();
    const storedBytes = new Uint8Array(await stored!.arrayBuffer());
    expect(storedBytes.byteLength).toBe(3000);
    expect(storedBytes[0]).toBe(9);
    expect(storedBytes[2999]).toBe(9);
  });

  it("records the content type LINE reported", async () => {
    mockContentResponse(makeBytes(64), { withContentLength: true, mime: "video/mp4" });
    const result = await getContent(testEnv, "msg-mime");
    expect(result.mime).toBe("video/mp4");
  });

  it("reports failure without throwing when LINE returns an error status", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const result = await getContent(testEnv, "msg-404");
    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });

  it("reports failure without throwing when the network call itself fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const result = await getContent(testEnv, "msg-boom");
    expect(result.success).toBe(false);
    expect(result.error).toContain("connection reset");
  });
});
