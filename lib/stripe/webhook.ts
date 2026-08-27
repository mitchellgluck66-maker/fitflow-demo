/**
 * Stripe webhook signature verification — pure, no SDK.
 * Header: `t=<unix>,v1=<hex>[,v1=<hex>]`; signed payload = `${t}.${rawBody}`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureCheck {
  ok: boolean;
  reason?: 'missing_header' | 'malformed' | 'expired' | 'mismatch';
  timestamp?: number;
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  now: number = Math.floor(Date.now() / 1000),
): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing_header' };

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't' && v) timestamp = Number(v);
    if (k === 'v1' && v) signatures.push(v);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.abs(now - timestamp) > toleranceSec) return { ok: false, reason: 'expired', timestamp };

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const match = signatures.some((sig) => {
    const buf = Buffer.from(sig, 'hex');
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
  return match ? { ok: true, timestamp } : { ok: false, reason: 'mismatch', timestamp };
}

/** Build a header for tests / local simulation. */
export function signStripePayload(rawBody: string, secret: string, timestamp: number): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
