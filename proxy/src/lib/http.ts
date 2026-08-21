/** Response helpers and the error type routes throw to short-circuit. */

export class HttpError extends Error {
  // Written out longhand rather than as constructor parameter properties:
  // Node's strip-only TypeScript mode (what runs the tests) erases types but
  // cannot generate the assignments those imply, and rejects them outright.
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Largest request body we'll read. Guards the model routes against abuse. */
export const MAX_BODY_BYTES = 128 * 1024;

export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body too large');
  }

  const text = await request.text();
  // Content-Length is a claim, not a guarantee — check what actually arrived.
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body too large');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

/** Trims and collapses whitespace; returns '' for anything unusable. */
export function cleanString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Body `code` marking "this source has no secret configured".
 *
 * A missing secret is not an upstream failure and must not read like one. The
 * app keys on this to put the source in its *skipped* list — the way an
 * unconfigured source behaved before the keys moved onto the Worker — rather
 * than reporting it as a provider that broke.
 */
export const NOT_CONFIGURED = 'not_configured';

/**
 * 503 rather than 500: the route genuinely cannot serve, and it must be
 * distinguishable from 502 (upstream said no) and 500 (we have a bug). The
 * status alone is advisory — `code` is what the app actually branches on.
 */
export function missingSecret(secret: string): never {
  throw new HttpError(503, `Worker is missing ${secret}`, { code: NOT_CONFIGURED, secret });
}
