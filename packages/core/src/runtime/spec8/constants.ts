/**
 * Runtime settings of the spec 8 orchestrator (multi-orchestrator runs, spec
 * version 8 and below). Settings both orchestrators read live in
 * `../constants.ts`.
 */
import {
  envNumber,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
} from '@workflow/world';
import {
  getMaxInlineSteps as getSharedMaxInlineSteps,
  MAX_INLINE_STEPS,
} from '../constants.js';

/**
 * The spec version the spec 8 orchestrator stamps on the events it writes:
 * the last version whose runs allow several orchestrator invocations to write
 * at once.
 */
export const SPEC8_EVENT_SPEC_VERSION = SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM;

/**
 * Whether batched event transitions are enabled: the suspension handler folds
 * a clean fan-out's `step_created` + `wait_created` writes into one
 * `world.events.createBatch` call (one durable write, per-event outcomes)
 * instead of one write per event. Only engages when the World implements the
 * optional `events.createBatch` AND the run is on slot identity
 * (specVersion >= 6) AND the suspension carries no attribute writes. Hook writes in the same suspension go through the
 * single-event path concurrently with the batch. Everything else keeps the
 * single-event path byte-for-byte.
 *
 * Reads `process.env.WORKFLOW_BATCH_TRANSITIONS` lazily. Default **ON**;
 * disabled only by an explicit `'0'` / `'false'` (case-insensitive), the
 * operator escape hatch that restores the exact prior one-write-per-event
 * path, mirroring `WORKFLOW_TURBO`'s kill-switch shape.
 */
export function isBatchTransitionsEnabled(): boolean {
  const raw = process.env.WORKFLOW_BATCH_TRANSITIONS;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/**
 * Ceiling on events per `createBatch` call from the batched fan-out fold.
 * The server's transaction budgets are the hard limit: each fan-out event
 * costs 2 transaction items server-side (entity + event row) against the
 * 100-item DynamoDB cap, and inline payloads count against a 768 KB byte
 * budget. A fan-out larger than this commits in successive batches, all in
 * flight at once (split batches lose cross-batch atomicity, which is exactly
 * the per-event-write crash surface, and every batch still converges on retry
 * via per-event 409s).
 *
 * Within the budget the value is a latency trade, measured on durabench
 * production sweeps (Vercel World, iad1, `Promise.all` of N one-step branches,
 * 100 ms of work and 1 KB JSON each, 2026-10-07, every candidate built off the
 * same commit and interleaved in one sweep):
 *
 * - A queued (non-inline) branch's message is published only once the chunk
 *   carrying its `step_created` commits, then goes out in that chunk's
 *   batched publish, and both hops slow down as the chunk grows. Smaller
 *   chunks start the queued branches sooner: at 64 branches the queued
 *   branches' median `step_started` moved from ~570 ms after `run_started` at
 *   32 to ~460 ms at 16, and the last branch's first line from 967 to 875 ms
 *   (p50, 45 runs each); at 128 branches, from 4,059 to 3,855 ms (20 runs).
 * - More chunks are more concurrent `createBatch` requests per run, and the
 *   inline branches' pair chunk is one of them. From about 16 concurrent
 *   chunks the first (inline) branch slows down: at 128 branches 8 per chunk
 *   cost it ~120 ms, and at 256 branches 4, 8 and 12 per chunk cost it ~470,
 *   ~120 and ~140 ms. At 16 a 256-branch fan-out is 16 plain chunks, at the
 *   edge of that (+~100 ms, not significant over 20 runs); at 24 and 32 it
 *   is flat.
 *
 * 16 is the largest value with a clear last-branch gain at 64 and 128
 * branches and no first-branch or join regression there; an 8-branch fan-out
 * fits one chunk either way. It also keeps the default inline pairs (two rows
 * per inline step, `MAX_INLINE_STEPS` = 3) in one chunk. A
 * `WORKFLOW_MAX_INLINE_STEPS` above 8 spills the pairs into more than one pair
 * chunk; they commit concurrently and all of them gate the inline bodies, so
 * that degrades latency, not correctness.
 */
export const MAX_BATCH_FANOUT_EVENTS = 16;

/**
 * Whether optimistic inline step start is enabled. When on, the owned-inline
 * path begins running a brand-new step's body *before* its lazy `step_started`
 * network call resolves (the input is already known locally), awaiting the
 * `step_started` only before the terminal write.
 *
 * This can run a step body more than once when handlers race for the same
 * step's create-claim: both run the body before one wins. That is unsafe for
 * steps with non-idempotent side effects; in particular, two concurrent runs
 * of a step that writes to the workflow stream (e.g. an AI agent streaming
 * tokens) can interleave and corrupt the stream data. So the optimization is
 * **off by default** and must be explicitly opted into per deployment.
 *
 * Reads `process.env.WORKFLOW_OPTIMISTIC_INLINE_START` lazily. Default OFF;
 * enabled only by an explicit `'1'` / `'true'`.
 */
export function isOptimisticInlineStartEnabled(): boolean {
  const raw = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Whether inline step ownership is enabled (default ON). When on, the lazy
 * `step_started` that creates an inline step records the owning queue
 * message ID, and wake replays that observe an actively-owned step enqueue a
 * *delayed backstop* message instead of immediately requeueing it, fixing
 * duplicate inline step execution when a hook/wait wakes a run mid-step
 * (vercel/workflow#2780).
 *
 * `WORKFLOW_INLINE_OWNERSHIP=0` (or `false`) is the kill switch: dispatch
 * reverts to the unconditional immediate requeue. Stamping is unaffected:
 * the recorded ownerMessageId is inert data when the switch is off.
 */
export function isInlineOwnershipEnabled(): boolean {
  const raw = process.env.WORKFLOW_INLINE_OWNERSHIP;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/**
 * Whether the Node.js inline loop advances the workflow as each inline step
 * settles, instead of waiting for every step of the batch (default ON).
 *
 * When one inline step of a parallel batch completes or fails while its
 * siblings are still running, the loop replays right away in the same
 * invocation, with the siblings still in flight. A branch whose step settled
 * can then start its next step without waiting for the slowest sibling. The
 * siblings stay owned by this invocation: the replay neither creates, queues
 * nor recovers them. A pass that ends the workflow writes the run's terminal
 * event right away; the invocation still waits for the siblings' bodies
 * before it returns, and their later step events are the World's to accept or
 * refuse against the terminal run.
 *
 * Reads `process.env.WORKFLOW_INLINE_EARLY_ADVANCE` lazily. Default **ON**;
 * disabled only by an explicit `'0'` / `'false'` (case-insensitive), which
 * restores waiting for the whole batch.
 */
export function isInlineEarlyAdvanceEnabled(): boolean {
  const raw = process.env.WORKFLOW_INLINE_EARLY_ADVANCE;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/**
 * Default inline-ownership lease, in seconds: how long after a step's latest
 * (stamped) `step_started` a non-owner invocation assumes the owning
 * invocation may still be alive. Within the lease, wake replays enqueue the
 * step's backstop message with `delaySeconds = lease remaining` instead of
 * immediately; past it, they enqueue immediately (today's behavior).
 *
 * Why a fixed 860 and not a value derived from the function's `maxDuration`:
 * neither runtime nor build time can see the resolved value: builders emit
 * `maxDuration: 'max'`, which the platform resolves per-plan at deploy, and
 * no env var or request-context deadline API exposes the result. The bound
 * comes from a platform rule instead: durations above 800s require explicit
 * per-function numeric config, so a builder-emitted `'max'` resolves to at
 * most 800s, and 860s therefore dominates any workflow route's invocation
 * lifetime plus scheduling slack. Revisit when that ceiling moves (the
 * 30-minute duration beta becoming reachable via `'max'` would invalidate
 * the bound). Worlds without an invocation kill bound (world-local,
 * self-hosted) get no death proof from any constant. There the in-process
 * single-flight layer (step-single-flight.ts) is what makes a backstop
 * firing mid-step harmless.
 *
 * 860 also stays under the queue's 900s maximum delay (SQS cap), so a
 * backstop's full lease remainder always fits in a single delayed message.
 *
 * Override via `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` (clamped to
 * 1..`MAX_INLINE_OWNERSHIP_LEASE_SECONDS`).
 */
export const INLINE_OWNERSHIP_LEASE_SECONDS = 860;

/**
 * Upper bound for the lease env override. 900s is the queue's maximum
 * per-message delay (SQS cap). A longer lease would need delay chaining
 * like long waits use; clamp instead so one delayed message always suffices.
 */
export const MAX_INLINE_OWNERSHIP_LEASE_SECONDS = 900;

/**
 * Effective inline-ownership lease. Override via
 * `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`, e.g. raise it on self-hosted
 * multi-instance worlds with long-running steps to widen the window in which
 * a live owner is protected from a concurrent backstop execution.
 */
export function getInlineOwnershipLeaseSeconds(): number {
  return envNumber(
    'WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS',
    INLINE_OWNERSHIP_LEASE_SECONDS,
    { integer: true, min: 1, max: MAX_INLINE_OWNERSHIP_LEASE_SECONDS }
  );
}

// A stale-snapshot rejection (412) means the replay's event log was missing an
// event the World had already recorded, so the replay is re-derived from a
// corrected log inside the same invocation. Bounded because a persistently
// rejected write should escalate rather than spin: after this many restarts the
// run is re-invoked (a new invocation, possibly in a different region), and the
// run-level budget below then applies.
export const PRECONDITION_MAX_INPROCESS_RESTARTS = 3;

/**
 * Effective in-process replay-restart budget for stale-snapshot rejections.
 * Override via `WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS`.
 */
export function getPreconditionMaxInProcessRestarts(): number {
  return envNumber(
    'WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS',
    PRECONDITION_MAX_INPROCESS_RESTARTS,
    { integer: true }
  );
}

// The in-process budget above is per-invocation, and a re-invocation that
// enqueues a fresh message also restarts the queue's delivery count, so without
// a counter carried on the message a permanently fenced run has no run-level
// bound at all. It can stay fenced without any permanent fault (a full reload
// is not atomic across pages, so a busy run can acquire a new hole on every
// reload), so the chain is counted and the run fails once this many
// re-invocations have been spent on stale-snapshot rejections.
export const PRECONDITION_MAX_REINVOCATIONS = 5;

/**
 * Effective per-run budget for re-invocations caused by stale-snapshot
 * rejections. Override via `WORKFLOW_PRECONDITION_MAX_REINVOCATIONS`.
 */
export function getPreconditionMaxReinvocations(): number {
  return envNumber(
    'WORKFLOW_PRECONDITION_MAX_REINVOCATIONS',
    PRECONDITION_MAX_REINVOCATIONS,
    { integer: true }
  );
}

// Backoff before a precondition re-invocation. Unlike the in-process restart
// (where the point is to re-read immediately), a re-invocation only happens
// after the in-process budget failed to catch up, so the log is being extended
// faster than this replay can follow it. Waiting lets the writers quiesce.
export const PRECONDITION_REINVOKE_DELAY_SECONDS = 2;

/**
 * Effective delay before a precondition re-invocation. Override via
 * `WORKFLOW_PRECONDITION_REINVOKE_DELAY_SECONDS`.
 */
export function getPreconditionReinvokeDelaySeconds(): number {
  return envNumber(
    'WORKFLOW_PRECONDITION_REINVOKE_DELAY_SECONDS',
    PRECONDITION_REINVOKE_DELAY_SECONDS,
    { integer: true }
  );
}

/**
 * The max number of inline steps for the spec 8 orchestrator. The setting is
 * shared (see `../constants.ts`), but the spec 8 orchestrator reads
 * `WORKFLOW_MAX_INLINE_STEPS=0` as unset and uses the default, as it always
 * has; only the spec 9 orchestrator enqueues every step at 0.
 */
export function getMaxInlineSteps(): number {
  const maxInlineSteps = getSharedMaxInlineSteps();
  return maxInlineSteps === 0 ? MAX_INLINE_STEPS : maxInlineSteps;
}
