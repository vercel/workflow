/**
 * The start Hook properties, checked over everything a scenario left behind:
 * every run's log, the store's decisions, the script's start requests, the
 * effects step bodies recorded, and the calls each writer made.
 *
 * The first is re-derived from the logs alone, independently of the store's
 * own bookkeeping, so a store that agreed with itself about a wrong answer
 * still shows up. The others read what only the store and the harness know:
 * a refused candidate has no log to read.
 *
 * | Rule | What it means |
 * | --- | --- |
 * | `starthook.at-most-one-owner` | No two runs hold one token at the same virtual instant |
 * | `starthook.no-loser-execution` | A refused candidate creates no run, writes nothing, and runs no user code |
 * | `starthook.every-request-resolves` | Every request learns its run, the owner that refused it, or a permanent rejection |
 * | `starthook.stranded-delivery` | Every queued copy of a candidate was decided and acked |
 * | `starthook.refusal-not-acked` | A refused candidate's delivery acks its refusal rather than failing and being retried |
 * | `starthook.reservation-released` | A token is free once its owner ended and retention passed (an orphan, once its window closed), and not before |
 */

import {
  isTerminalRunEventType,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
  type WorkflowRun,
} from '@workflow/world';
import { candidateTimeMs } from './start-hook.js';
import type {
  InvariantViolation,
  ObservedPoint,
  SimEffect,
  StartRequestRecord,
} from './types.js';
import type { SimWorld } from './world.js';

export interface StartHookInvariantInput {
  world: SimWorld;
  requests: readonly StartRequestRecord[];
  effects: readonly SimEffect[];
}

/** One run's claim on a token, as the logs describe it. */
interface LoggedHolder {
  runId: string;
  /** A start reservation (outlives its Hook) or an ordinary Hook. */
  reservation: boolean;
  /** The Hook currently on the claim, and whether it is still live. */
  hookId?: string;
  hookLive: boolean;
  retentionUntilMs?: number;
  sinceMs: number;
}

const toMs = (value: unknown): number | undefined =>
  value === undefined ? undefined : new Date(value as string).getTime();

const later = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

export function checkStartHookInvariants(
  input: StartHookInvariantInput
): InvariantViolation[] {
  const { world, requests, effects } = input;
  const violations: InvariantViolation[] = [];
  const add = (rule: string, message: string, runId?: string) =>
    violations.push({ rule, message, ...(runId ? { runId } : {}) });

  const store = world.store;
  const runs = new Map(store.allRuns().map((r) => [r.runId, r]));
  const decisions = store.startHookDecisions();
  const decisionFor = new Map(decisions.map((d) => [d.runId, d]));
  const refused = decisions.filter((d) => d.decision === 'rejected');
  const orphans = decisions.filter(
    (d) => d.decision === 'accepted' && !runs.has(d.runId)
  );

  // -------------------------------------------------------------------------
  // AtMostOneOwner, from the logs. Commit order across every run is the order
  // things happened in; each run's own log order is only its own.
  // -------------------------------------------------------------------------
  const events = store.allEventsInCommitOrder();
  const endedAt = new Map<string, number>();
  for (const e of events) {
    if (isTerminalRunEventType(e.eventType) && !endedAt.has(e.runId)) {
      endedAt.set(e.runId, e.createdAt.getTime());
    }
  }
  // Whether a run has ended is read in commit order, as the walk below
  // reaches its terminal event, never from its timestamp: under a virtual
  // clock many writes share a millisecond, and an end committed after a
  // competing admission in that same millisecond did not precede it.
  const ended = new Set<string>();
  const holds = (h: LoggedHolder, atMs: number): boolean => {
    if (h.reservation && !ended.has(h.runId)) return true;
    if (!h.reservation && h.hookLive && !ended.has(h.runId)) return true;
    return (h.retentionUntilMs ?? 0) > atMs;
  };

  const holders = new Map<string, LoggedHolder>();
  for (const e of events) {
    const at = e.createdAt.getTime();
    const data = (e as { eventData?: Record<string, unknown> }).eventData;
    if (isTerminalRunEventType(e.eventType)) {
      ended.add(e.runId);
      continue;
    }
    if (e.eventType === 'run_created' && data?.startHook) {
      const startHook = data.startHook as {
        token: string;
        tokenRetentionUntil?: unknown;
      };
      const current = holders.get(startHook.token);
      if (current && current.runId !== e.runId && holds(current, at)) {
        add(
          'starthook.at-most-one-owner',
          `run ${e.runId} was admitted for token "${startHook.token}" while run ${current.runId} still held it (since +${current.sinceMs}ms)`,
          e.runId
        );
      }
      holders.set(startHook.token, {
        runId: e.runId,
        reservation: true,
        hookLive: false,
        retentionUntilMs: toMs(startHook.tokenRetentionUntil),
        sinceMs: at,
      });
      continue;
    }
    if (e.eventType === 'hook_created' && data?.token) {
      const token = data.token as string;
      const current = holders.get(token);
      const retention = toMs(data.tokenRetentionUntil);
      const from = data.forceClaimedFrom as
        | { runId: string; hookId: string }
        | undefined;
      if (from) {
        if (!current || current.runId !== from.runId) {
          add(
            'starthook.at-most-one-owner',
            `run ${e.runId} force-claimed token "${token}" from run ${from.runId}, which did not hold it${current ? ` (run ${current.runId} did)` : ''}`,
            e.runId
          );
        } else if (!current.hookLive || current.hookId !== from.hookId) {
          add(
            'starthook.at-most-one-owner',
            `run ${e.runId} force-claimed token "${token}" from run ${from.runId}, whose claim had no live Hook to take`,
            e.runId
          );
        }
        holders.set(token, {
          runId: e.runId,
          reservation: current?.reservation ?? false,
          hookId: e.correlationId,
          hookLive: true,
          retentionUntilMs: later(current?.retentionUntilMs, retention),
          sinceMs: at,
        });
        continue;
      }
      if (current && current.runId === e.runId) {
        // Adoption, or the run's own Hook again after disposing one.
        current.hookId = e.correlationId;
        current.hookLive = true;
        current.retentionUntilMs = later(current.retentionUntilMs, retention);
        continue;
      }
      if (current && holds(current, at)) {
        add(
          'starthook.at-most-one-owner',
          `run ${e.runId} created a Hook on token "${token}" while run ${current.runId} still held it`,
          e.runId
        );
      }
      holders.set(token, {
        runId: e.runId,
        reservation: false,
        hookId: e.correlationId,
        hookLive: true,
        retentionUntilMs: retention,
        sinceMs: at,
      });
      continue;
    }
    if (e.eventType === 'hook_disposed') {
      for (const h of holders.values()) {
        if (h.runId === e.runId && h.hookId === e.correlationId) {
          h.hookLive = false;
        }
      }
    }
  }
  // An orphan never reaches a log, so its claim comes from its decision: it
  // holds from that decision until its candidate window closes.
  for (const orphan of orphans) {
    const born = candidateTimeMs(orphan.runId) ?? orphan.decidedAtMs;
    const until = born + START_HOOK_CANDIDATE_MAX_AGE_MS;
    for (const e of events) {
      const data = (e as { eventData?: { startHook?: { token: string } } })
        .eventData;
      const at = e.createdAt.getTime();
      if (
        e.eventType === 'run_created' &&
        data?.startHook?.token === orphan.token &&
        at >= orphan.decidedAtMs &&
        at <= until
      ) {
        add(
          'starthook.at-most-one-owner',
          `run ${e.runId} was admitted for token "${orphan.token}" inside the window of orphaned candidate ${orphan.runId}, which could still have been created`,
          e.runId
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // NoLoserExecution: a refused candidate is not a run, and nothing of it ran.
  // -------------------------------------------------------------------------
  const history = world.callHistory();
  const writesFor = (runId: string): ObservedPoint[] =>
    history.filter(
      (p) =>
        p.runId === runId &&
        p.phase === 'after' &&
        !p.failed &&
        (p.call === 'events.create' ||
          p.call === 'events.list' ||
          p.call.startsWith('steps.') ||
          p.call.startsWith('streams.') ||
          p.call === 'hooks.list')
    );
  for (const loser of refused) {
    if (runs.has(loser.runId)) {
      add(
        'starthook.no-loser-execution',
        `refused candidate ${loser.runId} (token "${loser.token}", owner ${loser.conflictingRunId}) exists as a run`,
        loser.runId
      );
    }
    const logged = store.allEvents(loser.runId);
    if (logged.length > 0) {
      add(
        'starthook.no-loser-execution',
        `refused candidate ${loser.runId} has ${logged.length} event(s) in its log: ${logged.map((e) => e.eventType).join(', ')}`,
        loser.runId
      );
    }
    for (const point of writesFor(loser.runId)) {
      add(
        'starthook.no-loser-execution',
        `refused candidate ${loser.runId} was served ${point.call}${point.eventType ? ` ${point.eventType}` : ''} for ${point.writer} (call #${point.seq}): the runtime went on past its refusal`,
        loser.runId
      );
    }
  }
  for (const effect of effects) {
    const run = runs.get(effect.runId);
    const decision = decisionFor.get(effect.runId);
    if (!run || decision?.decision === 'rejected') {
      add(
        'starthook.no-loser-execution',
        `step code "${effect.label}" ran for ${effect.runId}, which ${decision?.decision === 'rejected' ? 'was refused' : 'is not a run'}`,
        effect.runId
      );
    }
  }

  // -------------------------------------------------------------------------
  // EveryRequestResolves.
  // -------------------------------------------------------------------------
  const ownsToken = (run: WorkflowRun | undefined, token: string | undefined) =>
    run !== undefined &&
    (token === undefined ||
      run.startHook?.token === token ||
      store
        .allEvents(run.runId)
        .some(
          (e) =>
            e.eventType === 'hook_created' &&
            (e as { eventData?: { token?: string } }).eventData?.token === token
        ));
  for (const request of requests) {
    const last = request.attempts[request.attempts.length - 1];
    if (!last) continue;
    if (last.died !== undefined && last.outcome === undefined) {
      // The client died; the only continuation it has is a retry, which is
      // another attempt. Nothing is waiting for this one.
      continue;
    }
    const outcome = last.outcome;
    const label = `request "${request.request}"${request.token ? ` (token "${request.token}")` : ''}`;
    if (!outcome) {
      add(
        'starthook.every-request-resolves',
        `${label} never got an answer to attempt ${last.caller}`
      );
      continue;
    }
    switch (outcome.kind) {
      case 'run':
        if (!ownsToken(runs.get(outcome.runId), request.token)) {
          add(
            'starthook.every-request-resolves',
            `${label} was answered with run ${outcome.runId}, which ${runs.has(outcome.runId) ? 'does not own the token' : 'does not exist'}`,
            outcome.runId
          );
        }
        break;
      case 'conflict':
        if (!outcome.conflictingRunId) {
          add(
            'starthook.every-request-resolves',
            `${label} was refused without naming the owner`
          );
        } else if (
          // An accepted candidate owns its token before its run exists, and
          // past its death until its window closes: the decision table
          // refuses contenders naming it. That caller learns an owner that
          // may never become a run (see `start-hook-orphan-*`).
          decisionFor.get(outcome.conflictingRunId)?.decision !== 'accepted' &&
          !ownsToken(runs.get(outcome.conflictingRunId), request.token)
        ) {
          add(
            'starthook.every-request-resolves',
            `${label} was refused naming ${outcome.conflictingRunId}, which ${runs.has(outcome.conflictingRunId) ? 'never owned the token' : 'is not a run'}`,
            outcome.conflictingRunId
          );
        }
        break;
      case 'rejected':
        break;
      case 'uncertain':
        add(
          'starthook.every-request-resolves',
          `${label} ended uncertain after ${request.attempts.length} attempt(s): ${outcome.message}`
        );
        break;
      case 'error':
        add(
          'starthook.every-request-resolves',
          `${label} ended with ${outcome.name}: ${outcome.message}`
        );
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Stranded deliveries: a queued copy left with nobody deciding it.
  // -------------------------------------------------------------------------
  for (const message of world.simQueue.pending()) {
    const payload = message.payload as {
      runId?: string;
      runInput?: { startHook?: { token: string } };
    };
    const token = payload.runInput?.startHook?.token;
    if (!token || !payload.runId) continue;
    const decision = decisionFor.get(payload.runId);
    if (decision?.decision === 'rejected') {
      add(
        'starthook.stranded-delivery',
        `the queued copy of refused candidate ${payload.runId} was never acked (${message.deliveries} delivery attempt(s))`,
        payload.runId
      );
    } else if (!runs.has(payload.runId)) {
      add(
        'starthook.stranded-delivery',
        `the queued copy of candidate ${payload.runId} (token "${token}") is still pending with no run`,
        payload.runId
      );
    }
  }

  // A refused candidate's delivery has nothing to retry: its answer can never
  // change. One that answers an error is retried for nothing, and only stops
  // when the queue gives up on it.
  for (const loser of refused) {
    const failed = world.deliveryLog.filter(
      (d) => d.runId === loser.runId && d.outcome === 'error'
    );
    if (failed.length > 0) {
      add(
        'starthook.refusal-not-acked',
        `the queued copy of refused candidate ${loser.runId} answered an error ${failed.length} time(s) (attempts ${failed.map((d) => d.attempt).join(', ')}) instead of acking its refusal`,
        loser.runId
      );
    }
  }

  // -------------------------------------------------------------------------
  // ReservationReleased, and not early: probe the store's own answer at the
  // instant each finished claim should let go, and just before it.
  // -------------------------------------------------------------------------
  for (const claim of store.tokenClaims()) {
    const run = runs.get(claim.runId);
    let releaseAt: number | undefined;
    // Whether the claim outlives its run's end, so "just before" is a moment
    // the run had already ended and only the retention can be holding it.
    let retained = false;
    if (!run) {
      if (!claim.reservation) continue;
      const born = candidateTimeMs(claim.runId);
      if (born === undefined) continue;
      releaseAt = born + START_HOOK_CANDIDATE_MAX_AGE_MS + 1;
      retained = true;
    } else {
      const end = endedAt.get(claim.runId);
      if (end === undefined) continue;
      releaseAt = Math.max(end, claim.retentionUntilMs ?? 0);
      retained = (claim.retentionUntilMs ?? 0) > end;
    }
    const after = store.probeToken(claim.token, releaseAt);
    if (after !== undefined) {
      add(
        'starthook.reservation-released',
        `token "${claim.token}" is still held by ${after} at ${new Date(releaseAt).toISOString()}, after ${claim.runId} ${run ? 'ended and its retention passed' : 'aged out of its window'}`,
        claim.runId
      );
    }
    if (retained) {
      const before = store.probeToken(claim.token, releaseAt - 1);
      if (before !== claim.runId) {
        add(
          'starthook.reservation-released',
          `token "${claim.token}" would be free a moment before ${claim.runId}'s claim should end (${before ? `held by ${before}` : 'free'})`,
          claim.runId
        );
      }
    }
  }

  return violations;
}
