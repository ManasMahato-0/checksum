// All money arrives as integer paise. Convert only at the edge, for display.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrCompact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const money = (paise: number) => inr.format(paise / 100);
export const moneyWhole = (paise: number) => inrWhole.format(Math.round(paise / 100));
/** ₹1.2L / ₹45K: axis ticks and tight spaces. */
export const moneyCompact = (paise: number) => inrCompact.format(paise / 100);
export const signedMoney = (paise: number) => (paise > 0 ? '+' : paise < 0 ? '−' : '') + money(Math.abs(paise));

const monthLong = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthShort = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' });
const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const utc = (yyyyMm: string) => new Date(`${yyyyMm}-01T00:00:00Z`);
export const monthLabel = (yyyyMm: string) => monthLong.format(utc(yyyyMm));
export const monthTick = (yyyyMm: string) => monthShort.format(utc(yyyyMm));
export const dayLabel = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));
export const dateTimeLabel = (iso: string) => dateTime.format(new Date(iso));

export function previousMonth(yyyyMm: string): string {
  const d = utc(yyyyMm);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** Merchant keys are SHOUTY ("RAMESH TEA STALL"); show them in title case. */
export const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
