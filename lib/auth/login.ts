/**
 * Login checks — Node runtime only (the login route). Constant-time password
 * comparison over SHA-256 digests (so lengths never leak), and a small
 * in-memory rate limit of 5 attempts per minute per IP. The limiter is per
 * warm instance — enough to stop a runaway client; the real defence is the
 * password's strength.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export function passwordMatches(input: string, expected: string): boolean {
  const a = createHash('sha256').update(input, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export const LOGIN_RATE_LIMIT = 5;
export const LOGIN_RATE_WINDOW_MS = 60_000;

const attempts = new Map<string, number[]>();

export function checkLoginRateLimit(ip: string, now: number = Date.now()): { ok: boolean; retryAfterSec: number } {
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  if (list.length >= LOGIN_RATE_LIMIT) {
    attempts.set(ip, list);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((LOGIN_RATE_WINDOW_MS - (now - list[0])) / 1000)) };
  }
  list.push(now);
  attempts.set(ip, list);
  return { ok: true, retryAfterSec: 0 };
}

export function resetLoginRateLimit(): void {
  attempts.clear();
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return headers.get('x-real-ip') ?? 'unknown';
}
