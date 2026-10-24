import type { Channel, NarrationInfo } from '../domain/types';

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const LONG_DIGITS = /^\d{9,}$/;
/** Alphanumeric bank reference such as N123456789 or UTIBN12345678 (IFSC codes are excluded separately). */
const REF_TOKEN = /^[A-Z]{1,6}\d{6,}$/;

/** SBI wraps most descriptions: "TO TRANSFER-UPI/DR/...", "BY TRANSFER-NEFT*...". */
const BANK_PREFIX = /^(?:TO|BY)\s+(?:TRANSFER|CLEARING)\s*-\s*/i;
/** Internet / mobile banking tag in front of the channel: "INB IMPS/P2A/...". */
const ORIGIN_TAG = /^(?:INB|MOB)\s+/i;

export function toMerchantKey(s: string): string | null {
  const key = s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return key || null;
}

/** Remove bank-specific wrapping and trailing "--" / "*" padding so the channel is at the front. */
function clean(narration: string): string {
  return narration
    .trim()
    .replace(BANK_PREFIX, '')
    .replace(ORIGIN_TAG, '')
    .replace(/[-*\s]+$/, '')
    .trim();
}

function detectChannel(n: string): Channel {
  const u = n.toUpperCase();
  if (u.startsWith('UPI')) return 'UPI';
  if (u.startsWith('NEFT')) return 'NEFT';
  if (u.startsWith('IMPS')) return 'IMPS';
  if (u.startsWith('RTGS')) return 'RTGS';
  if (u.startsWith('ATW') || u.startsWith('NWD') || u.startsWith('ATM') || u.startsWith('EAW')) return 'ATM';
  if (u.startsWith('POS') || u.startsWith('PUR')) return 'POS';
  if (u.startsWith('ACH') || u.startsWith('NACH') || u.startsWith('ECS')) return 'ACH';
  return 'OTHER';
}

/** "/" separates SBI UPI/IMPS narrations, "*" separates SBI NEFT, "-" is HDFC's separator. */
function segments(n: string): string[] {
  const sep = n.includes('/') ? '/' : n.includes('*') ? '*' : '-';
  return n.split(sep).map((s) => s.trim()).filter(Boolean);
}

const isIfsc = (s: string) => IFSC.test(s.toUpperCase());
const isReference = (s: string) => LONG_DIGITS.test(s) || (REF_TOKEN.test(s.toUpperCase()) && !isIfsc(s));

function isNoise(seg: string): boolean {
  return (
    isReference(seg) ||
    seg.includes('@') ||
    isIfsc(seg) ||
    /^P2[AMP]$/i.test(seg) || // IMPS flavour: P2A / P2P / P2M
    /^(UPI|NEFT|IMPS|RTGS|CR|DR|PAYMENT|PAYMENT FROM PHONE|PAID VIA.*)$/i.test(seg)
  );
}

/**
 * Pull channel, counterparty and reference out of messy Indian bank narrations, e.g.
 *   HDFC: UPI-SWIGGY-swiggy@axisbank-UTIB0000001-412345678901-Payment for order
 *   HDFC: NEFT CR-HDFC0001234-ACME CORP-N123456789
 *   SBI:  TO TRANSFER-UPI/DR/412345678901/SWIGGY/YESB/swiggy@yes/Payment-
 *   SBI:  BY TRANSFER-NEFT*HDFC0001234*N123456789*ACME CORP--
 *   SBI:  TO TRANSFER-INB IMPS/P2A/412345678901/RAMESH
 *   POS 4012XXXXXXXX1234 AMAZON PAY INDIA
 */
export function parseNarration(narration: string): NarrationInfo {
  const n = clean(narration);
  const channel = detectChannel(n);
  let merchantRaw: string | null = null;
  let reference: string | null = null;

  if (channel === 'UPI' || channel === 'IMPS' || channel === 'NEFT' || channel === 'RTGS') {
    const segs = segments(n);
    reference = segs.find(isReference) ?? null;
    // First segment is the channel prefix itself; skip it.
    merchantRaw = segs.slice(1).find((s) => !isNoise(s)) ?? null;
    if (channel === 'NEFT' && !reference) {
      reference = segs[segs.length - 1] ?? null;
    }
  } else if (channel === 'POS') {
    const m = /^(?:POS|PUR)\s+\S*\d{4}\S*\s+(.+)$/i.exec(n);
    merchantRaw = (m?.[1] ?? n.replace(/^(POS|PUR)\s+/i, '')).trim() || null;
  } else if (channel === 'ATM') {
    merchantRaw = 'ATM CASH WITHDRAWAL';
  } else if (channel === 'ACH') {
    merchantRaw = segments(n).slice(1).find((s) => !isNoise(s)) ?? null;
  } else {
    merchantRaw = n || null;
  }

  return {
    channel,
    merchantRaw,
    merchantKey: merchantRaw ? toMerchantKey(merchantRaw) : null,
    reference,
  };
}

/** Stable form of a narration for fingerprinting: case, spacing and punctuation can't change identity. */
export function normalizeNarration(n: string): string {
  return n.toUpperCase().replace(/\s+/g, ' ').trim();
}
