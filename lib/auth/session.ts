/**
 * Session tokens — HMAC-SHA256 over an issued-at / expires-at pair, Web
 * Crypto only so the same code runs in the request interceptor (proxy.ts)
 * and in Node routes. No user data in the token: FitFlow has one shared
 * password, so a session just proves "knew the password, within the last
 * 30 days". Expiry slides: a token older than SLIDE_AFTER_SECONDS is
 * re-issued on the next authenticated request.
 */

export const SESSION_COOKIE = 'fitflow_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Re-issue the cookie once a token is this old, so an active user never expires. */
export const SLIDE_AFTER_SECONDS = 24 * 60 * 60;
const VERSION = 'v1';

const enc = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | null {
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time byte comparison (never returns early on the first mismatch). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface SessionClaims {
  iat: number;
  exp: number;
}

/** Mint a token: `v1.<iat>.<exp>.<sig>` (all seconds). */
export async function signSession(secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const iat = nowSeconds;
  const exp = nowSeconds + SESSION_TTL_SECONDS;
  const payload = `${VERSION}.${iat}.${exp}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${base64url(sig)}`;
}

export type SessionCheck = { ok: true; claims: SessionClaims; shouldRefresh: boolean } | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' };

/** Verify a token: shape, signature (constant time), expiry. */
export async function verifySession(token: string | null | undefined, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<SessionCheck> {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const iat = Number(parts[1]);
  const exp = Number(parts[2]);
  if (!Number.isInteger(iat) || !Number.isInteger(exp) || iat <= 0 || exp <= iat) return { ok: false, reason: 'malformed' };
  const given = fromBase64url(parts[3]);
  if (!given) return { ok: false, reason: 'malformed' };
  const expected = await hmac(secret, `${VERSION}.${iat}.${exp}`);
  if (!timingSafeEqualBytes(given, expected)) return { ok: false, reason: 'bad_signature' };
  if (exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { iat, exp }, shouldRefresh: nowSeconds - iat >= SLIDE_AFTER_SECONDS };
}

/** Cookie attributes shared by set and clear. */
export function sessionCookieOptions(secure: boolean, maxAgeSeconds: number = SESSION_TTL_SECONDS) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: maxAgeSeconds };
}
