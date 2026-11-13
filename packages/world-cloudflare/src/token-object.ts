/**
 * Cross-run hook indexes, one tiny object per key.
 *
 * - `token:<token>` owns a hook token: which `(runId, hookId)` holds it.
 * - `hook:<hookId>` maps a hook id to its run, for `hooks.get(hookId)`.
 *
 * Token ownership is decided here, and only here, so two runs can never both
 * hold a token. A claim against a token held by another hook asks that hook's
 * run whether the hook is still live. The run answers authoritatively and, for
 * a hook it has never created, fences the id so a late `hook_created` from a
 * crashed or slow claimer can no longer commit (see `hookLiveness` in
 * run-object.ts). Ownership therefore needs no release messages: a stale owner
 * is discovered, and replaced, by the next claimant.
 */
import { DurableObject } from 'cloudflare:workers';
import { call, RUNS_BINDING, serve } from './rpc.js';

interface Owner {
  runId: string;
  hookId: string;
}

export type ClaimResult =
  | { granted: true }
  | { granted: false; ownerRunId: string };

export class TokenObject extends DurableObject {
  /** Serializes claims: the liveness check below awaits another object. */
  #claims: Promise<unknown> = Promise.resolve();

  async claim(runId: string, hookId: string) {
    return serve(() => {
      const next = this.#claims.then(() => this.#claim(runId, hookId));
      this.#claims = next.catch(() => {});
      return next;
    });
  }

  async #claim(runId: string, hookId: string): Promise<ClaimResult> {
    const kv = this.ctx.storage.kv;
    const owner = kv.get<Owner>('owner');
    if (!owner || (owner.runId === runId && owner.hookId === hookId)) {
      kv.put<Owner>('owner', { runId, hookId });
      return { granted: true };
    }
    const liveness = await call<'live' | 'dead'>(
      RUNS_BINDING,
      owner.runId,
      'hookLiveness',
      owner.hookId
    );
    if (liveness === 'live') {
      return { granted: false, ownerRunId: owner.runId };
    }
    kv.put<Owner>('owner', { runId, hookId });
    return { granted: true };
  }

  /** The recorded owner, live or not. Readers confirm with the owning run. */
  async lookup() {
    return serve(() => this.ctx.storage.kv.get<Owner>('owner') ?? null);
  }

  /** Record `hook:<hookId>` → run. Idempotent; hook ids are unique. */
  async record(runId: string) {
    return serve(() => {
      this.ctx.storage.kv.put('owner', { runId, hookId: '' });
    });
  }
}
