import { existsSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createApp } from './app';
import { PostgresAuthStore } from './auth/postgresStore';
import { InMemoryAuthStore, type AuthStore } from './auth/store';
import { pgDb } from './db/db';
import { migrate } from './db/migrate';
import { importHandlers } from './import/importService';
import { PostgresRepository } from './import/postgresRepository';
import { InMemoryRepository, type Repository } from './import/repository';
import { BullMqQueue } from './queue/bullmqQueue';
import { InProcessQueue, type JobQueue } from './queue/queue';

const port = Number(process.env.PORT ?? 3000);

/** "1" means one proxy hop (a number to Express); anything else is passed through ("loopback", CIDRs). */
const trustProxySetting = (v: string | undefined) => (v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : v);
const { DATABASE_URL, REDIS_URL } = process.env;

if (REDIS_URL && !DATABASE_URL) {
  throw new Error('REDIS_URL requires DATABASE_URL: the worker is a separate process and must share storage');
}

const db = DATABASE_URL ? pgDb(new Pool({ connectionString: DATABASE_URL })) : null;
const repo: Repository = db ? new PostgresRepository(db) : new InMemoryRepository();
const auth: AuthStore = db ? new PostgresAuthStore(db) : new InMemoryAuthStore();

let queue: JobQueue;
if (REDIS_URL) {
  // API only enqueues. Run `npm run worker` (one or many) to process jobs.
  queue = new BullMqQueue({ redisUrl: REDIS_URL });
  console.log('queue: bullmq (start workers with `npm run worker`)');
} else {
  // No Redis: process jobs inside this process. Great for local dev.
  queue = new InProcessQueue();
  queue.start(importHandlers(repo));
  console.log('queue: in-process (set REDIS_URL + DATABASE_URL for a real worker setup)');
}
console.log(`storage: ${DATABASE_URL ? 'postgres' : 'in-memory'}`);

// Same path from src/ (tsx) and dist/ (build): the frontend build lives at <root>/web/dist.
const webDist = path.resolve(__dirname, '../web/dist');
const staticDir = existsSync(path.join(webDist, 'index.html')) ? webDist : undefined;
console.log(`frontend: ${staticDir ?? 'not built (run `npm run build` in web/, or use its dev server)'}`);

async function main() {
  // Safe with several API/worker processes starting at once: migrations run under an advisory lock.
  if (db) {
    const ran = await migrate(db);
    if (ran.length) console.log(`migrations applied: ${ran.join(', ')}`);
  }

  const server = createApp(
    { repo, queue, auth },
    {
      staticDir,
      // Behind HTTPS (or a TLS-terminating proxy) set COOKIE_SECURE=true and TRUST_PROXY=1.
      secureCookies: process.env.COOKIE_SECURE === 'true',
      trustProxy: trustProxySetting(process.env.TRUST_PROXY),
    },
  ).listen(port, () => console.log(`Checksum listening on :${port}`));

  process.on('SIGTERM', async () => {
    server.close();
    await queue.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('startup failed', e);
  process.exit(1);
});
