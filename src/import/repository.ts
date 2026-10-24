import type { CategoryResult } from '../domain/types';
import type { ReconBreak, ReconResult } from '../reconcile/reconcile';
import type { ImportListItem, ImportRecord, NewTxn, StoredTxn } from './records';

export type { ImportListItem, ImportRecord, ImportStatus, NewTxn, StoredTxn } from './records';

export interface CompleteImportInput {
  importId: string;
  bank: string;
  txns: NewTxn[];
  reconciliation: ReconResult;
}

export interface Repository {
  /**
   * Stage an upload (status 'queued'). Idempotency is enforced by the store: the same file
   * for the same account returns { duplicate: true } with the ORIGINAL import's id.
   */
  createPendingImport(input: {
    accountId: string;
    fileHash: string;
    filename: string;
    content: Buffer;
  }): Promise<{ duplicate: boolean; importId: string }>;

  getImport(accountId: string, importId: string): Promise<ImportRecord | null>;

  /** Newest first. */
  listImports(accountId: string, limit: number): Promise<ImportListItem[]>;

  /**
   * Worker picks up an import: bumps attempts and returns the staged bytes.
   * Returns null when the import is already done/failed, which makes queue redelivery harmless.
   */
  claimImport(importId: string): Promise<{ accountId: string; filename: string; content: Buffer } | null>;

  /**
   * Atomically stores raw rows, new transactions and reconciliation breaks and marks the import done.
   * Row-level dedupe (same fingerprint already stored) is enforced by the store.
   * Returns null if the import was not in 'processing' (e.g. a stalled job finishing twice).
   */
  completeImport(input: CompleteImportInput): Promise<{ rowsInserted: number; rowsDuplicate: number } | null>;

  failImport(importId: string, error: string): Promise<void>;

  /** Imports still queued/processing that were created more than `olderThanMs` ago (sweeper input). */
  listStaleImports(olderThanMs: number): Promise<{ id: string; accountId: string }[]>;

  getOverrides(accountId: string): Promise<Map<string, string>>;
  setOverride(accountId: string, merchantKey: string, category: string): Promise<void>;
  listTransactions(accountId: string): Promise<StoredTxn[]>;
  /** Re-label stored transactions after an override changes. Returns how many changed. */
  recategorize(accountId: string, merchantKey: string, category: CategoryResult): Promise<number>;
}

interface MemImport extends ImportRecord {
  fileHash: string;
  content: Buffer | null;
  createdMs: number;
}

export class InMemoryRepository implements Repository {
  private imports: MemImport[] = [];
  private txns: StoredTxn[] = [];
  private overrides = new Map<string, Map<string, string>>();
  private seq = 0;

  // No awaits inside the methods below, so each check-and-write is atomic on the single JS thread.

  async createPendingImport(input: { accountId: string; fileHash: string; filename: string; content: Buffer }) {
    const prior = this.imports.find((i) => i.accountId === input.accountId && i.fileHash === input.fileHash);
    if (prior) return { duplicate: true, importId: prior.id };
    const id = String(++this.seq);
    this.imports.push({
      id,
      accountId: input.accountId,
      fileHash: input.fileHash,
      filename: input.filename,
      bank: null,
      status: 'queued',
      attempts: 0,
      error: null,
      rowsTotal: 0,
      rowsInserted: 0,
      rowsDuplicate: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      reconciliation: null,
      content: input.content,
      createdMs: Date.now(),
    });
    return { duplicate: false, importId: id };
  }

  async getImport(accountId: string, importId: string) {
    const i = this.imports.find((x) => x.id === importId && x.accountId === accountId);
    if (!i) return null;
    const { fileHash: _h, content: _c, createdMs: _t, ...rec } = i;
    return { ...rec };
  }

  async listImports(accountId: string, limit: number) {
    return this.imports
      .filter((i) => i.accountId === accountId)
      .reverse()
      .slice(0, limit)
      .map(({ fileHash: _h, content: _c, createdMs: _t, reconciliation, ...rec }) => ({
        ...rec,
        reconciliationOk: reconciliation?.ok ?? null,
        breakCount: reconciliation?.breaks.length ?? 0,
      }));
  }

  async claimImport(importId: string) {
    const i = this.imports.find((x) => x.id === importId);
    if (!i || (i.status !== 'queued' && i.status !== 'processing') || !i.content) return null;
    i.status = 'processing';
    i.attempts++;
    return { accountId: i.accountId, filename: i.filename, content: i.content };
  }

  async completeImport(input: CompleteImportInput) {
    const i = this.imports.find((x) => x.id === input.importId);
    if (!i || i.status !== 'processing') return null;
    const known = new Set(this.txns.filter((t) => t.accountId === i.accountId).map((t) => t.fingerprint));
    let inserted = 0;
    for (const { raw: _raw, ...t } of input.txns) {
      if (known.has(t.fingerprint)) continue;
      known.add(t.fingerprint);
      this.txns.push({ ...t, importId: i.id });
      inserted++;
    }
    i.status = 'done';
    i.bank = input.bank;
    i.rowsTotal = input.txns.length;
    i.rowsInserted = inserted;
    i.rowsDuplicate = input.txns.length - inserted;
    i.reconciliation = input.reconciliation;
    i.completedAt = new Date().toISOString();
    i.content = null;
    return { rowsInserted: inserted, rowsDuplicate: input.txns.length - inserted };
  }

  async failImport(importId: string, error: string) {
    const i = this.imports.find((x) => x.id === importId);
    if (!i || i.status === 'done') return;
    i.status = 'failed';
    i.error = error;
    i.completedAt = new Date().toISOString();
    i.content = null;
  }

  async listStaleImports(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    return this.imports
      .filter((i) => (i.status === 'queued' || i.status === 'processing') && i.createdMs <= cutoff)
      .map((i) => ({ id: i.id, accountId: i.accountId }));
  }

  async getOverrides(accountId: string) {
    return new Map(this.overrides.get(accountId) ?? []);
  }

  async setOverride(accountId: string, merchantKey: string, category: string) {
    const m = this.overrides.get(accountId) ?? new Map<string, string>();
    m.set(merchantKey, category);
    this.overrides.set(accountId, m);
  }

  async listTransactions(accountId: string) {
    return this.txns.filter((t) => t.accountId === accountId).map((t) => ({ ...t }));
  }

  async recategorize(accountId: string, merchantKey: string, category: CategoryResult) {
    let n = 0;
    for (const t of this.txns) {
      if (t.accountId === accountId && t.merchantKey === merchantKey) {
        t.category = category;
        n++;
      }
    }
    return n;
  }
}

export type { ReconBreak };
