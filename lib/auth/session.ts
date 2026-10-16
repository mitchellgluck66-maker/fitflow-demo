/**
 * Session tokens — HMAC-SHA256 over the claims, Web Crypto only so the same
 * code runs in the request interceptor (proxy.ts) and in Node routes.
 *
 *   v2.<iat>.<exp>.<uid>.<role>.<sig>   per-person logins (Companion stage 1)
 *   v1.<iat>.<exp>.<sig>                the shared-password era — still verified, read as the env owner, so
 *                                       nobody is signed out by the switch; never minted again
 *
 * No secret and no data in the token: uid is an app_users id (or `env-owner` for the team password) and role is
 * `owner` | `onboarding`. The data layer re-checks `active` on every Companion / Users call (lib/auth/currentUser),
 * so disabling a user takes effect on their next request even though the token is still valid.
 * Expiry slides: a token older than SLIDE_AFTER_SECONDS is re-issued (same claims) on the next request.
 */

export const SESSION_COOKIE = 'fitflow_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Re-issue the cookie once a token is this old, so an active user never expires. */
export const SLIDE_AFTER_SECONDS = 24 * 60 * 60;
const V1 = 'v1';
const V2 = 'v2';

export type SessionRole = 'owner' | 'onboarding';
/** The uid of a session opened with the team password (APP_PASSWORD) — no app_users row behind it. */
export const ENV_OWNER_UID = 'env-owner';
export const ENV_OWNER: SessionIdentity = { uid: ENV_OWNER_UID, role: 'owner' };

export interface SessionIdentity {
  uid: string;
  role: SessionRole;
}

export interface SessionClaims extends SessionIdentity {
  iat: number;
  exp: number;
  /** v1 = a token from before per-person logins. */
  version: 'v1' | 'v2';
}

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

const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isSessionRole(v: unknown): v is SessionRole {
  return v === 'owner' || v === 'onboarding';
}

/** Mint a v2 token `v2.<iat>.<exp>.<uid>.<role>.<sig>` (all seconds). Defaults to the env owner. */
export async function signSession(secret: string, identity: SessionIdentity = ENV_OWNER, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!UID_RE.test(identity.uid)) throw new Error('session uid must be 1–64 url-safe characters');
  if (!isSessionRole(identity.role)) throw new Error(`unknown session role ${String(identity.role)}`);
  const iat = nowSeconds;
  const exp = nowSeconds + SESSION_TTL_SECONDS;
  const payload = `${V2}.${iat}.${exp}.${identity.uid}.${identity.role}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${base64url(sig)}`;
}

export type SessionCheck = { ok: true; claims: SessionClaims; shouldRefresh: boolean } | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' };

/** Verify a token: shape (v1 or v2), signature (constant time), expiry. */
export async function verifySession(token: string | null | undefined, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<SessionCheck> {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  let identity: SessionIdentity;
  let version: SessionClaims['version'];
  if (parts.length === 4 && parts[0] === V1) {
    identity = ENV_OWNER;
    version = 'v1';
  } else if (parts.length === 6 && parts[0] === V2) {
    if (!UID_RE.test(parts[3]) || !isSessionRole(parts[4])) return { ok: false, reason: 'malformed' };
    identity = { uid: parts[3], role: parts[4] };
    version = 'v2';
  } else {
    return { ok: false, reason: 'malformed' };
  }
  const iat = Number(parts[1]);
  const exp = Number(parts[2]);
  if (!Number.isInteger(iat) || !Number.isInteger(exp) || iat <= 0 || exp <= iat) return { ok: false, reason: 'malformed' };
  const given = fromBase64url(parts[parts.length - 1]);
  if (!given) return { ok: false, reason: 'malformed' };
  const payload = parts.slice(0, -1).join('.');
  const expected = await hmac(secret, payload);
  if (!timingSafeEqualBytes(given, expected)) return { ok: false, reason: 'bad_signature' };
  if (exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { iat, exp, version, ...identity }, shouldRefresh: nowSeconds - iat >= SLIDE_AFTER_SECONDS };
}

/** Cookie attributes shared by set and clear. */
export function sessionCookieOptions(secure: boolean, maxAgeSeconds: number = SESSION_TTL_SECONDS) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: maxAgeSeconds };
}
