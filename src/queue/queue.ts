import { PermanentError } from './errors';

export interface ImportJob {
  importId: string;
  accountId: string;
}

export interface JobHandlers {
  /** Throw to signal failure. Throw PermanentError to skip retries. */
  handle(job: ImportJob): Promise<void>;
  /** Called once when a job has failed for good (retries exhausted or PermanentError). */
  onDead(job: ImportJob, error: Error, attempts: number): Promise<void>;
}

export interface JobQueue {
  enqueue(job: ImportJob): Promise<void>;
  /** Begin processing. The API process may never call this; a separate worker process does. */
  start(handlers: JobHandlers): void | Promise<void>;
  close(): Promise<void>;
}

export interface RetryPolicy {
  attempts: number;
  /** Delay before retry n is baseDelayMs * 2^(n-1). */
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 1000 };

/**
 * In-process queue: same semantics as the BullMQ one (retries, exponential backoff,
 * no retry for PermanentError, dead-letter callback) without needing Redis.
 * Used for local dev without Redis and for fast deterministic tests.
 */
export class InProcessQueue implements JobQueue {
  private handlers: JobHandlers | null = null;
  private buffered: ImportJob[] = [];
  private inflight = new Set<string>();
  private pending = 0;
  private idleWaiters: (() => void)[] = [];
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;
  private readonly retry: RetryPolicy;

  constructor(retry: Partial<RetryPolicy> = {}) {
    this.retry = { ...DEFAULT_RETRY, ...retry };
  }

  async enqueue(job: ImportJob) {
    // Like BullMQ with jobId = importId: an import already in flight is not queued twice.
    if (this.inflight.has(job.importId)) return;
    this.inflight.add(job.importId);
    this.pending++;
    if (!this.handlers) this.buffered.push(job);
    else this.schedule(job, 1, 0);
  }

  start(handlers: JobHandlers) {
    this.handlers = handlers;
    for (const job of this.buffered.splice(0)) this.schedule(job, 1, 0);
  }

  /** Resolves when every enqueued job has finished or died. Handy in tests. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(job: ImportJob, attempt: number, delayMs: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.run(job, attempt);
    }, delayMs);
    this.timers.add(timer);
  }

  private async run(job: ImportJob, attempt: number) {
    if (this.closed || !this.handlers) return;
    try {
      await this.handlers.handle(job);
      this.finish(job);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err instanceof PermanentError || attempt >= this.retry.attempts) {
        try {
          await this.handlers.onDead(job, err, attempt);
        } catch {
          /* dead-letter handler failing must not wedge the queue */
        }
        this.finish(job);
      } else {
        this.schedule(job, attempt + 1, this.retry.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  private finish(job: ImportJob) {
    this.inflight.delete(job.importId);
    this.pending--;
    if (this.pending === 0) for (const w of this.idleWaiters.splice(0)) w();
  }
}
