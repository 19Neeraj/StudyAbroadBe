import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env, isProduction, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Background jobs (spec §43, §48). Handlers register by name; producers call `enqueue`.
 *  - bullmq: Redis-backed queue with retries/backoff and repeatable jobs; workers run in-process
 *    (or in a separate worker process via the same `startWorkers`).
 *  - inline: in-process fallback for development without Redis and for tests (same retry semantics).
 * Heavy work (recordings, transcription, AI, report exports) must never run inside an API request.
 */
export interface JobOptions {
  attempts?: number;
  /** Base backoff in ms (exponential). */
  backoffMs?: number;
}
type Handler = (data: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, { run: Handler; opts: Required<JobOptions> }>();
const QUEUE = 'crm';
// BullMQ is opt-in outside production so a stray REDIS_URL without a running Redis can't break local dev.
const driver = env.JOBS_DRIVER ?? (isProduction && env.REDIS_URL ? 'bullmq' : 'inline');

let queue: Queue | undefined;
let worker: Worker | undefined;
const timers: NodeJS.Timeout[] = [];
const pending = new Set<Promise<void>>();

let redis: Redis | undefined;
/** BullMQ under native ESM needs a constructed ioredis client (shared by queue and worker). */
const connection = () => (redis ??= new Redis(env.REDIS_URL!, { maxRetriesPerRequest: null }));

export function registerJob<T extends Record<string, unknown>>(name: string, run: (data: T) => Promise<void>, opts: JobOptions = {}): void {
  handlers.set(name, { run: run as Handler, opts: { attempts: opts.attempts ?? 3, backoffMs: opts.backoffMs ?? 5_000 } });
}

async function runInline(name: string, data: Record<string, unknown>, attempt = 1): Promise<void> {
  const h = handlers.get(name);
  if (!h) return logger.error({ job: name }, 'No handler registered for job');
  try {
    await h.run(data);
  } catch (err) {
    if (attempt >= h.opts.attempts) return logger.error({ err, job: name }, 'Job failed permanently');
    logger.warn({ err, job: name, attempt }, 'Job failed; retrying');
    await new Promise((r) => setTimeout(r, isTest ? 1 : h.opts.backoffMs * 2 ** (attempt - 1)));
    return runInline(name, data, attempt + 1);
  }
}

export async function enqueue(name: string, data: Record<string, unknown>, opts: { delayMs?: number; jobId?: string } = {}): Promise<void> {
  if (driver === 'bullmq') {
    queue ??= new Queue(QUEUE, { connection: connection() });
    const h = handlers.get(name);
    await queue.add(name, data, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      delay: opts.delayMs,
      attempts: h?.opts.attempts ?? 3,
      backoff: { type: 'exponential', delay: h?.opts.backoffMs ?? 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    return;
  }
  const p = new Promise<void>((resolve) => {
    setTimeout(() => void runInline(name, data).finally(resolve), opts.delayMs ?? 0);
  });
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Tests: wait until inline jobs (including jobs they enqueue) have finished. */
export async function drainJobs(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** Recurring maintenance (reminders, retention cleanup). Not started in tests. */
export async function scheduleRepeating(name: string, everyMs: number): Promise<void> {
  if (isTest) return;
  if (driver === 'bullmq') {
    queue ??= new Queue(QUEUE, { connection: connection() });
    await queue.upsertJobScheduler(`repeat:${name}`, { every: everyMs }, { name, data: {} });
    return;
  }
  timers.push(setInterval(() => void runInline(name, {}), everyMs).unref());
}

export function startWorkers(): void {
  if (driver !== 'bullmq' || worker) return;
  worker = new Worker(
    QUEUE,
    async (job) => {
      const h = handlers.get(job.name);
      if (!h) throw new Error(`No handler for job ${job.name}`);
      await h.run(job.data as Record<string, unknown>);
    },
    { connection: connection(), concurrency: 5 },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.name, attempts: job?.attemptsMade }, 'Job failed'));
  logger.info('Background workers started (bullmq)');
}

export async function stopJobs(): Promise<void> {
  timers.forEach(clearInterval);
  await worker?.close();
  await queue?.close();
  redis?.disconnect();
}

export const jobsDriver = driver;
