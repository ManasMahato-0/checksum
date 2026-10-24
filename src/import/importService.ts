import { categorize } from '../categorize/categorizer';
import { fingerprintAll, sha256 } from '../dedupe/fingerprint';
import { parseNarration } from '../normalize/narration';
import { detectParser } from '../parsers/registry';
import { PermanentError } from '../queue/errors';
import type { JobHandlers, JobQueue } from '../queue/queue';
import { reconcile } from '../reconcile/reconcile';
import type { NewTxn, Repository } from './repository';

export type SubmitOutcome =
  | { status: 'queued'; importId: string }
  | { status: 'duplicate_file'; importId: string }
  | { status: 'unsupported_format' };

/**
 * API side: validate cheaply, stage the file durably, enqueue, return immediately.
 * Heavy parsing happens in the worker.
 */
export async function submitImport(
  repo: Repository,
  queue: JobQueue,
  accountId: string,
  filename: string,
  content: Buffer,
): Promise<SubmitOutcome> {
  // Reject obviously-unsupported files up front instead of failing asynchronously.
  if (!detectParser(content.toString('utf8'))) return { status: 'unsupported_format' };

  const pending = await repo.createPendingImport({ accountId, fileHash: sha256(content), filename, content });
  if (pending.duplicate) return { status: 'duplicate_file', importId: pending.importId };

  try {
    await queue.enqueue({ importId: pending.importId, accountId });
  } catch (e) {
    // The upload is already durable in the database; the stale-job sweeper will re-enqueue it.
    console.error(`enqueue failed for import ${pending.importId}; sweeper will retry`, e);
  }
  return { status: 'queued', importId: pending.importId };
}

/** Worker side: parse, dedupe, categorize, reconcile and persist one staged import. */
export async function processImport(repo: Repository, importId: string): Promise<void> {
  const claimed = await repo.claimImport(importId);
  if (!claimed) return; // already done/failed: a redelivered job is harmless

  const { accountId, content } = claimed;
  const text = content.toString('utf8');
  const parser = detectParser(text);
  if (!parser) throw new PermanentError('could not recognise this bank statement format');

  let parsed;
  try {
    parsed = parser.parse(text);
  } catch (e) {
    // Malformed content will be malformed on every retry.
    throw new PermanentError(`could not parse ${parser.bank} statement: ${(e as Error).message}`);
  }

  const fingerprints = fingerprintAll(accountId, parsed.transactions);
  const overrides = await repo.getOverrides(accountId);

  const txns: NewTxn[] = parsed.transactions.map((t, i) => {
    const info = parseNarration(t.narration);
    return {
      accountId,
      fingerprint: fingerprints[i]!,
      date: t.date,
      narration: t.narration,
      channel: info.channel,
      merchantKey: info.merchantKey,
      referenceNo: info.reference ?? t.refNo,
      debitPaise: t.debitPaise,
      creditPaise: t.creditPaise,
      balancePaise: t.balancePaise,
      category: categorize(info, overrides),
      raw: t,
    };
  });

  const reconciliation = reconcile(parsed.transactions, parsed.openingBalancePaise);
  await repo.completeImport({ importId, bank: parsed.bank, txns, reconciliation });
}

/** Wires a repository to a queue: what runs when a job is picked up, and when it dies. */
export function importHandlers(repo: Repository): JobHandlers {
  return {
    handle: (job) => processImport(repo, job.importId),
    onDead: (job, err) => repo.failImport(job.importId, err.message),
  };
}

/**
 * Safety net for crashes between "file saved" and "job enqueued" (or a lost Redis).
 * Re-enqueues anything unfinished for longer than `olderThanMs`. BullMQ's jobId = importId
 * makes re-adding a still-queued job a no-op.
 */
export async function requeueStaleImports(repo: Repository, queue: JobQueue, olderThanMs: number): Promise<number> {
  const stale = await repo.listStaleImports(olderThanMs);
  for (const s of stale) await queue.enqueue({ importId: s.id, accountId: s.accountId });
  return stale.length;
}
