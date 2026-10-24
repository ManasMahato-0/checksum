import { describe, expect, it } from 'vitest';
import { categorize } from '../src/categorize/categorizer';
import { formatPaise, parseAmountToPaise } from '../src/domain/money';
import { parseNarration } from '../src/normalize/narration';
import { reconcile } from '../src/reconcile/reconcile';
import type { RawTxn } from '../src/domain/types';

describe('money', () => {
  it('parses to integer paise without float error', () => {
    expect(parseAmountToPaise('1,234.50')).toBe(123450);
    expect(parseAmountToPaise('0.1')).toBe(10);
    expect(parseAmountToPaise('19.99')).toBe(1999);
    expect(parseAmountToPaise('')).toBe(0);
    expect(parseAmountToPaise('₹ 500')).toBe(50000);
  });
  it('rejects garbage', () => {
    expect(() => parseAmountToPaise('12.345')).toThrow();
    expect(() => parseAmountToPaise('abc')).toThrow();
  });
  it('formats', () => expect(formatPaise(123405)).toBe('₹1234.05'));
});

describe('narration parsing', () => {
  it('HDFC UPI style', () => {
    const r = parseNarration('UPI-SWIGGY-swiggy@axisbank-UTIB0000001-412345678901-Payment for order');
    expect(r).toMatchObject({ channel: 'UPI', merchantKey: 'SWIGGY', reference: '412345678901' });
  });
  it('SBI UPI style', () => {
    const r = parseNarration('UPI/412345678901/ZOMATO/okaxis');
    expect(r).toMatchObject({ channel: 'UPI', merchantKey: 'ZOMATO', reference: '412345678901' });
  });
  it('NEFT', () => {
    const r = parseNarration('NEFT CR-HDFC0001234-ACME CORP SALARY-N123456789');
    expect(r.channel).toBe('NEFT');
    expect(r.merchantKey).toBe('ACME CORP SALARY');
  });
  it('POS and ATM', () => {
    expect(parseNarration('POS 4012XXXXXXXX1234 AMAZON PAY INDIA').merchantKey).toBe('AMAZON PAY INDIA');
    expect(parseNarration('ATW-512345XXXXXX1234-MG ROAD').channel).toBe('ATM');
  });
});

describe('categorizer', () => {
  const info = parseNarration('UPI-SWIGGY-swiggy@axisbank-UTIB0000001-412345678901-x');
  it('uses rules and explains why', () => {
    const c = categorize(info);
    expect(c).toMatchObject({ category: 'Food & Dining', source: 'rule' });
    expect(c.reason).toContain('SWIGGY');
  });
  it('override beats rule', () => {
    const c = categorize(info, new Map([['SWIGGY', 'Work Lunch']]));
    expect(c).toMatchObject({ category: 'Work Lunch', source: 'override' });
  });
  it('falls back to Uncategorized', () => {
    const c = categorize(parseNarration('UPI-RANDOM GUY-x@ybl-UTIB0000001-412345678901-x'));
    expect(c.category).toBe('Uncategorized');
  });
});

const row = (n: number, debit: number, credit: number, bal: number): RawTxn => ({
  rowNumber: n, date: '2026-09-01', narration: 'x', refNo: null,
  debitPaise: debit, creditPaise: credit, balancePaise: bal, raw: [],
});

describe('reconciliation', () => {
  it('passes on a consistent statement', () => {
    const r = reconcile([row(2, 100, 0, 900), row(3, 0, 500, 1400)], 1000);
    expect(r.ok).toBe(true);
    expect(r.totalDebitsPaise).toBe(100);
  });
  it('detects a missing transaction and resyncs afterwards', () => {
    // a 300-paise debit is missing between row 2 and row 3
    const r = reconcile([row(2, 100, 0, 900), row(3, 50, 0, 550), row(4, 50, 0, 500)], 1000);
    expect(r.ok).toBe(false);
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]).toMatchObject({ rowNumber: 3, diffPaise: -300 });
  });
});
