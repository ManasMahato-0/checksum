import type { RawTxn } from '../domain/types';

export interface ReconBreak {
  rowNumber: number;
  expectedPaise: number;
  actualPaise: number;
  /** actual - expected. Negative => money left that we have no row for (missing debit). */
  diffPaise: number;
}

export interface ReconResult {
  ok: boolean;
  openingPaise: number | null;
  closingPaise: number | null;
  totalDebitsPaise: number;
  totalCreditsPaise: number;
  breaks: ReconBreak[];
}

/**
 * Walk the running balance: prev + credit - debit must equal the bank's stated balance.
 * A mismatch means one or more transactions are missing between this row and the last.
 * After a break we resync to the bank's balance so one gap doesn't flag every later row.
 */
export function reconcile(txns: RawTxn[], openingPaise: number | null): ReconResult {
  let totalDebits = 0;
  let totalCredits = 0;
  const breaks: ReconBreak[] = [];
  let prev = openingPaise;

  for (const t of txns) {
    totalDebits += t.debitPaise;
    totalCredits += t.creditPaise;
    if (t.balancePaise === null) {
      prev = null;
      continue;
    }
    if (prev !== null) {
      const expected = prev + t.creditPaise - t.debitPaise;
      if (expected !== t.balancePaise) {
        breaks.push({
          rowNumber: t.rowNumber,
          expectedPaise: expected,
          actualPaise: t.balancePaise,
          diffPaise: t.balancePaise - expected,
        });
      }
    }
    prev = t.balancePaise;
  }

  const last = txns[txns.length - 1];
  return {
    ok: breaks.length === 0,
    openingPaise,
    closingPaise: last?.balancePaise ?? null,
    totalDebitsPaise: totalDebits,
    totalCreditsPaise: totalCredits,
    breaks,
  };
}
