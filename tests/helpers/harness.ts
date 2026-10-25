import { Pool } from 'pg';
import request from 'supertest';
import { pgDb, type Db } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import { createApp } from '../../src/app';
import { PostgresAuthStore } from '../../src/auth/postgresStore';
import { InMemoryAuthStore, type AuthStore } from '../../src/auth/store';
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

const TRUNCATE =
  'TRUNCATE users, sessions, accounts, imports, raw_rows, transactions, merchant_overrides, reconciliation_breaks RESTART IDENTITY CASCADE';

/** Postgres-backed repos get a Postgres auth store on the same database (accounts are FK targets). */
const authByRepo = new WeakMap<Repository, AuthStore>();
function postgresPair(db: Db): Repository {
  const repo = new PostgresRepository(db);
  authByRepo.set(repo, new PostgresAuthStore(db));
  return repo;
}

// One PGlite engine shared by the whole test file; tables are truncated between tests.
let shared: Db | undefined;
export async function freshPostgresRepo(): Promise<Repository> {
  shared ??= await pgliteDb();
  await shared.query(TRUNCATE);
  return postgresPair(shared);
}

// Optional: the same suite against a real server. TEST_DATABASE_URL is migrated on first use and
// its tables are truncated between tests: never point it at data you care about.
let realDb: Db | undefined;
async function freshRealPostgresRepo(): Promise<Repository> {
  if (!realDb) {
    realDb = pgDb(new Pool({ connectionString: process.env.TEST_DATABASE_URL }));
    await migrate(realDb);
  }
  await realDb.query(TRUNCATE);
  return postgresPair(realDb);
}

export const stores: [string, () => Promise<Repository>][] = [
  ['in-memory', async () => new InMemoryRepository()],
  ['postgres (PGlite)', freshPostgresRepo],
  ...(process.env.TEST_DATABASE_URL
    ? ([['postgres (real server)', freshRealPostgresRepo]] as [string, () => Promise<Repository>][])
    : []),
];

export const PASSWORD = 'correct horse battery';

/** Registers a user (which creates their first account, id 1 in a fresh store) and returns a cookie-carrying client. */
export async function signIn(app: ReturnType<typeof createApp>, email = 'me@example.com'): Promise<request.Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export interface Harness {
  repo: Repository;
  auth: AuthStore;
  queue: InProcessQueue;
  app: ReturnType<typeof createApp>;
  /** Signed in as the owner of account 1. Use `request(h.app)` for anonymous calls. */
  api: request.Agent;
  /** POST a file; returns the HTTP response only (job may still be running). */
  upload(file: Buffer, name?: string): request.Test;
  /** POST a file, wait for the queue to drain, then return the final import status. */
  uploadAndWait(file: Buffer, name?: string): Promise<{ post: request.Response; status: any }>;
  status(importId: string): Promise<any>;
}

export async function makeHarness(
  repo: Repository,
  opts: { startWorker?: boolean; retry?: Partial<RetryPolicy>; workerRepo?: Repository; auth?: AuthStore } = {},
): Promise<Harness> {
  const auth = opts.auth ?? authByRepo.get(repo) ?? new InMemoryAuthStore();
  const queue = new InProcessQueue({ attempts: 3, baseDelayMs: 1, ...opts.retry });
  if (opts.startWorker !== false) queue.start(importHandlers(opts.workerRepo ?? repo));
  const app = createApp({ repo, queue, auth });
  const api = await signIn(app);

  const upload = (file: Buffer, name = 'a.csv') => api.post('/accounts/1/imports').attach('file', file, name);
  const status = async (importId: string) => (await api.get(`/accounts/1/imports/${importId}`)).body;
  return {
    repo,
    auth,
    queue,
    app,
    api,
    upload,
    status,
    async uploadAndWait(file, name) {
      const post = await upload(file, name);
      await queue.idle();
      return { post, status: post.body.importId ? await status(post.body.importId) : null };
    },
  };
}
