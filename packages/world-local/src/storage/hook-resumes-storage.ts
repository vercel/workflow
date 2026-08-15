import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import type {
  CallerKeyedHookResumeRequest,
  CallerKeyedHookResumeResult,
  Hook,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
import { lock } from 'proper-lockfile';
import { monotonicFactory } from 'ulid';
import { jsonReplacer, jsonReviver } from '../fs.js';

interface Ledger {
  version: 1;
  semanticDigest: string;
  hook: Hook;
  eventData: unknown;
  queueName: string;
  queuePayload: unknown;
  queueOptions: unknown;
  resumePayloadDigest: string;
  resumeId: string;
  dispatchState: 'pending' | 'acknowledged';
}

export interface HookResumeDrivers {
  dispatch(entry: Ledger, accepted: () => Promise<void>): Promise<void>;
}

const ulid = monotonicFactory();

function conflict(message: string): WorkflowWorldError {
  return new WorkflowWorldError(`idempotency_conflict: ${message}`);
}

function assertLedger(value: unknown): asserts value is Ledger {
  const ledger = value as Partial<Ledger>;
  if (
    !ledger ||
    ledger.version !== 1 ||
    typeof ledger.semanticDigest !== 'string' ||
    !ledger.hook ||
    typeof ledger.hook.runId !== 'string' ||
    typeof ledger.hook.hookId !== 'string' ||
    typeof ledger.hook.token !== 'string' ||
    typeof ledger.queueName !== 'string' ||
    typeof ledger.resumePayloadDigest !== 'string' ||
    typeof ledger.resumeId !== 'string' ||
    (ledger.dispatchState !== 'pending' &&
      ledger.dispatchState !== 'acknowledged')
  ) {
    throw new WorkflowWorldError('corrupt hook-resume ledger');
  }
}

function ledgerPath(basedir: string, key: string): string {
  return path.join(
    basedir,
    'hook-resumes',
    `${createHash('sha256').update(key).digest('hex')}.json`
  );
}

async function writeLedger(file: string, ledger: Ledger): Promise<void> {
  const temp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(ledger, jsonReplacer));
  await fs.rename(temp, file);
}

async function withLedger<T>(
  file: string,
  fn: (file: string, current: Ledger | undefined) => Promise<T>
): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await lock(file, {
    realpath: false,
    stale: 30_000,
    update: 1_000,
    retries: { retries: 300, factor: 1, minTimeout: 10, maxTimeout: 10 },
  });
  try {
    let current: Ledger | undefined;
    try {
      current = JSON.parse(await fs.readFile(file, 'utf8'), jsonReviver);
      assertLedger(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return await fn(file, current);
  } finally {
    await release();
  }
}

function result(
  ledger: Ledger,
  inserted: boolean
): CallerKeyedHookResumeResult {
  return {
    inserted,
    semanticDigest: ledger.semanticDigest,
    hook: HookSchema.parse(ledger.hook),
  };
}

/** Durable receipt for a caller-owned continuation operation. */
export function createHookResumesStorage(
  basedir: string,
  drivers: HookResumeDrivers
) {
  async function acknowledge(file: string, resumeId: string): Promise<void> {
    await withLedger(file, async (ledgerFile, current) => {
      if (!current || current.resumeId !== resumeId) {
        throw new WorkflowWorldError('Unknown hook-resume dispatch');
      }
      if (current.dispatchState === 'acknowledged') return;
      current.dispatchState = 'acknowledged';
      await writeLedger(ledgerFile, current);
    });
  }

  async function dispatch(file: string, ledger: Ledger): Promise<void> {
    if (ledger.dispatchState === 'acknowledged') return;
    await drivers.dispatch(ledger, () => acknowledge(file, ledger.resumeId));
  }

  async function use(
    request: Pick<
      CallerKeyedHookResumeRequest,
      'idempotencyKey' | 'semanticDigest'
    >,
    create?: CallerKeyedHookResumeRequest
  ): Promise<CallerKeyedHookResumeResult | null> {
    const claimed = await withLedger(
      ledgerPath(basedir, request.idempotencyKey),
      async (file, current) => {
        let ledger = current;
        let inserted = false;
        if (ledger) {
          if (ledger.semanticDigest !== request.semanticDigest) {
            throw conflict(
              'hook resume key was reused with a different semantic payload'
            );
          }
        } else {
          if (!create) return null;
          ledger = {
            version: 1,
            semanticDigest: create.semanticDigest,
            hook: create.hook,
            eventData: create.eventData,
            queueName: create.queueName,
            queuePayload: create.queuePayload,
            queueOptions: create.queueOptions,
            resumePayloadDigest: create.resumePayloadDigest,
            resumeId: `rsm_${ulid()}`,
            dispatchState: 'pending',
          };
          await writeLedger(file, ledger);
          inserted = true;
        }
        return { file, ledger, inserted };
      }
    );
    if (!claimed) return null;
    await dispatch(claimed.file, claimed.ledger);
    return result(claimed.ledger, claimed.inserted);
  }

  return {
    async get(request: {
      idempotencyKey: string;
      semanticDigest: string;
    }): Promise<CallerKeyedHookResumeResult | null> {
      return use(request);
    },
    async resumeOrAdopt(
      request: CallerKeyedHookResumeRequest
    ): Promise<CallerKeyedHookResumeResult> {
      return (await use(request, request))!;
    },
    async drain(): Promise<void> {
      const directory = path.join(basedir, 'hook-resumes');
      const names = await fs.readdir(directory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        const file = path.join(directory, name);
        const current = await withLedger(
          file,
          async (_ledgerFile, ledger) => ledger
        );
        if (current) await dispatch(file, current);
      }
    },
  };
}
