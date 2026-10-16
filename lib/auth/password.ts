/**
 * Password hashing for per-person logins (Companion stage 1) — scrypt from node:crypto, no new dependency.
 *
 * Stored form: `scrypt$N=16384,r=8,p=1$<salt b64url>$<hash b64url>` so the parameters travel with the hash and can
 * be raised later without a migration. Verification is constant time. Node runtime only (the login / users routes).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

const b64 = (b: Buffer) => b.toString('base64url');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { ...SCRYPT_PARAMS, maxmem: 64 * 1024 * 1024 });
  return `scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${b64(salt)}$${b64(hash)}`;
}

/** Constant-time check of `password` against a stored hash; a malformed hash is simply "no match". */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const params: Record<string, number> = {};
  for (const kv of parts[1].split(',')) {
    const [k, v] = kv.split('=');
    params[k] = Number(v);
  }
  const { N, r, p } = params;
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  if (salt.length < 8 || expected.length !== KEY_LENGTH) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, KEY_LENGTH, { N, r, p, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/** The one rule a new password must meet; the message is what the UI and the API show. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.trim() !== password) return 'A password cannot start or end with a space.';
  return null;
}
