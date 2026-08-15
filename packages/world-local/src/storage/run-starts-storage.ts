import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import { lock } from 'proper-lockfile';
import { monotonicFactory } from 'ulid';

export interface ReserveRunStartRequest {
  idempotencyKey: string;
  startShapeDigest: string;
  workflowName: string;
  deploymentId: string;
  namespace?: string;
  region?: string;
  specVersion: number;
}

export interface RunStartReservation {
  reservationId: string;
  runId: string;
  startShapeDigest: string;
  inserted: boolean;
}

export interface FinalizeRunStartRequest {
  reservationId: string;
  runId: string;
  semanticDigest: string;
  envelopeIntegrityDigest: string;
  envelope: unknown;
  queueName: string;
  queuePayload: unknown;
  queueOptions: unknown;
}

export interface FinalizedRunStart {
  inserted: boolean;
  runId: string;
  semanticDigest: string;
  envelopeIntegrityDigest: string;
  messageId: string;
  dispatchState: 'pending' | 'acknowledged';
}

export interface PendingRunStartDispatch {
  runId: string;
  messageId: string;
  envelope: unknown;
  queueName: string;
  queuePayload: unknown;
  queueOptions: unknown;
}

export interface RunStartDrivers {
  materialize(entry: PendingRunStartDispatch): Promise<void>;
  dispatch(
    entry: PendingRunStartDispatch,
    accepted: () => Promise<void>
  ): Promise<void>;
}

interface Ledger {
  version: 1;
  startShape: string;
  reservationId: string;
  runId: string;
  startShapeDigest: string;
  finalization?: {
    semanticDigest: string;
    envelopeIntegrityDigest: string;
    envelope: unknown;
    queueName: string;
    queuePayload: unknown;
    queueOptions: unknown;
    messageId: string;
    dispatchState: 'pending' | 'acknowledged';
  };
}

const ulid = monotonicFactory();

function conflict(message: string): WorkflowWorldError {
  return new WorkflowWorldError(`idempotency_conflict: ${message}`);
}

function assertLedger(value: unknown): asserts value is Ledger {
  const ledger = value as Partial<Ledger>;
  const finalized = ledger.finalization;
  if (
    !ledger ||
    ledger.version !== 1 ||
    typeof ledger.startShape !== 'string' ||
    typeof ledger.reservationId !== 'string' ||
    typeof ledger.runId !== 'string' ||
    typeof ledger.startShapeDigest !== 'string' ||
    (finalized !== undefined &&
      (typeof finalized.semanticDigest !== 'string' ||
        typeof finalized.envelopeIntegrityDigest !== 'string' ||
        typeof finalized.queueName !== 'string' ||
        typeof finalized.messageId !== 'string' ||
        (finalized.dispatchState !== 'pending' &&
          finalized.dispatchState !== 'acknowledged')))
  ) {
    throw new WorkflowWorldError('corrupt run-start ledger');
  }
}

function canonicalStartShape(request: ReserveRunStartRequest): string {
  return JSON.stringify({
    deploymentId: request.deploymentId,
    namespace: request.namespace ?? null,
    region: request.region ?? null,
    specVersion: request.specVersion,
    workflowName: request.workflowName,
  });
}

function ledgerPath(basedir: string, key: string): string {
  const name = createHash('sha256').update(key).digest('hex');
  return path.join(basedir, 'run-starts', `${name}.json`);
}

async function writeLedger(file: string, value: Ledger): Promise<void> {
  const temp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file);
}

async function withLedgerFile<T>(
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
      current = JSON.parse(await fs.readFile(file, 'utf8')) as Ledger;
      assertLedger(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return await fn(file, current);
  } finally {
    await release();
  }
}

function withLedger<T>(
  basedir: string,
  key: string,
  fn: (file: string, current: Ledger | undefined) => Promise<T>
): Promise<T> {
  return withLedgerFile(ledgerPath(basedir, key), fn);
}

export function createRunStartsStorage(
  basedir: string,
  drivers?: RunStartDrivers
) {
  return {
    reserveOrAdoptRunStart: async (
      request: ReserveRunStartRequest
    ): Promise<RunStartReservation> => {
      const startShape = canonicalStartShape(request);
      return withLedger(
        basedir,
        request.idempotencyKey,
        async (file, current) => {
          if (current) {
            if (
              current.version !== 1 ||
              current.startShape !== startShape ||
              current.startShapeDigest !== request.startShapeDigest
            ) {
              throw conflict('run start key was reused with a different shape');
            }
            return {
              reservationId: current.reservationId,
              runId: current.runId,
              startShapeDigest: current.startShapeDigest,
              inserted: false,
            };
          }
          const ledger: Ledger = {
            version: 1,
            startShape,
            reservationId: `rsv_${ulid()}`,
            runId: `wrun_${ulid()}`,
            startShapeDigest: request.startShapeDigest,
          };
          await writeLedger(file, ledger);
          return {
            reservationId: ledger.reservationId,
            runId: ledger.runId,
            startShapeDigest: ledger.startShapeDigest,
            inserted: true,
          };
        }
      );
    },

    finalizeOrAdoptRunStart: async (
      request: FinalizeRunStartRequest
    ): Promise<FinalizedRunStart> => {
      // A reservation id is opaque. Locate its ledger under the directory and
      // then take that ledger's lock before accepting finalization.
      const matching = await Promise.all(
        (await fs.readdir(path.join(basedir, 'run-starts')))
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const full = path.join(basedir, 'run-starts', name);
            return {
              full,
              value: JSON.parse(await fs.readFile(full, 'utf8')) as Ledger,
            };
          })
      );
      const found = matching.find(
        ({ value }) => value.reservationId === request.reservationId
      );
      if (!found) throw new WorkflowWorldError('Unknown run-start reservation');
      return withLedgerFile(found.full, async (ledgerFile, current) => {
        if (
          !current ||
          current.reservationId !== request.reservationId ||
          current.runId !== request.runId
        ) {
          throw conflict('reservation does not own this run');
        }
        if (current.finalization) {
          if (current.finalization.semanticDigest !== request.semanticDigest) {
            throw conflict(
              'run start key was reused with a different semantic envelope'
            );
          }
          return {
            inserted: false,
            runId: current.runId,
            semanticDigest: current.finalization.semanticDigest,
            envelopeIntegrityDigest:
              current.finalization.envelopeIntegrityDigest,
            messageId: current.finalization.messageId,
            dispatchState: current.finalization.dispatchState,
          };
        }
        current.finalization = {
          semanticDigest: request.semanticDigest,
          envelopeIntegrityDigest: request.envelopeIntegrityDigest,
          envelope: request.envelope,
          queueName: request.queueName,
          queuePayload: request.queuePayload,
          queueOptions: request.queueOptions,
          messageId: `msg_${ulid()}`,
          dispatchState: 'pending',
        };
        await writeLedger(ledgerFile, current);
        return {
          inserted: true,
          runId: current.runId,
          semanticDigest: current.finalization.semanticDigest,
          envelopeIntegrityDigest: current.finalization.envelopeIntegrityDigest,
          messageId: current.finalization.messageId,
          dispatchState: current.finalization.dispatchState,
        };
      });
    },

    pendingDispatches: async (): Promise<PendingRunStartDispatch[]> => {
      const directory = path.join(basedir, 'run-starts');
      let names: string[];
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const ledgers = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const ledger = JSON.parse(
              await fs.readFile(path.join(directory, name), 'utf8')
            ) as Ledger;
            assertLedger(ledger);
            return ledger;
          })
      );
      return ledgers.flatMap((ledger) => {
        const finalization = ledger.finalization;
        if (!finalization || finalization.dispatchState !== 'pending')
          return [];
        return [
          {
            runId: ledger.runId,
            messageId: finalization.messageId,
            envelope: finalization.envelope,
            queueName: finalization.queueName,
            queuePayload: finalization.queuePayload,
            queueOptions: finalization.queueOptions,
          },
        ];
      });
    },

    acknowledgeDispatch: async (messageId: string): Promise<void> => {
      const directory = path.join(basedir, 'run-starts');
      const names = await fs.readdir(directory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        const file = path.join(directory, name);
        const initial = JSON.parse(await fs.readFile(file, 'utf8')) as Ledger;
        assertLedger(initial);
        if (initial.finalization?.messageId !== messageId) continue;
        await withLedgerFile(file, async (ledgerFile, current) => {
          if (
            !current?.finalization ||
            current.finalization.messageId !== messageId
          ) {
            return;
          }
          if (current.finalization.dispatchState === 'acknowledged') return;
          current.finalization.dispatchState = 'acknowledged';
          await writeLedger(ledgerFile, current);
        });
        return;
      }
      throw new WorkflowWorldError('Unknown run-start dispatch');
    },

    drain: async (): Promise<void> => {
      if (!drivers) return;
      for (const entry of await (async () => {
        const directory = path.join(basedir, 'run-starts');
        try {
          const names = await fs.readdir(directory);
          const ledgers = await Promise.all(
            names
              .filter((name) => name.endsWith('.json'))
              .map(async (name) => {
                const ledger = JSON.parse(
                  await fs.readFile(path.join(directory, name), 'utf8')
                ) as Ledger;
                assertLedger(ledger);
                return ledger;
              })
          );
          return ledgers.flatMap((ledger) => {
            const finalization = ledger.finalization;
            return finalization?.dispatchState === 'pending'
              ? [
                  {
                    runId: ledger.runId,
                    messageId: finalization.messageId,
                    envelope: finalization.envelope,
                    queueName: finalization.queueName,
                    queuePayload: finalization.queuePayload,
                    queueOptions: finalization.queueOptions,
                  },
                ]
              : [];
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      })()) {
        await drivers.materialize(entry);
        await drivers.dispatch(entry, () =>
          createRunStartsStorage(basedir).acknowledgeDispatch(entry.messageId)
        );
      }
    },
  };
}
