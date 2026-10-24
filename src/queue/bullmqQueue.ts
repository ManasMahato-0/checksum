import { Queue, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { PermanentError } from './errors';
import { DEFAULT_RETRY, type ImportJob, type JobHandlers, type JobQueue, type RetryPolicy } from './queue';

const QUEUE_NAME = 'statement-imports';

export interface BullMqOptions {
  redisUrl: string;
  retry?: Partial<RetryPolicy>;
  concurrency?: number;
  /** Override for tests so several runs don't share a queue. */
  queueName?: string;
}

/**
 * BullMQ-backed queue.
 *  - jobId = "import-<importId>", so enqueueing the same import twice is a no-op.
 *  - Retries use exponential backoff; PermanentError becomes UnrecoverableError (no retries).
 *  - Jobs that exhaust retries stay in BullMQ's "failed" set (the dead-letter store) AND
 *    onDead fires so the import row is marked failed in Postgres.
 */
export class BullMqQueue implements JobQueue {
  private readonly queue: Queue<ImportJob>;
  private readonly connection: IORedis;
  private workerConnection: IORedis | null = null;
  private worker: Worker<ImportJob> | null = null;
  private readonly retry: RetryPolicy;
  private readonly name: string;

  constructor(private readonly opts: BullMqOptions) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.name = opts.queueName ?? QUEUE_NAME;
    // BullMQ requires maxRetriesPerRequest: null on connections used by workers.
    this.connection = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<ImportJob>(this.name, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: this.retry.attempts,
        backoff: { type: 'exponential', delay: this.retry.baseDelayMs },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 }, // keep failures a week for inspection
      },
    });
  }

  async enqueue(job: ImportJob) {
    // BullMQ rejects purely numeric custom ids, hence the prefix.
    await this.queue.add('import', job, { jobId: `import-${job.importId}` });
  }

  start(handlers: JobHandlers) {
    this.workerConnection = new IORedis(this.opts.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<ImportJob>(
      this.name,
      async (job) => {
        try {
          await handlers.handle(job.data);
        } catch (e) {
          if (e instanceof PermanentError) throw new UnrecoverableError(e.message);
          throw e;
        }
      },
      { connection: this.workerConnection, concurrency: this.opts.concurrency ?? 4 },
    );

    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const attempts = job.attemptsMade;
      const exhausted = attempts >= (job.opts.attempts ?? 1);
      if (err instanceof UnrecoverableError || exhausted) {
        handlers.onDead(job.data, err, attempts).catch((e) => console.error('onDead failed', e));
      }
    });
    this.worker.on('error', (err) => console.error('worker error', err));
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
    await this.workerConnection?.quit();
    await this.connection.quit();
  }
}
