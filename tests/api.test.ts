import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { InMemoryAuthStore } from '../src/auth/store';
import { InMemoryRepository, type Repository } from '../src/import/repository';
import { InProcessQueue } from '../src/queue/queue';
import { csv, header, L, makeHarness } from './helpers/harness';

/** Repository whose every read rejects: a database outage as seen by the API. */
function brokenRepo(): Repository {
  return new Proxy(new InMemoryRepository(), {
    get: () => async () => {
      throw new Error('connection refused');
    },
  });
}

describe('HTTP error handling', () => {
  it.each(['/accounts/1/imports/1', '/accounts/1/transactions', '/accounts/1/summary'])(
    'GET %s answers 500 JSON on a database error instead of hanging',
    async (url) => {
      const h = await makeHarness(brokenRepo(), { startWorker: false });
      const res = await h.api.get(url).timeout(2000);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal error' });
    },
  );

  it('PUT override answers 500 JSON on a database error', async () => {
    const h = await makeHarness(brokenRepo(), { startWorker: false });
    const res = await h.api.put('/accounts/1/merchants/SWIGGY/category').send({ category: 'Food' }).timeout(2000);
    expect(res.status).toBe(500);
  });

  it('an oversized upload is 413, not 500', async () => {
    const h = await makeHarness(new InMemoryRepository(), { startWorker: false });
    const big = Buffer.concat([csv(L.salary), Buffer.alloc(5 * 1024 * 1024 + 1, ' ')]);
    const res = await h.upload(big);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/limit/);
  });

  it('invalid JSON body is 400', async () => {
    const h = await makeHarness(new InMemoryRepository(), { startWorker: false });
    const res = await h.api
      .put('/accounts/1/merchants/SWIGGY/category')
      .set('content-type', 'application/json')
      .send('{"category":');
    expect(res.status).toBe(400);
  });

  it('a merchant name containing % works (params are decoded once)', async () => {
    const h = await makeHarness(new InMemoryRepository());
    await h.uploadAndWait(Buffer.from(`${header}\n${L.swiggy}`));
    const res = await h.api.put(`/accounts/1/merchants/${encodeURIComponent('100% PURE')}/category`).send({ category: 'Food' });
    expect(res.status).toBe(200);
    expect(res.body.merchantKey).toBe('100 PURE');
  });
});

describe('API surface for the frontend', () => {
  it('rejects a non-numeric accountId on every account route', async () => {
    const h = await makeHarness(new InMemoryRepository(), { startWorker: false });
    for (const url of ['/accounts/abc/transactions', '/accounts/abc/summary', '/accounts/abc/imports']) {
      expect((await h.api.get(url)).status).toBe(400);
    }
    expect((await h.api.post('/accounts/abc/imports').attach('file', csv(L.salary), 'a.csv')).status).toBe(400);
  });

  it('lists categories the rules can assign', async () => {
    const h = await makeHarness(new InMemoryRepository(), { startWorker: false });
    const res = await h.api.get('/categories');
    expect(res.body).toContain('Food & Dining');
    expect(res.body).toContain('Uncategorized');
  });
});

describe('serving the built frontend', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'checksum-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>checksum</title>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  const app = createApp(
    { repo: new InMemoryRepository(), queue: new InProcessQueue(), auth: new InMemoryAuthStore() },
    { staticDir: dir },
  );

  it('serves assets and falls back to index.html for page routes', async () => {
    expect((await request(app).get('/app.js')).text).toContain('console.log');
    const page = await request(app).get('/transactions').set('accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>checksum</title>');
  });

  it('API routes still answer JSON, and unknown API paths stay 404', async () => {
    const api = await request(app).get('/accounts/1/transactions').set('accept', 'text/html');
    expect(api.status).toBe(401); // reaches the API (not index.html), which wants a session
    expect(api.type).toMatch(/json/);
    expect((await request(app).get('/nope').set('accept', 'application/json')).status).toBe(404);
  });
});
