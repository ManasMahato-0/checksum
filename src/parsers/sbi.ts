import { parse } from 'csv-parse/sync';
import { parseAmountToPaise } from '../domain/money';
import type { ParsedStatement, RawTxn, StatementParser } from '../domain/types';

/**
 * SBI (OnlineSBI) CSV layout, after a block of account-details lines:
 *   Txn Date, Value Date, Description, Ref No./Cheque No., Debit, Credit, Balance
 * The export is usually tab-delimited but is sometimes comma-delimited, dates look like
 * "1 Sep 2026", and balances can carry a CR/DR suffix.
 */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoOrThrow(y: number, m: number, d: number, original: string): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trip check rejects impossible dates such as 31 Feb instead of silently rolling over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`Invalid SBI date: "${original}"`);
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const fullYear = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/** Accepts "1 Sep 2026", "01-Sep-26", "01/09/2026", "01-09-26" (day first, as in India). */
export function parseSbiDate(input: string): string {
  const s = input.trim();
  const named = /^(\d{1,2})[ \-/]([A-Za-z]{3,9})[ \-/,]+(\d{2}|\d{4})$/.exec(s);
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
    if (!month) throw new Error(`Invalid SBI date: "${input}"`);
    return isoOrThrow(fullYear(named[3]!), month, Number(named[1]), input);
  }
  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(s);
  if (numeric) return isoOrThrow(fullYear(numeric[3]!), Number(numeric[2]), Number(numeric[1]), input);
  throw new Error(`Unrecognized SBI date: "${input}"`);
}

/** "12,345.67", "12,345.67 CR", or "500.00 DR" (overdrawn => negative). Blank => null. */
function parseBalance(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(.*?)\s*(CR|DR)?$/i.exec(t)!;
  const paise = parseAmountToPaise(m[1]!);
  return m[2]?.toUpperCase() === 'DR' ? -paise : paise;
}

function headerLine(content: string): string | undefined {
  return content.split(/\r?\n/).find((l) => /txn\s*date/i.test(l) && /debit/i.test(l) && /credit/i.test(l));
}

export const sbiParser: StatementParser = {
  bank: 'SBI',

  detect(content: string): boolean {
    const head = content.slice(0, 5000).toLowerCase();
    return /txn\s*date/.test(head) && head.includes('description') && head.includes('debit') &&
      head.includes('credit') && head.includes('balance');
  },

  parse(content: string): ParsedStatement {
    const header = headerLine(content);
    if (!header) throw new Error('SBI header row not found');
    const delimiter = header.includes('\t') ? '\t' : ',';

    const rows: string[][] = parse(content, {
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      bom: true,
    });
    const headerIdx = rows.findIndex((r) => /^txn\s*date$/i.test((r[0] ?? '').trim()));
    if (headerIdx === -1) throw new Error('SBI header row not found');

    const transactions: RawTxn[] = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i]!;
      const dateCell = (r[0] ?? '').trim();
      // Footers, totals and disclaimer lines have no date; skip them. A cell that has digits
      // but won't parse is a real data problem, so parseSbiDate is allowed to throw there.
      if (!dateCell || !/\d/.test(dateCell)) continue;

      const debit = parseAmountToPaise(r[4] ?? '');
      const credit = parseAmountToPaise(r[5] ?? '');
      if (debit > 0 && credit > 0) throw new Error(`Row ${i + 1}: both debit and credit set`);

      transactions.push({
        rowNumber: i + 1,
        date: parseSbiDate(dateCell),
        narration: (r[2] ?? '').replace(/\s+/g, ' ').trim(),
        refNo: (r[3] ?? '').trim() || null,
        debitPaise: debit,
        creditPaise: credit,
        balancePaise: parseBalance(r[6] ?? ''),
        raw: r,
      });
    }

    // Some exports are newest-first. Reconciliation walks the balance forward in time, so
    // put them in chronological order (rowNumber still points at the original line).
    const firstRow = transactions[0];
    const lastRow = transactions[transactions.length - 1];
    if (firstRow && lastRow && firstRow.date > lastRow.date) transactions.reverse();

    const first = transactions[0];
    const last = transactions[transactions.length - 1];
    const opening =
      first && first.balancePaise !== null
        ? first.balancePaise + first.debitPaise - first.creditPaise
        : null;

    return {
      bank: 'SBI',
      transactions,
      openingBalancePaise: opening,
      closingBalancePaise: last?.balancePaise ?? null,
    };
  },
};
