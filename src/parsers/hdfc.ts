import { parse } from 'csv-parse/sync';
import { parseAmountToPaise } from '../domain/money';
import type { ParsedStatement, RawTxn, StatementParser } from '../domain/types';

/**
 * HDFC CSV layout:
 * Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
 * Dates are dd/mm/yy.
 */
function toIsoDate(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`Unrecognized HDFC date: "${s}"`);
  const [, dd, mm, yy] = m;
  const year = Number(yy!.length === 2 ? `20${yy}` : yy);
  const dt = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  // Round-trip check rejects impossible dates such as 31/02 instead of letting Postgres choke later.
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== Number(mm) - 1 || dt.getUTCDate() !== Number(dd)) {
    throw new Error(`Invalid HDFC date: "${s}"`);
  }
  return `${year}-${mm}-${dd}`;
}

function findHeaderIndex(rows: string[][]): number {
  return rows.findIndex(
    (r) => (r[0] ?? '').trim().toLowerCase() === 'date' && (r[1] ?? '').toLowerCase().includes('narration'),
  );
}

export const hdfcParser: StatementParser = {
  bank: 'HDFC',

  detect(content: string): boolean {
    const head = content.slice(0, 2000).toLowerCase();
    return head.includes('narration') && head.includes('withdrawal amt') && head.includes('closing balance');
  },

  parse(content: string): ParsedStatement {
    const rows: string[][] = parse(content, {
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
    });
    const headerIdx = findHeaderIndex(rows);
    if (headerIdx === -1) throw new Error('HDFC header row not found');

    const transactions: RawTxn[] = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i]!;
      // skip footers / separator lines that don't start with a date
      if (!/^\d{2}\/\d{2}\/\d{2,4}$/.test((r[0] ?? '').trim())) continue;

      const debit = parseAmountToPaise(r[4] ?? '');
      const credit = parseAmountToPaise(r[5] ?? '');
      if (debit > 0 && credit > 0) throw new Error(`Row ${i + 1}: both debit and credit set`);

      const balanceRaw = (r[6] ?? '').trim();
      transactions.push({
        rowNumber: i + 1,
        date: toIsoDate(r[0]!),
        narration: (r[1] ?? '').trim(),
        refNo: (r[2] ?? '').trim() || null,
        debitPaise: debit,
        creditPaise: credit,
        balancePaise: balanceRaw ? parseAmountToPaise(balanceRaw) : null,
        raw: r,
      });
    }

    const first = transactions[0];
    const last = transactions[transactions.length - 1];
    const opening =
      first && first.balancePaise !== null
        ? first.balancePaise + first.debitPaise - first.creditPaise
        : null;

    return {
      bank: 'HDFC',
      transactions,
      openingBalancePaise: opening,
      closingBalancePaise: last?.balancePaise ?? null,
    };
  },
};
