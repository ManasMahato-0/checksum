import { describe, expect, it } from 'vitest';
import { pgliteDb } from './helpers/pglite';

describe('schema guarantees (enforced by Postgres itself)', () => {
  it('rejects a duplicate fingerprint for the same account', async () => {
    const db = await pgliteDb();
    await db.query(`INSERT INTO accounts (id, name, bank) VALUES (1, 'a', 'HDFC')`);
    await db.query(`INSERT INTO imports (account_id, file_hash, filename, bank, status) VALUES (1,'h','f','HDFC','done')`);
    const ins = () =>
      db.query(
        `INSERT INTO transactions (account_id, import_id, fingerprint, txn_date, narration, channel, category, category_source)
         VALUES (1, 1, 'fp', '2026-09-01', 'x', 'UPI', 'Uncategorized', 'none')`,
      );
    await ins();
    await expect(ins()).rejects.toThrow(/unique|duplicate/i);
  });

  it('rejects negative amounts', async () => {
    const db = await pgliteDb();
    await db.query(`INSERT INTO accounts (id, name, bank) VALUES (1, 'a', 'HDFC')`);
    await db.query(`INSERT INTO imports (account_id, file_hash, filename, bank, status) VALUES (1,'h','f','HDFC','done')`);
    await expect(
      db.query(
        `INSERT INTO transactions (account_id, import_id, fingerprint, txn_date, narration, channel, debit_paise, category, category_source)
         VALUES (1, 1, 'fp', '2026-09-01', 'x', 'UPI', -5, 'Uncategorized', 'none')`,
      ),
    ).rejects.toThrow();
  });
});
