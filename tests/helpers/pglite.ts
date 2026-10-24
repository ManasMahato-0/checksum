import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../src/db/db';

/** A real Postgres engine (WASM) loaded with the project's actual schema.sql. */
export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8'));
  return {
    query: (sql, params) => pg.query(sql, params as unknown[]) as never,
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params as unknown[]) as never })),
  };
}
