import { createHash } from 'node:crypto';
import type { RawTxn } from '../domain/types';
import { normalizeNarration } from '../normalize/narration';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Fingerprint = identity of a transaction across overlapping statement uploads.
 *
 * Including the balance-after is the key trick: two genuine ₹50 chai payments on the
 * same day have different running balances, so they stay distinct, while the same row
 * appearing in two overlapping statements reproduces the exact same balance.
 *
 * When a bank omits the balance, identical rows get an occurrence index so that
 * legit repeats inside ONE file are not collapsed.
 */
export function fingerprintAll(accountId: string, txns: RawTxn[]): string[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    const base = [
      accountId,
      t.date,
      t.debitPaise,
      t.creditPaise,
      t.balancePaise ?? '',
      t.refNo ?? '',
      normalizeNarration(t.narration),
    ].join('|');

    let key = base;
    if (t.balancePaise === null) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      key = `${base}|#${n}`;
    }
    return sha256(key);
  });
}
