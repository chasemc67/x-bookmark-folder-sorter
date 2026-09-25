import { timingSafeEqual } from 'node:crypto';

export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 500; error: string };

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; fail closed when the secret is unset. */
export function checkCronAuth(authorization: string | null, secret: string | undefined): CronAuthResult {
  if (!secret?.trim()) return { ok: false, status: 500, error: 'CRON_SECRET is not configured' };
  const expected = Buffer.from(`Bearer ${secret.trim()}`);
  const actual = Buffer.from(authorization ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}
