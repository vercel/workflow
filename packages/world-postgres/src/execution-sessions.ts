import { randomUUID } from 'node:crypto';
import { RunExpiredError } from '@workflow/errors';
import {
  type ExecutionInput,
  ExecutionInvariantError,
  type ExecutionSession,
} from '@workflow/world';
import type { Pool, PoolClient } from 'pg';
import type { ExecutionStore } from './execution-store.js';

type Session = {
  ownerId: string;
  runtime: ExecutionSession;
  lock: PoolClient;
  users: number;
  pending: Set<string>;
  closing?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  polling: boolean;
  lost: boolean;
  faulted: boolean;
  onError(error: Error): void;
};

/** Session-level locks exclude concurrent hosts; durable grants detect unclean loss. */
export class ExecutionSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly acquiring = new Map<string, Promise<Session>>();
  private closed = false;

  constructor(
    private readonly store: ExecutionStore,
    private readonly locks: Pool
  ) {
    locks.on('error', (error) =>
      console.error('Idle execution connection failed:', error.message)
    );
  }

  ownerId(runId: string): string {
    const entry = this.sessions.get(runId);
    if (!entry || entry.lost || entry.faulted || entry.closing)
      throw new ExecutionInvariantError('No live execution grant');
    return entry.ownerId;
  }

  private key(runId: string) {
    return JSON.stringify([this.store.namespace, runId]);
  }

  private async acquire(
    runId: string,
    factory: (id: string) => ExecutionSession
  ): Promise<Session> {
    if (this.closed) throw new Error('Execution World is closed');
    const active = this.sessions.get(runId);
    if (active?.closing) {
      await active.closing;
      return this.acquire(runId, factory);
    }
    if (active) {
      active.users++;
      return active;
    }
    let acquiring = this.acquiring.get(runId);
    if (!acquiring) {
      acquiring = (async () => {
        const lock = await this.locks.connect();
        try {
          const result = await lock.query(
            'SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS acquired',
            [this.key(runId)]
          );
          if (!result.rows[0].acquired)
            throw new Error('Execution is busy in another process');
          const ownerId = randomUUID();
          await this.store.claim(lock, runId, ownerId);
          const entry: Session = {
            ownerId,
            lock,
            runtime: factory(runId),
            users: 0,
            pending: new Set(),
            polling: false,
            lost: false,
            faulted: false,
            onError: (error) => {
              entry.lost = true;
              void this.invalidate(entry, error).catch((failure) =>
                console.error('Execution invalidation failed:', String(failure))
              );
            },
          };
          lock.on('error', entry.onError);
          this.sessions.set(runId, entry);
          return entry;
        } catch (error) {
          lock.release(true);
          throw error;
        }
      })().finally(() => {
        this.acquiring.delete(runId);
      });
      this.acquiring.set(runId, acquiring);
    }
    const entry = await acquiring;
    if (entry.closing) {
      await entry.closing;
      return this.acquire(runId, factory);
    }
    entry.users++;
    return entry;
  }

  private async invalidate(entry: Session, error: unknown) {
    if (entry.faulted) return;
    entry.faulted = true;
    clearInterval(entry.timer);
    await entry.runtime.invalidate(
      error instanceof Error ? error : new Error(String(error))
    );
  }

  private async releaseUser(runId: string, entry: Session) {
    entry.users--;
    if (entry.users !== 0 || entry.closing) return;
    clearInterval(entry.timer);
    entry.closing = (async () => {
      try {
        if (!entry.lost) {
          await this.store.release(entry.lock, runId, entry.ownerId);
          await entry.lock.query(
            'SELECT pg_advisory_unlock(hashtextextended($1,1))',
            [this.key(runId)]
          );
        }
      } catch (error) {
        entry.lost = true;
        throw error;
      } finally {
        this.sessions.delete(runId);
        entry.lock.removeListener('error', entry.onError);
        entry.lock.release(entry.lost);
      }
    })();
    await entry.closing;
  }

  private async receive(runId: string, entry: Session, input?: ExecutionInput) {
    if (input && entry.pending.has(input.operationId)) return;
    entry.users++;
    if (input) entry.pending.add(input.operationId);
    try {
      await entry.runtime.receive(input);
    } finally {
      if (input) entry.pending.delete(input.operationId);
      await this.releaseUser(runId, entry);
    }
  }

  private async poll(runId: string, entry: Session) {
    if (entry.polling || entry.closing || entry.lost || entry.faulted) return;
    entry.polling = true;
    try {
      await this.store.snapshot(runId); // Notice durable quarantine from another caller.
      const inputs = await this.store.pending(runId);
      if (entry.closing || entry.lost) return;
      for (const input of inputs) {
        // Do not await a drive here: later inputs must still enter during a body.
        void this.receive(runId, entry, input)
          .catch(async (error) => {
            if (!RunExpiredError.is(error)) await this.invalidate(entry, error);
          })
          .catch((error) =>
            console.error('Execution inbox delivery failed:', String(error))
          );
      }
    } catch (error) {
      if (!entry.closing) await this.invalidate(entry, error);
    } finally {
      entry.polling = false;
    }
  }

  async run(runId: string, factory: (id: string) => ExecutionSession) {
    const entry = await this.acquire(runId, factory);
    // Hold a user reservation while loading inputs so another delivery cannot
    // release the grant between acquire and dispatch.
    try {
      const inputs = await this.store.pending(runId);
      if (!entry.timer)
        entry.timer = setInterval(() => {
          void this.poll(runId, entry).catch((error) =>
            console.error('Execution polling failed', error)
          );
        }, 25);
      const work = [
        ...inputs.map((input) => this.receive(runId, entry, input)),
        this.receive(runId, entry),
      ];
      const results = await Promise.allSettled(work);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      // Release the reservation through the same final-user cleanup path without
      // invoking another runtime turn.
      await this.releaseUser(runId, entry);
    }
  }

  async close() {
    this.closed = true;
    // Application-managed shutdown must stop HTTP ingress and await handlers.
    if (this.sessions.size || this.acquiring.size)
      throw new Error('Cannot close execution World with active sessions');
    await this.locks.end();
  }
}
