// Types come straight from the backend so the two can't drift (type-only: nothing is bundled).
import type { ImportListItem, ImportRecord, StoredTxn } from '../../../src/import/records';
import type { ReconBreak } from '../../../src/reconcile/reconcile';

export type { ImportListItem, ImportRecord, ReconBreak };
export type Txn = Omit<StoredTxn, 'fingerprint'>;
/** month (yyyy-mm) -> category -> debit paise */
export type Summary = Record<string, Record<string, number>>;
export type UploadResult = { status: 'queued' | 'duplicate_file'; importId: string; statusUrl: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { accept: 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError(0, 'Cannot reach the Checksum API. Is the server running?');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;

export const api = {
  imports: (account: string) => request<ImportListItem[]>(`${acct(account)}/imports`),
  importDetail: (account: string, id: string) => request<ImportRecord>(`${acct(account)}/imports/${id}`),
  transactions: (account: string) => request<Txn[]>(`${acct(account)}/transactions`),
  summary: (account: string) => request<Summary>(`${acct(account)}/summary`),
  categories: () => request<string[]>('/categories'),

  upload(account: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return request<UploadResult>(`${acct(account)}/imports`, { method: 'POST', body: form });
  },

  setMerchantCategory(account: string, merchantKey: string, category: string) {
    return request<{ merchantKey: string; category: string; relabelled: number }>(
      `${acct(account)}/merchants/${encodeURIComponent(merchantKey)}/category`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category }) },
    );
  },
};

export const isUnfinished = (i: { status: string }) => i.status === 'queued' || i.status === 'processing';
