import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db';

/** <root>/db/migrations, from both src/db (tsx) and dist/db (build). */
export const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

// Arbitrary constant: every process that migrates takes this advisory lock, so an API and
// several workers starting together apply each migration exactly once.
const LOCK_ID = 727_001;

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

/** `NNN_name.sql` files, in order. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      // Normalize line endings so a Windows checkout (CRLF) and Linux (LF) agree on the checksum.
      const sql = readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      return { version: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies pending migrations in one transaction (all or nothing) and returns their versions.
 * Refuses to run if an already-applied migration file was edited: fix forward with a new one.
 */
export async function migrate(db: Db, migrations = loadMigrations()): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await tx.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const ran: string[] = [];
    for (const m of migrations) {
      const prior = applied.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.checksum) throw new Error(`migration ${m.version} was changed after it was applied`);
        continue;
      }
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [m.version, m.checksum]);
      ran.push(m.version);
    }
    return ran;
  });
}
