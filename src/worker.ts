import { Pool } from 'pg';
import { pgDb } from './db/db';
import { migrate } from './db/migrate';
import { importHandlers, requeueStaleImports } from './import/importService';
import { PostgresRepository } from './import/postgresRepository';
import { logger } from './logger';
import { BullMqQueue } from './queue/bullmqQueue';

const { DATABASE_URL, REDIS_URL } = process.env;
if (!DATABASE_URL || !REDIS_URL) throw new Error('worker needs DATABASE_URL and REDIS_URL');

const db = pgDb(new Pool({ connectionString: DATABASE_URL }));
const repo = new PostgresRepository(db);
const queue = new BullMqQueue({ redisUrl: REDIS_URL, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });

// Recover imports whose enqueue was lost (API crashed after saving, Redis was down, ...).
const STALE_MS = 5 * 60_000;
const sweep = () =>
  requeueStaleImports(repo, queue, STALE_MS)
    .then((n) => n && logger.warn({ count: n }, 'sweeper re-enqueued stale imports'))
    .catch((e) => logger.error({ err: e }, 'sweeper failed'));
let timer: NodeJS.Timeout | undefined;

// The schema must be current before the first job touches it (no-op when the API already migrated).
migrate(db)
  .then(() => {
    queue.start(importHandlers(repo));
    logger.info({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) }, 'worker started');
    void sweep();
    timer = setInterval(sweep, 60_000);
  })
  .catch((e) => {
    logger.fatal({ err: e }, 'startup failed');
    process.exit(1);
  });

const shutdown = async () => {
  clearInterval(timer);
  await queue.close(); // lets in-flight jobs finish
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
