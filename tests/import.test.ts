import { execFileSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { importHandlers, processImport, requeueStaleImports } from '../src/import/importService';
import { InMemoryRepository } from '../src/import/repository';
import { csv, flaky, header, L, makeHarness, stores } from './helpers/harness';

describe.each(stores)('async import pipeline [%s]', (_name, makeRepo) => {
  it('accepts with 202 and a status URL, then processes in the background', async () => {
    const h = makeHarness(await makeRepo(), { startWorker: false });

    const post = await h.upload(csv(L.salary, L.swiggy, L.chai1));
    expect(post.status).toBe(202);
    expect(post.body).toMatchObject({ status: 'queued' });
    expect(post.headers.location).toBe(post.body.statusUrl);

    // nothing has run yet: the upload is staged, not processed
    expect(await h.status(post.body.importId)).toMatchObject({ status: 'queued', attempts: 0, reconciliation: null });
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(0);

    h.queue.start(importHandlers(h.repo));
    await h.queue.idle();

    const done = await h.status(post.body.importId);
    expect(done).toMatchObject({ status: 'done', bank: 'HDFC', rowsTotal: 3, rowsInserted: 3, rowsDuplicate: 0, attempts: 1 });
    expect(done.reconciliation.ok).toBe(true);
    expect(done.reconciliation.openingPaise).toBe(8_500_000);

    const txns = (await request(h.app).get('/accounts/1/transactions')).body;
    expect(txns.find((t: any) => t.merchantKey === 'SWIGGY').category.category).toBe('Food & Dining');
  });

  it('same file twice is a no-op and points at the original import', async () => {
    const h = makeHarness(await makeRepo());
    const f = csv(L.salary, L.swiggy);
    const first = await h.uploadAndWait(f);
    const again = await h.uploadAndWait(f);
    expect(again.post.status).toBe(200);
    expect(again.post.body).toMatchObject({ status: 'duplicate_file', importId: first.post.body.importId });
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(2);
  });

  it('overlapping statements do not double-insert (row-level dedupe)', async () => {
    const h = makeHarness(await makeRepo());
    await h.uploadAndWait(csv(L.salary, L.swiggy, L.chai1), 'a.csv');
    const { status } = await h.uploadAndWait(csv(L.swiggy, L.chai1, L.uber), 'b.csv');
    expect(status).toMatchObject({ rowsTotal: 3, rowsInserted: 1, rowsDuplicate: 2 });
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(4);
  });

  it('two genuine identical payments on one day are both kept', async () => {
    const h = makeHarness(await makeRepo());
    const { status } = await h.uploadAndWait(csv(L.salary, L.chai1, L.chai2));
    expect(status.rowsInserted).toBe(3);
  });

  it('flags a missing transaction via balance break', async () => {
    const h = makeHarness(await makeRepo());
    const { status } = await h.uploadAndWait(csv(L.salary, L.chai1)); // swiggy row missing
    expect(status.reconciliation.ok).toBe(false);
    expect(status.reconciliation.breaks[0]).toMatchObject({ rowNumber: 3, diffPaise: -50_000 });
  });

  it('user override re-labels existing transactions and future imports', async () => {
    const h = makeHarness(await makeRepo());
    await h.uploadAndWait(csv(L.salary, L.swiggy));
    const put = await request(h.app).put('/accounts/1/merchants/SWIGGY/category').send({ category: 'Work Lunch' });
    expect(put.body.relabelled).toBe(1);

    await h.uploadAndWait(csv(L.uber, L.swiggy.replace('02/09/26', '09/09/26').replace('144500.00', '143000.00')), 'c.csv');
    const txns = await request(h.app).get('/accounts/1/transactions?category=Work%20Lunch');
    expect(txns.body.length).toBe(2);
  });

  it('rejects unknown formats and non-csv without staging anything', async () => {
    const h = makeHarness(await makeRepo());
    expect((await h.upload(Buffer.from('a,b,c\n1,2,3'))).status).toBe(422);
    expect((await h.upload(csv(L.salary), 'x.pdf')).status).toBe(415);
    expect((await request(h.app).get('/accounts/1/imports/1')).status).toBe(404);
  });

  it('summary is spend per month per category in paise', async () => {
    const h = makeHarness(await makeRepo());
    await h.uploadAndWait(csv(L.salary, L.swiggy, L.uber));
    const s = await request(h.app).get('/accounts/1/summary');
    expect(s.body['2026-09']['Food & Dining']).toBe(50_000);
    expect(s.body['2026-09']['Transport']).toBe(25_000);
  });

  it('a malformed file fails permanently on the first attempt (no pointless retries)', async () => {
    const h = makeHarness(await makeRepo());
    const bad = Buffer.from(`${header}\n01/09/26,UPI-X-x@y-UTIB0000001-412345678901-p,1,01/09/26,not-a-number,,100.00`);
    const { status } = await h.uploadAndWait(bad);
    expect(status.status).toBe('failed');
    expect(status.attempts).toBe(1);
    expect(status.error).toMatch(/could not parse/);
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(0);
  });

  it('an impossible HDFC date fails permanently instead of reaching the database', async () => {
    const h = makeHarness(await makeRepo());
    const bad = Buffer.from(`${header}\n31/02/26,UPI-X-x@y-UTIB0000001-412345678901-p,1,31/02/26,10.00,,100.00`);
    const { status } = await h.uploadAndWait(bad);
    expect(status).toMatchObject({ status: 'failed', attempts: 1 });
    expect(status.error).toMatch(/Invalid HDFC date: "31\/02\/26"/);
  });

  it('transient errors are retried with backoff, then succeed', async () => {
    const repo = await makeRepo();
    const h = makeHarness(repo, { workerRepo: flaky(repo, 2) });
    const { status } = await h.uploadAndWait(csv(L.salary, L.swiggy));
    expect(status).toMatchObject({ status: 'done', attempts: 3, rowsInserted: 2 });
  });

  it('when retries are exhausted the import is dead-lettered as failed', async () => {
    const repo = await makeRepo();
    const h = makeHarness(repo, { workerRepo: flaky(repo, 99) });
    const { status } = await h.uploadAndWait(csv(L.salary, L.swiggy));
    expect(status).toMatchObject({ status: 'failed', attempts: 3, error: 'db blip' });
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(0);
  });

  it('a redelivered job after completion changes nothing', async () => {
    const h = makeHarness(await makeRepo());
    const { post } = await h.uploadAndWait(csv(L.salary, L.swiggy));
    await processImport(h.repo, post.body.importId);
    await processImport(h.repo, post.body.importId);
    expect(await h.status(post.body.importId)).toMatchObject({ status: 'done', attempts: 1 });
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(2);
  });

  it('sweeper recovers an upload that was saved but never enqueued (crash recovery)', async () => {
    const repo = await makeRepo();
    const h = makeHarness(repo);
    // simulate: API saved the file, then died before enqueueing
    const { importId } = await repo.createPendingImport({
      accountId: '1', fileHash: 'orphan', filename: 'orphan.csv', content: csv(L.salary, L.swiggy),
    });
    expect((await h.status(importId)).status).toBe('queued');

    expect(await requeueStaleImports(repo, h.queue, 0)).toBe(1);
    await h.queue.idle();
    expect(await h.status(importId)).toMatchObject({ status: 'done', rowsInserted: 2 });
  });

  it('lists imports newest first with reconciliation status', async () => {
    const h = makeHarness(await makeRepo());
    await h.uploadAndWait(csv(L.salary, L.swiggy), 'clean.csv');
    await h.uploadAndWait(csv(L.salary, L.uber), 'gappy.csv'); // uber's balance skips the swiggy debit
    const list = (await request(h.app).get('/accounts/1/imports')).body;
    expect(list.map((i: any) => i.filename)).toEqual(['gappy.csv', 'clean.csv']);
    expect(list[0]).toMatchObject({ status: 'done', reconciliationOk: false, breakCount: 1 });
    expect(list[1]).toMatchObject({ status: 'done', reconciliationOk: true, breakCount: 0 });
    expect(list[0].reconciliation).toBeUndefined();
    expect(Date.parse(list[0].createdAt)).not.toBeNaN();
    expect(Date.parse(list[0].completedAt)).not.toBeNaN();
    expect((await request(h.app).get('/accounts/2/imports')).body).toEqual([]);
  });

  it('cannot read another account\'s import', async () => {
    const h = makeHarness(await makeRepo());
    const { post } = await h.uploadAndWait(csv(L.salary));
    const other = await request(h.app).get(`/accounts/2/imports/${post.body.importId}`);
    expect(other.status).toBe(404);
  });
});

describe.each(stores)('concurrency [%s]', (_name, makeRepo) => {
  it('parallel uploads of the same file are accepted exactly once', async () => {
    const h = makeHarness(await makeRepo());
    const f = csv(L.salary, L.swiggy, L.chai1);
    const results = await Promise.all([h.upload(f), h.upload(f), h.upload(f), h.upload(f)]);
    await h.queue.idle();
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.body.status === 'duplicate_file')).toHaveLength(3);
    expect(new Set(results.map((r) => r.body.importId)).size).toBe(1);
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(3);
  });

  it('parallel overlapping files never double-insert a row', async () => {
    const h = makeHarness(await makeRepo());
    const a = csv(L.salary, L.swiggy, L.chai1);
    const b = csv(L.swiggy, L.chai1, L.uber);
    await Promise.all([h.upload(a, 'a.csv'), h.upload(b, 'b.csv')]);
    await h.queue.idle();
    expect((await request(h.app).get('/accounts/1/transactions')).body).toHaveLength(4);
  });
});

describe('synthetic generator', () => {
  it('produces a file that imports cleanly, and --drop creates reconciliation gaps', async () => {
    const script = path.join(__dirname, '../scripts/generate-statement.ts');
    // `node --import tsx` instead of node_modules/.bin/tsx: the .bin shim is not executable on Windows
    const gen = (...a: string[]) => execFileSync(process.execPath, ['--import', 'tsx', script, ...a], { encoding: 'utf8' });
    const clean = gen('--seed', '3');
    const gappy = gen('--seed', '3', '--drop', '2');

    const h = makeHarness(new InMemoryRepository());
    expect((await h.uploadAndWait(Buffer.from(clean), 'clean.csv')).status.reconciliation.ok).toBe(true);
    const g = await h.uploadAndWait(Buffer.from(gappy), 'gappy.csv');
    expect(g.status.reconciliation.breaks.length).toBeGreaterThan(0);
  });
});
