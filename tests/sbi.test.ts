import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { categorize } from '../src/categorize/categorizer';
import { InMemoryRepository } from '../src/import/repository';
import { parseNarration } from '../src/normalize/narration';
import { hdfcParser } from '../src/parsers/hdfc';
import { detectParser } from '../src/parsers/registry';
import { parseSbiDate, sbiParser } from '../src/parsers/sbi';
import { csv, L, makeHarness } from './helpers/harness';

const PREAMBLE = [
  'Account Name  :\tMR SYNTHETIC USER',
  'Account Number  :\t00000012345678901',
  'Balance as on 4 Sep 2026  :\t1,44,150.00',
  '',
].join('\n');
const HEAD = 'Txn Date\tValue Date\tDescription\tRef No./Cheque No.\tDebit\tCredit\tBalance';
const row = (...c: string[]) => c.join('\t');

const sbi = (...rows: string[]) => [PREAMBLE, HEAD, ...rows].join('\n');
const SALARY = row('1 Sep 2026', '1 Sep 2026', 'BY TRANSFER-NEFT*HDFC0001234*N100000000*ACME CORP SALARY--', 'N100000000', ' ', '60,000.00', '1,45,000.00');
const SWIGGY = row('2 Sep 2026', '2 Sep 2026', 'TO TRANSFER-UPI/DR/412345678901/SWIGGY/YESB/swiggy@yes/Payment-', '', '500.00', ' ', '1,44,500.00');
const CHAI = row('3 Sep 2026', '3 Sep 2026', 'TO TRANSFER-UPI/DR/412345678902/RAMESH TEA STALL/SBIN/ramesh@sbi/chai-', '', '50.00', ' ', '1,44,450.00');

describe('SBI dates', () => {
  it('parses the common SBI shapes', () => {
    expect(parseSbiDate('1 Sep 2026')).toBe('2026-09-01');
    expect(parseSbiDate('01-Sep-26')).toBe('2026-09-01');
    expect(parseSbiDate('31/12/2026')).toBe('2026-12-31');
    expect(parseSbiDate('05-03-26')).toBe('2026-03-05'); // day first
    expect(parseSbiDate('15 September 2026')).toBe('2026-09-15');
  });
  it('rejects impossible and unknown dates instead of rolling over', () => {
    expect(() => parseSbiDate('31 Feb 2026')).toThrow();
    expect(() => parseSbiDate('1 Foo 2026')).toThrow();
    expect(() => parseSbiDate('yesterday')).toThrow();
  });
});

describe('SBI parser', () => {
  it('skips the preamble and parses tab-delimited rows with comma amounts', () => {
    const p = sbiParser.parse(sbi(SALARY, SWIGGY, CHAI));
    expect(p.bank).toBe('SBI');
    expect(p.transactions).toHaveLength(3);
    expect(p.transactions[0]).toMatchObject({
      date: '2026-09-01', creditPaise: 6_000_000, debitPaise: 0, balancePaise: 14_500_000, refNo: 'N100000000',
    });
    expect(p.transactions[1]).toMatchObject({ date: '2026-09-02', debitPaise: 50_000, balancePaise: 14_450_000 });
    expect(p.openingBalancePaise).toBe(8_500_000);
    expect(p.closingBalancePaise).toBe(14_445_000);
  });

  it('handles comma-delimited exports with quoted amounts', () => {
    const body = [
      'Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance',
      '2 Sep 2026,2 Sep 2026,"TO TRANSFER-UPI/DR/412345678901/SWIGGY/YESB/swiggy@yes/Payment-",,"1,500.00",,"98,500.00"',
    ].join('\n');
    const p = sbiParser.parse(body);
    expect(p.transactions[0]).toMatchObject({ debitPaise: 150_000, balancePaise: 9_850_000 });
    expect(p.openingBalancePaise).toBe(10_000_000);
  });

  it('understands CR/DR suffixes on balances (DR = overdrawn)', () => {
    const body = sbi(
      row('2 Sep 2026', '2 Sep 2026', 'TO TRANSFER-UPI/DR/412345678901/X/YESB/x@y/p-', '', '500.00', ' ', '100.00 DR'),
      row('3 Sep 2026', '3 Sep 2026', 'BY TRANSFER-UPI/CR/412345678902/Y/YESB/y@z/p-', '', ' ', '300.00', '200.00 CR'),
    );
    const p = sbiParser.parse(body);
    expect(p.transactions[0]!.balancePaise).toBe(-10_000);
    expect(p.transactions[1]!.balancePaise).toBe(20_000);
  });

  it('puts newest-first exports into chronological order so reconciliation still works', () => {
    const p = sbiParser.parse(sbi(CHAI, SWIGGY, SALARY));
    expect(p.transactions.map((t) => t.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(p.openingBalancePaise).toBe(8_500_000);
  });

  it('ignores footer lines but fails loudly on a corrupt date in a data row', () => {
    expect(sbiParser.parse(sbi(SALARY, '**This is a computer generated statement.')).transactions).toHaveLength(1);
    expect(() => sbiParser.parse(sbi(row('31 Feb 2026', '', 'x', '', '1.00', '', '9.00')))).toThrow(/Invalid SBI date/);
  });

  it('rejects a row with both debit and credit', () => {
    expect(() => sbiParser.parse(sbi(row('1 Sep 2026', '', 'x', '', '5.00', '5.00', '9.00')))).toThrow(/both debit and credit/);
  });
});

describe('format detection', () => {
  it('routes each bank to its own parser', () => {
    expect(detectParser(sbi(SALARY))?.bank).toBe('SBI');
    expect(detectParser(csv(L.salary).toString())?.bank).toBe('HDFC');
    expect(detectParser('a,b,c\n1,2,3')).toBeNull();
  });
  it('the parsers do not claim each other\'s files', () => {
    expect(hdfcParser.detect(sbi(SALARY))).toBe(false);
    expect(sbiParser.detect(csv(L.salary).toString())).toBe(false);
  });
});

describe('SBI narrations', () => {
  it('UPI debit', () => {
    expect(parseNarration('TO TRANSFER-UPI/DR/412345678901/SWIGGY/YESB/swiggy@yes/Payment-')).toMatchObject({
      channel: 'UPI', merchantKey: 'SWIGGY', reference: '412345678901',
    });
  });
  it('UPI credit from a person', () => {
    expect(parseNarration('BY TRANSFER-UPI/CR/412345678901/RAMESH KUMAR/SBIN/ramesh@sbi/Payment-')).toMatchObject({
      channel: 'UPI', merchantKey: 'RAMESH KUMAR', reference: '412345678901',
    });
  });
  it('NEFT with star separators and alphanumeric reference', () => {
    expect(parseNarration('BY TRANSFER-NEFT*HDFC0001234*N123456789*ACME CORP LTD--')).toMatchObject({
      channel: 'NEFT', merchantKey: 'ACME CORP LTD', reference: 'N123456789',
    });
  });
  it('IMPS through internet banking', () => {
    expect(parseNarration('TO TRANSFER-INB IMPS/P2A/412345678901/PRIYA SHARMA')).toMatchObject({
      channel: 'IMPS', merchantKey: 'PRIYA SHARMA', reference: '412345678901',
    });
  });
  it('ATM withdrawal and other descriptions', () => {
    expect(parseNarration('ATM WDL-ATM CASH 12345 MG ROAD BANGALORE').channel).toBe('ATM');
    expect(parseNarration('CREDIT INTEREST--')).toMatchObject({ channel: 'OTHER', merchantKey: 'CREDIT INTEREST' });
  });
  it('categorizes interest and bank charges', () => {
    expect(categorize(parseNarration('CREDIT INTEREST--')).category).toBe('Interest');
    expect(categorize(parseNarration('DEBIT-ATMCard AMC 12345')).category).toBe('Bank Charges');
  });
});

describe('SBI end to end', () => {
  it('imports, categorizes and reconciles an SBI statement', async () => {
    const h = await makeHarness(new InMemoryRepository());
    const { post, status } = await h.uploadAndWait(Buffer.from(sbi(SALARY, SWIGGY, CHAI)), 'sbi.csv');
    expect(post.status).toBe(202);
    expect(status).toMatchObject({ status: 'done', bank: 'SBI', rowsInserted: 3 });
    expect(status.reconciliation.ok).toBe(true);
    const txns = (await h.repo.listTransactions('1')).map((t) => [t.merchantKey, t.category.category]);
    expect(txns).toContainEqual(['SWIGGY', 'Food & Dining']);
  });

  it('flags a missing SBI transaction', async () => {
    const h = await makeHarness(new InMemoryRepository());
    const { status } = await h.uploadAndWait(Buffer.from(sbi(SALARY, CHAI)), 'gap.csv'); // swiggy missing
    expect(status.reconciliation.ok).toBe(false);
    expect(status.reconciliation.breaks[0]).toMatchObject({ diffPaise: -50_000 });
  });

  it('an account can hold statements from different banks without interference', async () => {
    const h = await makeHarness(new InMemoryRepository());
    const a = await h.uploadAndWait(csv(L.salary, L.swiggy), 'hdfc.csv');
    const b = await h.uploadAndWait(Buffer.from(sbi(SALARY, SWIGGY)), 'sbi.csv');
    expect(a.status.bank).toBe('HDFC');
    expect(b.status.bank).toBe('SBI');
    // different banks => different narration text => rows are not wrongly merged
    expect(b.status.rowsInserted).toBe(2);
  });
});

describe('synthetic SBI generator', () => {
  const script = path.join(__dirname, '../scripts/generate-statement.ts');
  const gen = (...a: string[]) =>
    execFileSync(process.execPath, ['--import', 'tsx', script, '--bank', 'sbi', '--seed', '5', ...a], { encoding: 'utf8' });

  it('clean statement reconciles; --drop creates gaps; --reverse still reconciles', async () => {
    const h = await makeHarness(new InMemoryRepository());
    expect((await h.uploadAndWait(Buffer.from(gen()), 'clean.csv')).status.reconciliation.ok).toBe(true);
    const gappy = await h.uploadAndWait(Buffer.from(gen('--drop', '2')), 'gappy.csv');
    expect(gappy.status.reconciliation.breaks.length).toBeGreaterThan(0);

    const h2 = await makeHarness(new InMemoryRepository());
    const rev = await h2.uploadAndWait(Buffer.from(gen('--reverse')), 'rev.csv');
    expect(rev.status).toMatchObject({ status: 'done', bank: 'SBI' });
    expect(rev.status.reconciliation.ok).toBe(true);
  });

  it('most merchants resolve to a real category (parser + categorizer work together)', async () => {
    const h = await makeHarness(new InMemoryRepository());
    await h.uploadAndWait(Buffer.from(gen('--days', '60')), 'big.csv');
    const txns = await h.repo.listTransactions('1');
    const uncategorized = txns.filter((t) => t.category.category === 'Uncategorized');
    // RAMESH TEA STALL is intentionally not in the rules; everything else should be labelled
    expect(uncategorized.every((t) => t.merchantKey === 'RAMESH TEA STALL')).toBe(true);
  });
});
