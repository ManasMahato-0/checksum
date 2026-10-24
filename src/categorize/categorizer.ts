import type { CategoryResult, NarrationInfo } from '../domain/types';

interface Rule {
  category: string;
  /** Matched against the normalized merchant key (substring). */
  keywords: string[];
}

export const DEFAULT_RULES: Rule[] = [
  { category: 'Food & Dining', keywords: ['SWIGGY', 'ZOMATO', 'DOMINOS', 'MCDONALD', 'STARBUCKS', 'CAFE'] },
  { category: 'Groceries', keywords: ['BIGBASKET', 'BLINKIT', 'ZEPTO', 'DMART', 'GROFERS', 'INSTAMART'] },
  { category: 'Transport', keywords: ['UBER', 'OLA', 'RAPIDO', 'IRCTC', 'REDBUS', 'FASTAG'] },
  { category: 'Shopping', keywords: ['AMAZON', 'FLIPKART', 'MYNTRA', 'AJIO', 'MEESHO'] },
  { category: 'Bills & Utilities', keywords: ['AIRTEL', 'JIO', 'VODAFONE', 'BESCOM', 'ELECTRICITY', 'BSNL'] },
  { category: 'Entertainment', keywords: ['NETFLIX', 'SPOTIFY', 'HOTSTAR', 'BOOKMYSHOW', 'PRIME VIDEO'] },
  { category: 'Cash', keywords: ['ATM CASH WITHDRAWAL'] },
  { category: 'Interest', keywords: ['CREDIT INTEREST', 'INT PD', 'INTEREST PAID'] },
  { category: 'Bank Charges', keywords: ['ATMCARD AMC', 'SMS CHARGES', 'DEBIT CARD ANNUAL'] },
  { category: 'Salary', keywords: ['SALARY', 'PAYROLL'] },
];

/**
 * Priority: user override > rule > uncategorized.
 * The result always carries `reason`, so every label can be explained in the UI.
 */
export function categorize(
  info: NarrationInfo,
  overrides: ReadonlyMap<string, string> = new Map(),
  rules: Rule[] = DEFAULT_RULES,
): CategoryResult {
  const key = info.merchantKey;
  if (!key) return { category: 'Uncategorized', source: 'none', reason: null };

  const override = overrides.get(key);
  if (override) {
    return { category: override, source: 'override', reason: `user override for ${key}` };
  }

  for (const rule of rules) {
    const hit = rule.keywords.find((k) => key.includes(k));
    if (hit) {
      return { category: rule.category, source: 'rule', reason: `merchant matched "${hit}"` };
    }
  }
  return { category: 'Uncategorized', source: 'none', reason: null };
}
