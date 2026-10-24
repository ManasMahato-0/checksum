/** Money is handled as integer paise everywhere. Floats never touch it. */
export function parseAmountToPaise(input: string): number {
  const s = input.replace(/[₹,\s]/g, '');
  if (s === '') return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const negative = s.startsWith('-');
  const [intPart = '0', frac = ''] = s.replace('-', '').split('.');
  const paise = parseInt(intPart, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return negative ? -paise : paise;
}

export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const p = (abs % 100).toString().padStart(2, '0');
  return `${sign}₹${rupees}.${p}`;
}
