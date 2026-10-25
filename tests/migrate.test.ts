import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate, type Migration } from '../src/db/migrate';
import { pgliteDb } from './helpers/pglite';

const m = (version: string, sql: string): Migration => ({ version, sql, checksum: `sum-${version}-${sql.length}` });
const tables = async (db: Awaited<ReturnType<typeof pgliteDb>>) =>
  (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);

describe('migrations', () => {
  it('applies the real migrations to an empty database, then does nothing on re-run', async () => {
    const db = await pgliteDb({ migrated: false });
    const all = loadMigrations();
    expect(await migrate(db)).toEqual(all.map((x) => x.version));
    expect(await tables(db)).toEqual(expect.arrayContaining(['users', 'accounts', 'imports', 'transactions', 'schema_migrations']));
    expect(await migrate(db)).toEqual([]);
  });

  it('applies only what is new', async () => {
    const db = await pgliteDb({ migrated: false });
    await migrate(db, [m('001_a', 'CREATE TABLE a (id int)')]);
    expect(await migrate(db, [m('001_a', 'CREATE TABLE a (id int)'), m('002_b', 'CREATE TABLE b (id int)')])).toEqual(['002_b']);
    expect(await tables(db)).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const db = await pgliteDb({ migrated: false });
    await migrate(db, [m('001_a', 'CREATE TABLE a (id int)')]);
    await expect(migrate(db, [m('001_a', 'CREATE TABLE a (id bigint)')])).rejects.toThrow(/001_a was changed/);
  });

  it('is all or nothing: a failing migration leaves no partial schema behind', async () => {
    const db = await pgliteDb({ migrated: false });
    await expect(migrate(db, [m('001_a', 'CREATE TABLE a (id int)'), m('002_bad', 'CREATE TABLE nope (')])).rejects.toThrow();
    expect(await tables(db)).toEqual([]);
  });
});
