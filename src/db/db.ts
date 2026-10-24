import { Pool, types } from 'pg';

/** Minimal surface the repository needs, so prod (pg) and tests (PGlite) share one implementation. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function pgDb(pool: Pool): Db {
  // BIGINT (oid 20) comes back as a string by default. Our values (paise, ids) fit in 2^53.
  types.setTypeParser(20, (v) => Number(v));

  return {
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (sql, params) => client.query(sql, params as unknown[]) as never });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
