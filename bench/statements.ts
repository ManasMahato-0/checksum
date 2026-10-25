/**
 * Deterministic synthetic HDFC statements of an exact row count, for benchmarks.
 * Monthly salary credits keep the balance realistic over long statements.
 */
export interface Row {
  date: Date;
  narration: string;
  ref: string;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
}

const MERCHANTS = [
  ['SWIGGY', 'swiggy@axisbank', 150, 700],
  ['ZOMATO', 'zomato@icici', 150, 900],
  ['UBER INDIA', 'uber@hdfcbank', 80, 600],
  ['BIGBASKET', 'bigbasket@okicici', 300, 2500],
  ['AMAZON PAY', 'amazonpay@apl', 200, 3000],
  ['AIRTEL', 'airtel@paytm', 299, 999],
  ['DMART', 'dmart@ybl', 200, 2000],
  ['RAMESH TEA STALL', 'ramesh123@oksbi', 20, 120],
] as const;

const ROWS_PER_DAY = 6;

export function rng(seed: number) {
  let s = seed | 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(count: number, seed: number): Row[] {
  const rand = rng(seed);
  const start = Date.UTC(2015, 0, 1) + Math.floor(rand() * 1000) * 86_400_000;
  let balance = 2_00_000_00;
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const day = Math.floor(i / ROWS_PER_DAY);
    const date = new Date(start + day * 86_400_000);
    const ref = String(400000000000 + Math.floor(rand() * 99_999_999_999));
    if (i % (ROWS_PER_DAY * 30) === 0) {
      balance += 1_00_000_00;
      rows.push({ date, narration: `NEFT CR-HDFC0001234-ACME CORP SALARY-N${ref.slice(3)}`, ref, debitPaise: 0, creditPaise: 1_00_000_00, balancePaise: balance });
      continue;
    }
    const [name, vpa, lo, hi] = MERCHANTS[Math.floor(rand() * MERCHANTS.length)]!;
    const amount = (lo + Math.floor(rand() * (hi - lo))) * 100 + Math.floor(rand() * 100);
    balance -= amount;
    rows.push({ date, narration: `UPI-${name}-${vpa}-UTIB0000001-${ref}-Payment`, ref, debitPaise: amount, creditPaise: 0, balancePaise: balance });
  }
  return rows;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dd = (d: Date) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}`;
const amt = (p: number) => (p / 100).toFixed(2);

export function toCsv(rows: Row[]): Buffer {
  const lines = ['Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance'];
  for (const r of rows) {
    lines.push(
      `${dd(r.date)},${r.narration},${r.ref},${dd(r.date)},${r.debitPaise ? amt(r.debitPaise) : ''},${r.creditPaise ? amt(r.creditPaise) : ''},${amt(r.balancePaise)}`,
    );
  }
  return Buffer.from(lines.join('\n'));
}
