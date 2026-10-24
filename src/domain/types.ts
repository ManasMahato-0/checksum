/** A row exactly as the bank gave it, minimally typed. Never mutated after parsing. */
export interface RawTxn {
  rowNumber: number;
  date: string; // ISO yyyy-mm-dd
  narration: string;
  refNo: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  raw: string[];
}

export interface ParsedStatement {
  bank: string;
  transactions: RawTxn[];
  /** Derived from the first row's balance when the file doesn't state it. */
  openingBalancePaise: number | null;
  closingBalancePaise: number | null;
}

export interface StatementParser {
  readonly bank: string;
  /** Cheap sniff of the file header so we can pick the right parser. */
  detect(content: string): boolean;
  parse(content: string): ParsedStatement;
}

export type Channel = 'UPI' | 'NEFT' | 'IMPS' | 'RTGS' | 'ATM' | 'POS' | 'ACH' | 'OTHER';

export interface NarrationInfo {
  channel: Channel;
  /** Human-ish merchant/counterparty as found in the narration. */
  merchantRaw: string | null;
  /** Normalized key used for categorization and overrides, e.g. "SWIGGY". */
  merchantKey: string | null;
  reference: string | null;
}

export type CategorySource = 'override' | 'rule' | 'none';

export interface CategoryResult {
  category: string;
  source: CategorySource;
  /** Why: which rule or override fired. Stored so every label is explainable. */
  reason: string | null;
}
