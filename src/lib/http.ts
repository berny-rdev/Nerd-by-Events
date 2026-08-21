/**
 * Small fetch wrapper shared by every source adapter.
 *
 * Two things it adds over bare `fetch`:
 *  - a timeout, because a hung request would otherwise pin a source's promise
 *    open forever and the aggregate search would never settle;
 *  - a typed error carrying the status, so the UI can tell "your key is wrong"
 *    (401/403) apart from "the network is down".
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}`);
    this.name = 'HttpError';
  }

  /** True when the problem is our credentials rather than the network. */
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

type FetchOptions = {
  /** Caller's cancellation signal — TanStack Query passes one in. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Defaults to GET. */
  method?: 'GET' | 'POST';
  /** JSON-serialized and sent as the body. Implies POST-shaped headers. */
  json?: unknown;
};

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { signal, timeoutMs = 10_000, method = 'GET', json: body } = options;

  // Hermes doesn't reliably have AbortSignal.any, so combine by hand: our
  // timeout controller aborts on its own OR when the caller's signal fires.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new HttpError(response.status, url, await response.text().catch(() => ''));
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Builds a query string, dropping empty values so we don't send `&city=`. */
export function buildUrl(base: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Body `code` the Worker uses to mean "this source has no secret configured".
 *
 * Mirrors `NOT_CONFIGURED` in `proxy/src/lib/http.ts`. Every source's
 * `isConfigured()` is now just "is the Worker URL set", so the app cannot know
 * a *particular* source lacks its key until the Worker says so — this is how it
 * finds out.
 */
export const NOT_CONFIGURED = 'not_configured';

/** True when a failure means "never set up" rather than "broke just now". */
export function isNotConfiguredError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  try {
    const parsed: unknown = JSON.parse(error.body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { code?: unknown }).code === NOT_CONFIGURED
    );
  } catch {
    return false;
  }
}
