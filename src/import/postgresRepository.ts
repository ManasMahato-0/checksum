import type { Db, Queryable } from '../db/db';
import type { CategoryResult, Channel, CategorySource } from '../domain/types';
import type { ReconBreak } from '../reconcile/reconcile';
import type {
  CompleteImportInput,
  ImportListItem,
  ImportRecord,
  ImportStatus,
  Repository,
  StoredTxn,
} from './repository';

const CHUNK_ROWS = 500; // 500 rows x ~15 params stays far below Postgres' 65535 parameter limit

/** Multi-row INSERT in chunks. Returns the rows from RETURNING (if any) across all chunks. */
async function insertChunked<T = Record<string, unknown>>(
  tx: Queryable,
  table: string,
  columns: string[],
  rows: unknown[][],
  opts: { onConflict?: string; returning?: string } = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const chunk = rows.slice(i, i + CHUNK_ROWS);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const ph = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    const sql =
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ` +
      `${opts.onConflict ?? ''} ${opts.returning ? `RETURNING ${opts.returning}` : ''}`;
    const res = await tx.query<T>(sql, params);
    out.push(...res.rows);
  }
  return out;
}

const TXN_SELECT = `
  SELECT id, account_id, import_id, fingerprint,
         to_char(txn_date, 'YYYY-MM-DD') AS date,
         narration, channel, merchant_key, reference_no,
         debit_paise, credit_paise, balance_paise,
         category, category_source, category_reason
  FROM transactions`;

type TxnRow = {
  account_id: string | number;
  import_id: string | number;
  fingerprint: string;
  date: string;
  narration: string;
  channel: string;
  merchant_key: string | null;
  reference_no: string | null;
  debit_paise: string | number | bigint;
  credit_paise: string | number | bigint;
  balance_paise: string | number | bigint | null;
  category: string;
  category_source: string;
  category_reason: string | null;
};

const toStoredTxn = (r: TxnRow): StoredTxn => ({
  accountId: String(r.account_id),
  importId: String(r.import_id),
  fingerprint: r.fingerprint,
  date: r.date,
  narration: r.narration,
  channel: r.channel as Channel,
  merchantKey: r.merchant_key,
  referenceNo: r.reference_no,
  debitPaise: Number(r.debit_paise),
  creditPaise: Number(r.credit_paise),
  balancePaise: r.balance_paise === null ? null : Number(r.balance_paise),
  category: {
    category: r.category,
    source: r.category_source as CategorySource,
    reason: r.category_reason,
  },
});

// Timestamps as ISO strings straight from SQL, so pg and PGlite agree on the format.
const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const IMPORT_SELECT = `
  SELECT id, account_id, filename, bank, status, attempts, error, rows_total, rows_inserted, rows_duplicate,
         ${iso('created_at')} AS created_at, ${iso('completed_at')} AS completed_at,
         opening_paise, closing_paise, total_debits_paise, total_credits_paise
  FROM imports`;

type ImportRow = Record<string, string | number | bigint | null>;

const toImportBase = (r: ImportRow): Omit<ImportRecord, 'reconciliation'> => ({
  id: String(r.id),
  accountId: String(r.account_id),
  filename: String(r.filename),
  bank: r.bank === null ? null : String(r.bank),
  status: r.status as ImportStatus,
  attempts: Number(r.attempts),
  error: r.error === null ? null : String(r.error),
  rowsTotal: Number(r.rows_total),
  rowsInserted: Number(r.rows_inserted),
  rowsDuplicate: Number(r.rows_duplicate),
  createdAt: String(r.created_at),
  completedAt: r.completed_at === null ? null : String(r.completed_at),
});

export class PostgresRepository implements Repository {
  constructor(private readonly db: Db) {}

  async createPendingImport(input: { accountId: string; fileHash: string; filename: string; content: Buffer }) {
    return this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO accounts (id, name, bank) VALUES ($1, $2, 'UNKNOWN') ON CONFLICT (id) DO NOTHING`,
        [input.accountId, `Account ${input.accountId}`],
      );
      // UNIQUE (account_id, file_hash): the loser of a race gets no row back.
      const created = await tx.query<{ id: string | number }>(
        `INSERT INTO imports (account_id, file_hash, filename, status, file_content)
         VALUES ($1, $2, $3, 'queued', $4)
         ON CONFLICT (account_id, file_hash) DO NOTHING
         RETURNING id`,
        [input.accountId, input.fileHash, input.filename, input.content],
      );
      if (created.rows[0]) return { duplicate: false, importId: String(created.rows[0].id) };
      const { rows } = await tx.query<{ id: string | number }>(
        `SELECT id FROM imports WHERE account_id = $1 AND file_hash = $2`,
        [input.accountId, input.fileHash],
      );
      return { duplicate: true, importId: String(rows[0]!.id) };
    });
  }

  async getImport(accountId: string, importId: string): Promise<ImportRecord | null> {
    const { rows } = await this.db.query<ImportRow>(`${IMPORT_SELECT} WHERE id = $1 AND account_id = $2`, [
      importId,
      accountId,
    ]);
    const r = rows[0];
    if (!r) return null;

    let reconciliation: ImportRecord['reconciliation'] = null;
    if (r.status === 'done') {
      const br = await this.db.query<Record<string, string | number | bigint>>(
        `SELECT row_number, expected_paise, actual_paise, diff_paise
         FROM reconciliation_breaks WHERE import_id = $1 ORDER BY row_number`,
        [importId],
      );
      const breaks: ReconBreak[] = br.rows.map((b) => ({
        rowNumber: Number(b.row_number),
        expectedPaise: Number(b.expected_paise),
        actualPaise: Number(b.actual_paise),
        diffPaise: Number(b.diff_paise),
      }));
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      reconciliation = {
        ok: breaks.length === 0,
        openingPaise: num(r.opening_paise),
        closingPaise: num(r.closing_paise),
        totalDebitsPaise: Number(r.total_debits_paise ?? 0),
        totalCreditsPaise: Number(r.total_credits_paise ?? 0),
        breaks,
      };
    }
    return { ...toImportBase(r), reconciliation };
  }

  async listImports(accountId: string, limit: number): Promise<ImportListItem[]> {
    const { rows } = await this.db.query<ImportRow>(
      `SELECT i.*, (SELECT count(*) FROM reconciliation_breaks b WHERE b.import_id = i.id) AS break_count
       FROM (${IMPORT_SELECT} WHERE account_id = $1 ORDER BY id DESC LIMIT $2) i
       ORDER BY i.id DESC`,
      [accountId, limit],
    );
    return rows.map((r) => {
      const breakCount = Number(r.break_count);
      return { ...toImportBase(r), reconciliationOk: r.status === 'done' ? breakCount === 0 : null, breakCount };
    });
  }

  async claimImport(importId: string) {
    const { rows } = await this.db.query<{
      account_id: string | number;
      filename: string;
      file_content: Uint8Array;
    }>(
      `UPDATE imports SET status = 'processing', attempts = attempts + 1
       WHERE id = $1 AND status IN ('queued', 'processing') AND file_content IS NOT NULL
       RETURNING account_id, filename, file_content`,
      [importId],
    );
    const r = rows[0];
    if (!r) return null;
    return { accountId: String(r.account_id), filename: r.filename, content: Buffer.from(r.file_content) };
  }

  async completeImport(input: CompleteImportInput) {
    return this.db.transaction(async (tx) => {
      // Row lock: if a stalled job and its retry both finish, only the first one writes.
      const lock = await tx.query<{ status: string; account_id: string | number }>(
        `SELECT status, account_id FROM imports WHERE id = $1 FOR UPDATE`,
        [input.importId],
      );
      const row = lock.rows[0];
      if (!row || row.status !== 'processing') return null;
      const accountId = String(row.account_id);

      // Raw rows: immutable audit copy of everything the bank sent, duplicates included.
      await insertChunked(
        tx,
        'raw_rows',
        ['import_id', 'row_number', 'raw'],
        input.txns.map((t) => [input.importId, t.raw.rowNumber, JSON.stringify(t.raw.raw)]),
      );

      // UNIQUE (account_id, fingerprint): rows already seen in an earlier statement are skipped.
      const inserted = await insertChunked<{ fingerprint: string }>(
        tx,
        'transactions',
        [
          'account_id', 'import_id', 'fingerprint', 'txn_date', 'narration', 'channel',
          'merchant_key', 'reference_no', 'debit_paise', 'credit_paise', 'balance_paise',
          'category', 'category_source', 'category_reason',
        ],
        input.txns.map((t) => [
          accountId, input.importId, t.fingerprint, t.date, t.narration, t.channel,
          t.merchantKey, t.referenceNo, t.debitPaise, t.creditPaise, t.balancePaise,
          t.category.category, t.category.source, t.category.reason,
        ]),
        { onConflict: 'ON CONFLICT (account_id, fingerprint) DO NOTHING', returning: 'fingerprint' },
      );

      const recon = input.reconciliation;
      await insertChunked(
        tx,
        'reconciliation_breaks',
        ['import_id', 'row_number', 'expected_paise', 'actual_paise', 'diff_paise'],
        recon.breaks.map((b) => [input.importId, b.rowNumber, b.expectedPaise, b.actualPaise, b.diffPaise]),
      );

      const rowsInserted = inserted.length;
      const rowsDuplicate = input.txns.length - rowsInserted;
      await tx.query(
        `UPDATE imports
         SET status = 'done', bank = $2, rows_total = $3, rows_inserted = $4, rows_duplicate = $5,
             opening_paise = $6, closing_paise = $7, total_debits_paise = $8, total_credits_paise = $9,
             file_content = NULL, error = NULL, completed_at = now()
         WHERE id = $1`,
        [
          input.importId, input.bank, input.txns.length, rowsInserted, rowsDuplicate,
          recon.openingPaise, recon.closingPaise, recon.totalDebitsPaise, recon.totalCreditsPaise,
        ],
      );
      return { rowsInserted, rowsDuplicate };
    });
  }

  async failImport(importId: string, error: string) {
    await this.db.query(
      `UPDATE imports SET status = 'failed', error = $2, file_content = NULL, completed_at = now()
       WHERE id = $1 AND status <> 'done'`,
      [importId, error],
    );
  }

  async listStaleImports(olderThanMs: number) {
    const { rows } = await this.db.query<{ id: string | number; account_id: string | number }>(
      `SELECT id, account_id FROM imports
       WHERE status IN ('queued', 'processing')
         AND created_at <= now() - ($1::double precision * interval '1 millisecond')`,
      [olderThanMs],
    );
    return rows.map((r) => ({ id: String(r.id), accountId: String(r.account_id) }));
  }

  async getOverrides(accountId: string) {
    const { rows } = await this.db.query<{ merchant_key: string; category: string }>(
      `SELECT merchant_key, category FROM merchant_overrides WHERE account_id = $1`,
      [accountId],
    );
    return new Map(rows.map((r) => [r.merchant_key, r.category]));
  }

  async setOverride(accountId: string, merchantKey: string, category: string) {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO accounts (id, name, bank) VALUES ($1, $2, 'UNKNOWN') ON CONFLICT (id) DO NOTHING`,
        [accountId, `Account ${accountId}`],
      );
      await tx.query(
        `INSERT INTO merchant_overrides (account_id, merchant_key, category) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, merchant_key) DO UPDATE SET category = EXCLUDED.category`,
        [accountId, merchantKey, category],
      );
    });
  }

  async listTransactions(accountId: string): Promise<StoredTxn[]> {
    const { rows } = await this.db.query<TxnRow>(
      `${TXN_SELECT} WHERE account_id = $1 ORDER BY txn_date, id`,
      [accountId],
    );
    return rows.map(toStoredTxn);
  }

  async recategorize(accountId: string, merchantKey: string, c: CategoryResult): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE transactions SET category = $3, category_source = $4, category_reason = $5
       WHERE account_id = $1 AND merchant_key = $2 RETURNING id`,
      [accountId, merchantKey, c.category, c.source, c.reason],
    );
    return rows.length;
  }
}
