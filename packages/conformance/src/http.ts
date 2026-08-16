export interface RateLimitRetryOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  requestTimeoutMs?: number;
  maxRetryAfterMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

/**
 * Fetch a conformance probe while respecting a target's standard 429 response.
 *
 * A 429 response means the probe was rejected before its operation ran, so it
 * is safe to retry after the server's Retry-After interval. Each attempt gets
 * a fresh timeout signal; otherwise the original signal would expire while the
 * client was deliberately waiting for the rate-limit window to reset.
 */
export async function fetchWithRateLimitRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  options: RateLimitRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status !== 429 || attempt >= maxRetries) return response;

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs === null) return response;

    await response.body?.cancel().catch(() => undefined);
    await sleep(Math.min(retryAfterMs, maxRetryAfterMs));
  }
}

/** Statuses that prove a protocol endpoint exists, even when a bare probe is invalid. */
export function isReachableHttpStatus(status: number): boolean {
  return (
    (status >= 200 && status < 300) ||
    status === 400 ||
    status === 405 ||
    status === 406 ||
    status === 415
  );
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}
