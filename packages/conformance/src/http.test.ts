import { describe, expect, it, vi } from "vitest";
import { fetchWithRateLimitRetry, isReachableHttpStatus } from "./http.js";

describe("conformance HTTP probes", () => {
  it("treats content negotiation rejections as proof that an endpoint exists", () => {
    expect(isReachableHttpStatus(200)).toBe(true);
    expect(isReachableHttpStatus(400)).toBe(true);
    expect(isReachableHttpStatus(405)).toBe(true);
    expect(isReachableHttpStatus(406)).toBe(true);
    expect(isReachableHttpStatus(415)).toBe(true);
    expect(isReachableHttpStatus(404)).toBe(false);
    expect(isReachableHttpStatus(500)).toBe(false);
  });

  it("honors Retry-After before retrying a rejected probe", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "60" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    const response = await fetchWithRateLimitRetry(
      "https://example.test/mcp",
      {},
      {
        fetchImpl,
        sleep,
      },
    );

    expect(response.status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("returns a 429 without retrying when Retry-After is absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    const response = await fetchWithRateLimitRetry(
      "https://example.test/mcp",
      {},
      {
        fetchImpl,
        sleep,
      },
    );

    expect(response.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
