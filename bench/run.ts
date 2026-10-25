/**
 * Reproducible benchmarks against real Postgres + Redis (see bench/docker-compose.yml).
 *   docker compose -f bench/docker-compose.yml up -d && npm run bench
 * Writes docs/BENCHMARKS.md and bench/results.json. QUICK=1 shrinks every scenario for a smoke run.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import IORedis from 'ioredis';
import multer from 'multer';
import { Pool } from 'pg';
import { createApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/http';
import { hashToken, newSessionToken } from '../src/auth/passwords';
import { PostgresAuthStore } from '../src/auth/postgresStore';
import { pgDb } from '../src/db/db';
import { sha256 } from '../src/dedupe/fingerprint';
import { processImport } from '../src/import/importService';
import { PostgresRepository } from '../src/import/postgresRepository';
import { BullMqQueue } from '../src/queue/bullmqQueue';
import { generate, rng, toCsv, type Row } from './statements';

const DATABASE_URL = process.env.BENCH_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:55432/checksum';
const REDIS_URL = process.env.BENCH_REDIS_URL ?? 'redis://localhost:56379';
const QUICK = process.env.QUICK === '1';
const ROOT = path.resolve(__dirname, '..');

const pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
const db = pgDb(pool);
const repo = new PostgresRepository(db);
const auth = new PostgresAuthStore(db);
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------- helpers

const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x: number) => Math.round(x).toLocaleString('en-US');
const log = (...a: unknown[]) => console.log('[bench]', ...a);

async function reset() {
  await db.query(
    'TRUNCATE users, sessions, accounts, imports, raw_rows, transactions, merchant_overrides, reconciliation_breaks RESTART IDENTITY CASCADE',
  );
  await redis.flushall();
}

let userSeq = 0;
/** A user + account, and a session cookie for HTTP calls. */
async function newAccount(): Promise<{ accountId: string; cookie: string }> {
  const user = (await auth.createUser(`bench${++userSeq}-${Date.now()}@example.com`, 'x'))!;
  const account = await auth.createAccount(user.id, 'bench');
  const token = newSessionToken();
  await auth.createSession(user.id, hashToken(token), new Date(Date.now() + 3600_000));
  return { accountId: account.id, cookie: `${SESSION_COOKIE}=${token}` };
}

function listen(app: express.Express): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

async function upload(url: string, cookie: string, csv: Buffer, name: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(csv)], { type: 'text/csv' }), name);
  const t0 = now();
  const res = await fetch(url, { method: 'POST', body: form, headers: { cookie } });
  const body = (await res.json()) as { importId?: string; status?: string };
  return { status: res.status, body, ms: now() - t0 };
}

async function waitAll(ids: string[], timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM imports WHERE id = ANY($1::bigint[]) AND status IN ('done', 'failed')`,
      [ids],
    );
    if (Number(rows[0]!.n) === ids.length) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for imports');
    await sleep(5);
  }
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM imports WHERE id = ANY($1::bigint[]) AND status = 'failed'`, [ids]);
  if (Number(rows[0]!.n)) throw new Error(`${rows[0]!.n} imports failed`);
}

/** Real worker processes, exactly as deployed (`node dist/worker.js` / `npm run worker`). */
async function startWorkers(n: number): Promise<() => Promise<void>> {
  const procs: ChildProcess[] = [];
  await Promise.all(
    Array.from({ length: n }, () => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL, REDIS_URL, WORKER_CONCURRENCY: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      procs.push(p);
      p.stderr!.on('data', (d) => process.stderr.write(`[worker] ${d}`));
      return new Promise<void>((resolve, reject) => {
        p.stdout!.on('data', (d) => String(d).includes('worker started') && resolve());
        p.on('exit', (code) => reject(new Error(`worker exited early (${code})`)));
      });
    }),
  );
  return async () => {
    for (const p of procs) {
      p.removeAllListeners('exit');
      p.kill();
    }
    await sleep(300);
  };
}

/** API process half: the real app with a BullMQ queue (enqueue only). */
async function startApi() {
  const queue = new BullMqQueue({ redisUrl: REDIS_URL });
  const { base, server } = await listen(createApp({ repo, queue, auth }));
  return {
    base,
    stop: async () => {
      server.close();
      await queue.close();
    },
  };
}

// ---------------------------------------------------------------------------- scenarios

const results: Record<string, unknown> = {};

/** A. End-to-end throughput for one worker, by statement size. */
async function throughput() {
  const sizes = QUICK ? [1_000, 5_000] : [1_000, 10_000, 40_000]; // 40k rows ≈ 4.3 MB, under the 5 MB upload cap
  const runs = QUICK ? 1 : 3;
  log('A. throughput', sizes);
  await reset();
  const stop = await startWorkers(1);
  const api = await startApi();
  const out: { rows: number; runs: number[]; medianMs: number; rowsPerSec: number }[] = [];
  try {
    // warm-up (JIT, pools)
    const w = await newAccount();
    const wu = await upload(`${api.base}/accounts/${w.accountId}/imports`, w.cookie, toCsv(generate(500, 1)), 'w.csv');
    await waitAll([wu.body.importId!]);

    for (const size of sizes) {
      const times: number[] = [];
      for (let r = 0; r < runs; r++) {
        const a = await newAccount();
        const csv = toCsv(generate(size, 100 + r));
        const t0 = now();
        const up = await upload(`${api.base}/accounts/${a.accountId}/imports`, a.cookie, csv, `s${size}-${r}.csv`);
        await waitAll([up.body.importId!]);
        times.push(now() - t0);
      }
      const m = median(times);
      out.push({ rows: size, runs: times.map((t) => round(t)), medianMs: round(m), rowsPerSec: round((size / m) * 1000) });
      log(`   ${size} rows: median ${round(m)} ms -> ${fmt((size / m) * 1000)} rows/s`);
    }
  } finally {
    await api.stop();
    await stop();
  }
  results.throughput = out;
}

/** B. Upload response time: async (stage + enqueue) vs processing inside the request. */
async function uploadLatency() {
  const size = QUICK ? 2_000 : 10_000;
  const n = QUICK ? 5 : 20;
  log('B. upload latency', { size, n });
  await reset();
  const api = await startApi(); // no workers: we only measure the API's answer

  // Baseline: same staging + the same processImport, but awaited before answering.
  const sync = express();
  const mp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
  sync.post('/accounts/:accountId/imports', mp.single('file'), async (req, res) => {
    const f = req.file!;
    const p = await repo.createPendingImport({ accountId: req.params.accountId!, fileHash: sha256(f.buffer), filename: f.originalname, content: f.buffer });
    await processImport(repo, p.importId);
    res.status(201).json({ importId: p.importId });
  });
  const syncSrv = await listen(sync);

  const measure = async (base: string, label: string) => {
    const a = await newAccount();
    const times: number[] = [];
    for (let i = -2; i < n; i++) {
      const csv = toCsv(generate(size, 1_000 + i + (label === 'sync' ? 500 : 0)));
      const r = await upload(`${base}/accounts/${a.accountId}/imports`, a.cookie, csv, `${label}${i}.csv`);
      if (r.status >= 300) throw new Error(`${label} upload failed: ${r.status} ${JSON.stringify(r.body)}`);
      if (i >= 0) times.push(r.ms); // first two are warm-up
    }
    return { p50: round(median(times), 1), p95: round(pct(times, 95), 1), samples: times.length };
  };
  try {
    const asyncRes = await measure(api.base, 'async');
    const syncRes = await measure(syncSrv.base, 'sync');
    results.uploadLatency = { rows: size, async: asyncRes, sync: syncRes, speedupP50: round(syncRes.p50 / asyncRes.p50, 1) };
    log(`   async p50 ${asyncRes.p50} ms p95 ${asyncRes.p95} | sync p50 ${syncRes.p50} p95 ${syncRes.p95}`);
  } finally {
    syncSrv.server.close();
    await api.stop();
  }
}

/** C. Processing time with multi-row INSERT chunks vs one INSERT per row. */
async function bulkInsert() {
  const size = QUICK ? 2_000 : 10_000;
  const runs = QUICK ? 1 : 3;
  log('C. bulk insert', { size, runs });
  await reset();
  const variants = { 'batched (500 rows/INSERT)': new PostgresRepository(db), 'row-by-row (1 row/INSERT)': new PostgresRepository(db, { chunkRows: 1 }) };
  const out: Record<string, { runs: number[]; medianMs: number }> = {};
  for (const [label, r] of Object.entries(variants)) {
    const times: number[] = [];
    for (let i = -1; i < runs; i++) {
      const a = await newAccount();
      const csv = toCsv(generate(size, 2_000 + i));
      const p = await r.createPendingImport({ accountId: a.accountId, fileHash: sha256(csv), filename: 'x.csv', content: csv });
      const t0 = now();
      await processImport(r, p.importId);
      if (i >= 0) times.push(now() - t0);
    }
    out[label] = { runs: times.map((t) => round(t)), medianMs: round(median(times)) };
    log(`   ${label}: median ${round(median(times))} ms`);
  }
  const [batched, single] = Object.values(out);
  results.bulkInsert = { rows: size, variants: out, speedup: round(single!.medianMs / batched!.medianMs, 1), reductionPct: round((1 - batched!.medianMs / single!.medianMs) * 100) };
}

/** D. Throughput as worker processes are added (same batch of files each time). */
async function workerScaling() {
  const counts = QUICK ? [1, 2] : [1, 2, 4, 8];
  const files = QUICK ? 6 : 24;
  const size = QUICK ? 2_000 : 5_000;
  log('D. worker scaling', { counts, files, size });
  const csvs = Array.from({ length: files }, (_, i) => toCsv(generate(size, 3_000 + i)));
  const out: { workers: number; ms: number; rowsPerSec: number; speedup: number }[] = [];
  for (const n of counts) {
    await reset();
    const stop = await startWorkers(n);
    const api = await startApi();
    try {
      const a = await newAccount();
      const t0 = now();
      const ups = await Promise.all(csvs.map((c, i) => upload(`${api.base}/accounts/${a.accountId}/imports`, a.cookie, c, `f${i}.csv`)));
      await waitAll(ups.map((u) => u.body.importId!));
      const ms = now() - t0;
      const rps = ((files * size) / ms) * 1000;
      out.push({ workers: n, ms: round(ms), rowsPerSec: round(rps), speedup: round(rps / (out[0]?.rowsPerSec ?? rps), 2) });
      log(`   ${n} workers: ${round(ms)} ms -> ${fmt(rps)} rows/s`);
    } finally {
      await api.stop();
      await stop();
    }
  }
  results.workerScaling = { files, rowsPerFile: size, results: out, cpus: os.cpus().length };
}

/** E. Overlapping and concurrent uploads must never store a row twice. */
async function dedupe() {
  const masterSize = QUICK ? 600 : 3_000;
  const windows = QUICK ? 6 : 20;
  log('E. dedupe', { masterSize, windows });
  await reset();
  const stop = await startWorkers(4);
  const api = await startApi();
  try {
    const master = generate(masterSize, 4_242);
    const rand = rng(77);
    const covered = new Set<number>();
    const slices: Row[][] = [];
    for (let i = 0; i < windows; i++) {
      const len = Math.floor(masterSize * (0.1 + rand() * 0.2));
      const start = i === 0 ? 0 : i === windows - 1 ? masterSize - len : Math.floor(rand() * (masterSize - len));
      slices.push(master.slice(start, start + len));
      for (let k = start; k < start + len; k++) covered.add(k);
    }
    const a = await newAccount();
    const url = `${api.base}/accounts/${a.accountId}/imports`;

    // 1) all overlapping windows uploaded at once
    const ups = await Promise.all(slices.map((s, i) => upload(url, a.cookie, toCsv(s), `w${i}.csv`)));
    await waitAll(ups.map((u) => u.body.importId!));
    const submitted = slices.reduce((s, x) => s + x.length, 0);
    const stored = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM transactions WHERE account_id = $1`, [a.accountId])).rows[0]!.n);
    const semanticDupes = Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM (SELECT 1 FROM transactions WHERE account_id = $1
             GROUP BY txn_date, narration, debit_paise, credit_paise, balance_paise HAVING count(*) > 1) d`,
          [a.accountId],
        )
      ).rows[0]!.n,
    );

    // 2) new, different files whose rows were all imported before (sub-ranges of uploaded windows)
    const replays = Array.from({ length: Math.ceil(windows / 2) }, (_, i) => {
      const src = slices[i]!;
      const len = Math.min(src.length - 1, 50 + i);
      const start = 1 + Math.floor(rand() * (src.length - len - 1));
      return src.slice(start, start + len);
    });
    const rUps = await Promise.all(replays.map((s, i) => upload(url, a.cookie, toCsv(s), `r${i}.csv`)));
    await waitAll(rUps.map((u) => u.body.importId!));
    const replayInserted = Number(
      (await db.query<{ n: string }>(`SELECT coalesce(sum(rows_inserted), 0) AS n FROM imports WHERE id = ANY($1::bigint[])`, [rUps.map((u) => u.body.importId!)])).rows[0]!.n,
    );

    // 3) the same file 10x in parallel
    const b = await newAccount();
    const same = toCsv(slices[0]!);
    const sameUps = await Promise.all(Array.from({ length: 10 }, () => upload(`${api.base}/accounts/${b.accountId}/imports`, b.cookie, same, 'same.csv')));
    const importsCreated = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM imports WHERE account_id = $1`, [b.accountId])).rows[0]!.n);

    results.dedupe = {
      windows,
      rowsSubmitted: submitted,
      uniqueRowsExpected: covered.size,
      rowsStored: stored,
      duplicateRowsStored: stored - covered.size + semanticDupes,
      replayFiles: replays.length,
      replayRowsInserted: replayInserted,
      sameFileParallelUploads: 10,
      importsCreatedForSameFile: importsCreated,
      sameFileStatuses: sameUps.map((u) => u.status).sort(),
    };
    log('  ', results.dedupe);
  } finally {
    await api.stop();
    await stop();
  }
}

/** F. Rows removed from the middle of statements must show up as balance breaks, with the right amount. */
async function gapDetection() {
  const statements = QUICK ? 10 : 100;
  const size = 500;
  const clean = QUICK ? 5 : 20;
  log('F. gap detection', { statements, size, clean });
  await reset();
  const stop = await startWorkers(4);
  const api = await startApi();
  try {
    const a = await newAccount();
    const url = `${api.base}/accounts/${a.accountId}/imports`;
    const rand = rng(99);
    type Case = { id?: string; expected: number[] };
    const cases: Case[] = [];
    const uploads: Promise<void>[] = [];
    let droppedRows = 0;
    for (let s = 0; s < statements + clean; s++) {
      const rows = generate(size, 5_000 + s);
      const drop = new Set<number>();
      if (s < statements) {
        const k = 1 + Math.floor(rand() * 5);
        // interior rows only: the first/last row anchors the derived opening/closing balance
        while (drop.size < k) drop.add(1 + Math.floor(rand() * (size - 2)));
      }
      droppedRows += drop.size;
      // expected break amount per run of consecutive dropped rows: sum(credit - debit)
      const expected: number[] = [];
      let run: number | null = null;
      for (let i = 0; i < size; i++) {
        if (drop.has(i)) run = (run ?? 0) + rows[i]!.creditPaise - rows[i]!.debitPaise;
        else if (run !== null) {
          expected.push(run);
          run = null;
        }
      }
      const c: Case = { expected };
      cases.push(c);
      uploads.push(upload(url, a.cookie, toCsv(rows.filter((_, i) => !drop.has(i))), `g${s}.csv`).then((u) => void (c.id = u.body.importId)));
    }
    await Promise.all(uploads);
    await waitAll(cases.map((c) => c.id!));

    let gaps = 0;
    let detected = 0;
    let exact = 0;
    let falsePositives = 0;
    for (const c of cases) {
      const { rows } = await db.query<{ diff_paise: string }>(`SELECT diff_paise FROM reconciliation_breaks WHERE import_id = $1`, [c.id]);
      const found = rows.map((r) => Number(r.diff_paise));
      gaps += c.expected.length;
      const pool = [...found];
      for (const e of c.expected) {
        if (pool.length) detected++;
        const j = pool.indexOf(e);
        if (j >= 0) {
          exact++;
          pool.splice(j, 1);
        } else pool.shift();
      }
      falsePositives += pool.length;
    }
    results.gapDetection = { statements, cleanStatements: clean, rowsPerStatement: size, droppedRows, gaps, detected, exactAmount: exact, falsePositives };
    log('  ', results.gapDetection);
  } finally {
    await api.stop();
    await stop();
  }
}

/** G. The test suite against the same real servers, with coverage. */
function testSuite() {
  log('G. test suite + coverage');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=text-summary', '--coverage.include=src/**'], {
    cwd: ROOT,
    env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL, REDIS_URL },
    encoding: 'utf8',
  });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  const line = /^\s*Tests\s+(.*)$/m.exec(out)?.[1] ?? '';
  const count = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  const summaryFile = path.join(ROOT, 'coverage/coverage-summary.json');
  const cov = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')).total : null;
  results.tests = {
    passed: count('passed'),
    skipped: count('skipped'),
    failed: count('failed'),
    coverage: cov && { lines: cov.lines.pct, statements: cov.statements.pct, functions: cov.functions.pct, branches: cov.branches.pct },
  };
  log('  ', results.tests);
}

// ---------------------------------------------------------------------------- report

async function environment() {
  const pgVersion = (await db.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0]!.v;
  const redisVersion = /redis_version:(\S+)/.exec(await redis.info('server'))?.[1];
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  return {
    date: new Date().toISOString().slice(0, 10),
    commit,
    cpu: `${os.cpus()[0]!.model.trim()} (${os.cpus().length} threads)`,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    postgres: pgVersion,
    redis: redisVersion,
    quick: QUICK,
  };
}

function report(env: Record<string, unknown>): string {
  const r = results as any;
  const L: string[] = [];
  L.push('# Benchmarks', '');
  L.push(`Generated by \`npm run bench\` on ${env.date} (commit \`${env.commit}\`). Every number below comes from that run; re-run it to reproduce.`, '');
  L.push('| Environment | |', '|---|---|');
  L.push(`| CPU | ${env.cpu} |`, `| Memory | ${env.memoryGb} GB |`, `| OS | ${env.os} |`, `| Node | ${env.node} |`);
  L.push(`| Postgres | ${env.postgres} (Docker, default config) |`, `| Redis | ${env.redis} (Docker) |`, '');
  L.push('Postgres, Redis, the API and the workers all share one laptop, so absolute numbers are conservative. Data is synthetic HDFC-format CSV (`bench/statements.ts`); medians of repeated runs are reported, after warm-up.', '');

  if (r.throughput) {
    L.push('## Ingest throughput (1 worker)', '', 'Time from upload request to import `done`: upload, queue, parse, fingerprint, categorize, reconcile, write.', '');
    L.push('| Rows in statement | Median time | Rows / second |', '|---:|---:|---:|');
    for (const t of r.throughput) L.push(`| ${fmt(t.rows)} | ${fmt(t.medianMs)} ms | ${fmt(t.rowsPerSec)} |`);
    L.push('');
  }
  if (r.uploadLatency) {
    const u = r.uploadLatency;
    L.push('## Upload response time', '', `Time for \`POST /accounts/:id/imports\` to answer, ${fmt(u.rows)}-row statement, ${u.async.samples} sequential uploads each. "Synchronous" is the same staging and \`processImport\` awaited inside the request (a bench-only route), i.e. the design without a queue.`, '');
    L.push('| Design | p50 | p95 |', '|---|---:|---:|');
    L.push(`| Async (stage + enqueue, 202) | ${u.async.p50} ms | ${u.async.p95} ms |`);
    L.push(`| Synchronous (process in request) | ${u.sync.p50} ms | ${u.sync.p95} ms |`);
    L.push('', `**${u.speedupP50}× faster** response at p50.`, '');
  }
  if (r.bulkInsert) {
    const b = r.bulkInsert;
    L.push('## Batched writes', '', `Full \`processImport\` time for a ${fmt(b.rows)}-row statement (same parsing work in both; only the INSERT strategy differs).`, '');
    L.push('| Strategy | Median time |', '|---|---:|');
    for (const [k, v] of Object.entries(b.variants as Record<string, any>)) L.push(`| ${k} | ${fmt(v.medianMs)} ms |`);
    L.push('', `**${b.speedup}× faster (${b.reductionPct}% less time)** with multi-row INSERTs.`, '');
  }
  if (r.workerScaling) {
    const w = r.workerScaling;
    L.push('## Worker scaling', '', `${w.files} statements × ${fmt(w.rowsPerFile)} rows uploaded at once; time until all are \`done\`. Each worker is a separate process (concurrency 1).`, '');
    L.push('| Workers | Time | Rows / second | Speedup |', '|---:|---:|---:|---:|');
    for (const x of w.results) L.push(`| ${x.workers} | ${fmt(x.ms)} ms | ${fmt(x.rowsPerSec)} | ${x.speedup}× |`);
    L.push('');
  }
  if (r.dedupe) {
    const d = r.dedupe;
    L.push('## Deduplication', '');
    L.push(`- ${d.windows} overlapping statements cut from one history, uploaded **concurrently** (4 workers): ${fmt(d.rowsSubmitted)} rows submitted, ${fmt(d.uniqueRowsExpected)} unique, **${fmt(d.rowsStored)} stored, ${d.duplicateRowsStored} duplicates**.`);
    L.push(`- ${d.replayFiles} new files covering already-imported history: **${d.replayRowsInserted} rows inserted**.`);
    L.push(`- The same file uploaded ${d.sameFileParallelUploads}× in parallel: **${d.importsCreatedForSameFile} import created** (statuses: ${d.sameFileStatuses.join(', ')}).`, '');
  }
  if (r.gapDetection) {
    const g = r.gapDetection;
    L.push('## Missing-transaction detection', '');
    L.push(`${g.statements} statements × ${g.rowsPerStatement} rows with 1–5 random interior rows removed (${g.droppedRows} rows, ${g.gaps} gaps), plus ${g.cleanStatements} untouched statements.`, '');
    L.push(`- Gaps detected: **${g.detected} / ${g.gaps}**`, `- Gaps where the reported missing amount was exact to the paisa: **${g.exactAmount} / ${g.gaps}**`, `- False alarms: **${g.falsePositives}**`);
    L.push('', 'Limitation: a missing *first* or *last* row can\'t be detected, because the statement\'s opening/closing balance is derived from those rows. Uploading an overlapping statement covers it.', '');
  }
  if (r.tests) {
    const t = r.tests;
    L.push('## Test suite', '', `${t.passed} tests passed, ${t.skipped} skipped, ${t.failed} failed, against the same Postgres and Redis (plus PGlite and in-memory stores).`);
    if (t.coverage) L.push('', `Coverage of \`src/\`: ${t.coverage.lines}% lines, ${t.coverage.branches}% branches, ${t.coverage.functions}% functions.`);
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  const only = process.argv.slice(2);
  const all: [string, () => Promise<void> | void][] = [
    ['throughput', throughput],
    ['latency', uploadLatency],
    ['insert', bulkInsert],
    ['scaling', workerScaling],
    ['dedupe', dedupe],
    ['gaps', gapDetection],
    ['tests', testSuite],
  ];
  const env = await environment();
  for (const [name, fn] of all) if (!only.length || only.includes(name)) await fn();
  await reset();
  mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  writeFileSync(path.join(ROOT, 'bench/results.json'), JSON.stringify({ env, results }, null, 2) + '\n');
  writeFileSync(path.join(ROOT, 'docs/BENCHMARKS.md'), report(env));
  log('wrote docs/BENCHMARKS.md and bench/results.json');
  await pool.end();
  redis.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
