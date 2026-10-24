import { Pool } from 'pg';
import { pgDb } from './db/db';
import { importHandlers, requeueStaleImports } from './import/importService';
import { PostgresRepository } from './import/postgresRepository';
import { BullMqQueue } from './queue/bullmqQueue';

const { DATABASE_URL, REDIS_URL } = process.env;
if (!DATABASE_URL || !REDIS_URL) throw new Error('worker needs DATABASE_URL and REDIS_URL');

const repo = new PostgresRepository(pgDb(new Pool({ connectionString: DATABASE_URL })));
const queue = new BullMqQueue({ redisUrl: REDIS_URL, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
queue.start(importHandlers(repo));
console.log('worker started');

// Recover imports whose enqueue was lost (API crashed after saving, Redis was down, ...).
const STALE_MS = 5 * 60_000;
const sweep = () =>
  requeueStaleImports(repo, queue, STALE_MS)
    .then((n) => n && console.log(`sweeper re-enqueued ${n} stale import(s)`))
    .catch((e) => console.error('sweeper failed', e));
void sweep();
const timer = setInterval(sweep, 60_000);

const shutdown = async () => {
  clearInterval(timer);
  await queue.close(); // lets in-flight jobs finish
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
