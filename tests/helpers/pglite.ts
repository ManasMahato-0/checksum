import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';

/** A real Postgres engine (WASM), migrated with the project's actual migrations. */
export async function pgliteDb({ migrated = true } = {}): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    query: (sql, params) => pg.query(sql, params as unknown[]) as never,
    exec: async (sql) => void (await pg.exec(sql)),
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({ query: (sql, params) => tx.query(sql, params as unknown[]) as never, exec: async (sql) => void (await tx.exec(sql)) }),
      ),
  };
  if (migrated) await migrate(db);
  return db;
}
