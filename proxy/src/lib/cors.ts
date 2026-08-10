import type { Env } from '../types.ts';

/**
 * Native apps send no Origin header at all — CORS only matters for the Expo
 * web build and for anyone poking at this from a browser.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowOrigin =
    allowed.length === 0 || allowed.includes(origin) ? origin || '*' : 'null';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    Vary: 'Origin',
  };
}
