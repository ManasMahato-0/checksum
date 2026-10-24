import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { importHandlers } from '../src/import/importService';
import { InMemoryRepository, type Repository } from '../src/import/repository';
import { BullMqQueue } from '../src/queue/bullmqQueue';
import { csv, flaky, header, L } from './helpers/harness';

/**
 * Integration tests against a REAL Redis. Skipped unless REDIS_URL is set:
 *   docker compose up -d redis && REDIS_URL=redis://localhost:6379 npm test
 */
describe.skipIf(!process.env.REDIS_URL)('BullMQ queue (real Redis)', () => {
  const open: BullMqQueue[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((q) => q.close()));
  });

  function setup(repo: Repository, workerRepo: Repository = repo) {
    // unique queue per test so runs never see each other's jobs
    const queue = new BullMqQueue({
      redisUrl: process.env.REDIS_URL!,
      queueName: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      retry: { attempts: 3, baseDelayMs: 20 },
      concurrency: 2,
    });
    open.push(queue);
    queue.start(importHandlers(workerRepo));
    const app = createApp(repo, queue);
    return { app, queue };
  }

  async function waitFor(app: ReturnType<typeof createApp>, importId: string, until: (s: any) => boolean) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const s = (await request(app).get(`/accounts/1/imports/${importId}`)).body;
      if (until(s)) return s;
      if (Date.now() > deadline) throw new Error(`timed out; last status: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('processes an upload end to end through Redis', async () => {
    const { app } = setup(new InMemoryRepository());
    const post = await request(app).post('/accounts/1/imports').attach('file', csv(L.salary, L.swiggy), 'a.csv');
    expect(post.status).toBe(202);
    const s = await waitFor(app, post.body.importId, (x) => x.status === 'done');
    expect(s).toMatchObject({ rowsInserted: 2, attempts: 1 });
  });

  it('retries transient failures with exponential backoff', async () => {
    const repo = new InMemoryRepository();
    const { app } = setup(repo, flaky(repo, 2));
    const post = await request(app).post('/accounts/1/imports').attach('file', csv(L.salary, L.swiggy), 'a.csv');
    const s = await waitFor(app, post.body.importId, (x) => x.status === 'done' || x.status === 'failed');
    expect(s).toMatchObject({ status: 'done', attempts: 3 });
  });

  it('does not retry permanent failures, and records the reason', async () => {
    const { app } = setup(new InMemoryRepository());
    const bad = Buffer.from(`${header}\n01/09/26,UPI-X-x@y-UTIB0000001-412345678901-p,1,01/09/26,nope,,100.00`);
    const post = await request(app).post('/accounts/1/imports').attach('file', bad, 'bad.csv');
    const s = await waitFor(app, post.body.importId, (x) => x.status === 'failed');
    expect(s.attempts).toBe(1);
    expect(s.error).toMatch(/could not parse/);
  });

  it('dead-letters a job whose retries are exhausted', async () => {
    const repo = new InMemoryRepository();
    const { app } = setup(repo, flaky(repo, 99));
    const post = await request(app).post('/accounts/1/imports').attach('file', csv(L.salary), 'a.csv');
    const s = await waitFor(app, post.body.importId, (x) => x.status === 'failed');
    expect(s).toMatchObject({ attempts: 3, error: 'db blip' });
  });
});
