/**
 * Generates a SYNTHETIC bank statement so the repo never needs real bank data.
 *   npm run gen:statement -- --bank sbi --days 30 --seed 7 --drop 2 > statements/sample.csv
 * --bank hdfc|sbi   statement layout (default hdfc)
 * --drop N          removes N rows but keeps the bank's balances, so reconciliation has gaps to find
 * --reverse         (sbi) emit newest-first, like some exports
 */
const args = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const str = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1]) : fallback;
};

const bank = str('bank', 'hdfc').toLowerCase();
if (bank !== 'hdfc' && bank !== 'sbi') throw new Error('--bank must be hdfc or sbi');
const days = num('days', 30);
const drop = num('drop', 0);
let seed = num('seed', 1);
const rand = () => {
  // mulberry32: deterministic, so the same seed gives the same file
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;

const merchants = [
  ['SWIGGY', 'swiggy@axisbank', 150, 700],
  ['ZOMATO', 'zomato@icici', 150, 900],
  ['UBER INDIA', 'uber@hdfcbank', 120, 600],
  ['BIGBASKET', 'bigbasket@okicici', 400, 2500],
  ['AMAZON PAY', 'amazonpay@apl', 300, 4000],
  ['NETFLIX', 'netflix@ybl', 199, 649],
  ['AIRTEL', 'airtel@paytm', 299, 999],
  ['RAMESH TEA STALL', 'ramesh123@oksbi', 20, 120],
] as const;

interface Entry {
  date: Date;
  kind: 'salary' | 'upi';
  name: string;
  vpa: string;
  ref: string;
  debit: number;
  credit: number;
  balance: number;
}

let balance = 85_000_00;
const start = new Date(2026, 8, 1);
let entries: Entry[] = [];

for (let d = 0; d < days; d++) {
  const date = new Date(start.getTime() + d * 86_400_000);
  if (d === 0) {
    balance += 60_000_00;
    entries.push({ date, kind: 'salary', name: 'ACME CORP SALARY', vpa: '', ref: `N${100000000 + d}`, debit: 0, credit: 60_000_00, balance });
  }
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const [name, vpa, lo, hi] = pick([...merchants]);
    const amt = (lo + Math.floor(rand() * (hi - lo))) * 100;
    const ref = String(400000000000 + Math.floor(rand() * 99999999999));
    balance -= amt;
    entries.push({ date, kind: 'upi', name, vpa, ref, debit: amt, credit: 0, balance });
  }
}

for (let i = 0; i < drop && entries.length > 3; i++) {
  entries.splice(1 + Math.floor(rand() * (entries.length - 2)), 1);
}

const plain = (p: number) => (p / 100).toFixed(2);
const withCommas = (p: number) => {
  const [i, f] = plain(p).split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
};
const pad = (n: number) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

if (bank === 'hdfc') {
  const dd = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
  console.log('Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance');
  for (const e of entries) {
    const narration =
      e.kind === 'salary'
        ? `NEFT CR-HDFC0001234-${e.name}-${e.ref}`
        : `UPI-${e.name}-${e.vpa}-UTIB0000001-${e.ref}-Payment`;
    const debit = e.debit ? plain(e.debit) : '';
    const credit = e.credit ? plain(e.credit) : '';
    console.log(`${dd(e.date)},${narration},${e.ref},${dd(e.date)},${debit},${credit},${plain(e.balance)}`);
  }
} else {
  // SBI: account-details preamble, then a tab-delimited table with "1 Sep 2026" dates and comma amounts.
  const dd = (d: Date) => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
  const last = entries[entries.length - 1]!;
  console.log('Account Name  :\tMR SYNTHETIC USER');
  console.log('Address  :\t12 EXAMPLE ROAD, BENGALURU');
  console.log('Account Number  :\t00000012345678901');
  console.log('Branch  :\tEXAMPLE BRANCH');
  console.log(`Balance as on ${dd(last.date)}  :\t${withCommas(last.balance)}`);
  console.log(`Account Statement from ${dd(entries[0]!.date)} to ${dd(last.date)}`);
  console.log('');
  console.log('Txn Date\tValue Date\tDescription\tRef No./Cheque No.\tDebit\tCredit\tBalance');
  const out = entries.map((e) => {
    const desc =
      e.kind === 'salary'
        ? `BY TRANSFER-NEFT*HDFC0001234*${e.ref}*${e.name}--`
        : `TO TRANSFER-UPI/DR/${e.ref}/${e.name}/YESB/${e.vpa}/Payment-`;
    const refNo = e.kind === 'salary' ? e.ref : '';
    const debit = e.debit ? withCommas(e.debit) : ' ';
    const credit = e.credit ? withCommas(e.credit) : ' ';
    return `${dd(e.date)}\t${dd(e.date)}\t${desc}\t${refNo}\t${debit}\t${credit}\t${withCommas(e.balance)}`;
  });
  for (const line of args.includes('--reverse') ? out.reverse() : out) console.log(line);
  console.log('');
  console.log('**This is a computer generated statement and does not require a signature.');
}
