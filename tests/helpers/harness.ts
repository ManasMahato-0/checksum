import { Pool } from 'pg';
import request from 'supertest';
import { pgDb, type Db } from '../../src/db/db';
import { createApp } from '../../src/app';
import { importHandlers } from '../../src/import/importService';
import { PostgresRepository } from '../../src/import/postgresRepository';
import { InMemoryRepository, type Repository } from '../../src/import/repository';
import { InProcessQueue, type RetryPolicy } from '../../src/queue/queue';
import { pgliteDb } from './pglite';

export const header = 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance';
export const L = {
  salary: '01/09/26,NEFT CR-HDFC0001234-ACME CORP SALARY-N100000000,N100000000,01/09/26,,60000.00,145000.00',
  swiggy: '02/09/26,UPI-SWIGGY-swiggy@axisbank-UTIB0000001-412345678901-Payment,412345678901,02/09/26,500.00,,144500.00',
  chai1: '03/09/26,UPI-RAMESH TEA STALL-ramesh@oksbi-UTIB0000001-412345678902-chai,412345678902,03/09/26,50.00,,144450.00',
  chai2: '03/09/26,UPI-RAMESH TEA STALL-ramesh@oksbi-UTIB0000001-412345678902-chai,412345678902,03/09/26,50.00,,144400.00',
  uber: '04/09/26,UPI-UBER INDIA-uber@hdfcbank-UTIB0000001-412345678903-ride,412345678903,04/09/26,250.00,,144150.00',
};
export const csv = (...lines: string[]) => Buffer.from([header, ...lines].join('\n'));

/** Wraps a repository so completeImport throws `failures` times first: a simulated DB blip. */
export function flaky(repo: Repository, failures: number): Repository {
  let left = failures;
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'completeImport') {
        return async (...args: Parameters<Repository['completeImport']>) => {
          if (left-- > 0) throw new Error('db blip');
          return target.completeImport(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// One PGlite engine shared by the whole test file; tables are truncated between tests.
let shared: Db | undefined;
export async function freshPostgresRepo(): Promise<Repository> {
  shared ??= await pgliteDb();
  await shared.query(
    'TRUNCATE accounts, imports, raw_rows, transactions, merchant_overrides, reconciliation_breaks RESTART IDENTITY CASCADE',
  );
  return new PostgresRepository(shared);
}

// Optional: the same suite against a real server. TEST_DATABASE_URL must point at a database
// that already has db/schema.sql applied (its tables are truncated between tests!).
let realDb: Db | undefined;
async function freshRealPostgresRepo(): Promise<Repository> {
  realDb ??= pgDb(new Pool({ connectionString: process.env.TEST_DATABASE_URL }));
  await realDb.query(
    'TRUNCATE accounts, imports, raw_rows, transactions, merchant_overrides, reconciliation_breaks RESTART IDENTITY CASCADE',
  );
  return new PostgresRepository(realDb);
}

export const stores: [string, () => Promise<Repository>][] = [
  ['in-memory', async () => new InMemoryRepository()],
  ['postgres (PGlite)', freshPostgresRepo],
  ...(process.env.TEST_DATABASE_URL
    ? ([['postgres (real server)', freshRealPostgresRepo]] as [string, () => Promise<Repository>][])
    : []),
];

export interface Harness {
  repo: Repository;
  queue: InProcessQueue;
  app: ReturnType<typeof createApp>;
  /** POST a file; returns the HTTP response only (job may still be running). */
  upload(file: Buffer, name?: string): request.Test;
  /** POST a file, wait for the queue to drain, then return the final import status. */
  uploadAndWait(file: Buffer, name?: string): Promise<{ post: request.Response; status: any }>;
  status(importId: string): Promise<any>;
}

export function makeHarness(
  repo: Repository,
  opts: { startWorker?: boolean; retry?: Partial<RetryPolicy>; workerRepo?: Repository } = {},
): Harness {
  const queue = new InProcessQueue({ attempts: 3, baseDelayMs: 1, ...opts.retry });
  if (opts.startWorker !== false) queue.start(importHandlers(opts.workerRepo ?? repo));
  const app = createApp(repo, queue);

  const upload = (file: Buffer, name = 'a.csv') => request(app).post('/accounts/1/imports').attach('file', file, name);
  const status = async (importId: string) => (await request(app).get(`/accounts/1/imports/${importId}`)).body;
  return {
    repo,
    queue,
    app,
    upload,
    status,
    async uploadAndWait(file, name) {
      const post = await upload(file, name);
      await queue.idle();
      return { post, status: post.body.importId ? await status(post.body.importId) : null };
    },
  };
}
