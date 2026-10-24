// Plain data shapes shared by the API and the web frontend. No runtime code, no Node types.
import type { CategoryResult, Channel, RawTxn } from '../domain/types';
import type { ReconResult } from '../reconcile/reconcile';

export interface StoredTxn {
  accountId: string;
  importId: string;
  fingerprint: string;
  date: string;
  narration: string;
  channel: Channel;
  merchantKey: string | null;
  referenceNo: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  category: CategoryResult;
}

/** A transaction about to be saved; `raw` is kept as immutable audit data. */
export type NewTxn = Omit<StoredTxn, 'importId'> & { raw: RawTxn };

export type ImportStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface ImportRecord {
  id: string;
  accountId: string;
  filename: string;
  bank: string | null;
  status: ImportStatus;
  attempts: number;
  error: string | null;
  rowsTotal: number;
  rowsInserted: number;
  rowsDuplicate: number;
  /** ISO timestamps. */
  createdAt: string;
  completedAt: string | null;
  /** Present once the import is done. */
  reconciliation: ReconResult | null;
}

/** One row of the import history: the record without the per-row break details. */
export type ImportListItem = Omit<ImportRecord, 'reconciliation'> & {
  /** null until the import is done. */
  reconciliationOk: boolean | null;
  breakCount: number;
};
