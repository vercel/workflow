// Null-step workflows used to measure step-to-step overhead (STSO) when steps
// are executed *eagerly inline* — i.e. inside a single flow-handler invocation,
// with no queue hop between them.
//
// The runtime's in-process loop (packages/core/src/runtime.ts, `while (true)`)
// replays the whole workflow function from the top on every iteration, feeding
// it the full event log, and runs the next uncreated step inline. So step N's
// "overhead" includes replaying steps 0..N-1 from the event log. These
// workflows are deliberately as close to zero user-work as possible so the
// measured gaps are pure runtime overhead.

/** One sample recorded from inside a step body (real Node clock, not the VM's
 * replay-stable clock — step bodies run outside the workflow VM). */
export interface StepSample {
  /** Step index in the sequential chain. */
  i: number;
  /** `performance.now()` at body entry (sub-ms, same process for a local run). */
  t0: number;
  /** `performance.now()` at body exit. */
  t1: number;
  /** `Date.now()` at body entry, to correlate with event-log timestamps. */
  wall: number;
}

/** A step that does nothing except stamp the clock on the way in and out. */
async function timedNullStep(i: number): Promise<StepSample> {
  'use step';
  const t0 = performance.now();
  return { i, t0, t1: performance.now(), wall: Date.now() };
}

/** A step that does nothing at all and returns nothing. */
async function voidNullStep(_i: number): Promise<void> {
  'use step';
}

// ---------------------------------------------------------------------------
// Return-value shape probes.
//
// ReplayPayloadCache (packages/core/src/replay-payload-cache.ts) memoizes a
// step's *final hydrated value* across the invocation's replays — but only
// when sharing one value between VM realms is unobservable, i.e. when it is a
// primitive and, for strings/bigints, no longer than
// MAX_MEMOIZED_PRIMITIVE_LENGTH (4096). Anything else re-runs `hydrate()`
// against the fresh VM's globals on every replay.
//
// These steps are designed to cross that boundary in both directions so the
// benchmark can tell "payload is big" apart from "payload is not memoizable":
//
//   number   — primitive, tiny            → memoized
//   str4000  — primitive, 4 KB payload    → memoized (4000 <= 4096)
//   str5000  — primitive, 5 KB payload    → NOT memoized (5000 > 4096)
//   obj4     — object, ~40 byte payload   → NOT memoized
//   obj40    — object, ~600 byte payload  → NOT memoized
//
// If cost tracked payload size, str4000 would be the expensive one and obj4
// the cheap one. If it tracks memoizability, it is the other way around.
// ---------------------------------------------------------------------------

async function numberStep(i: number): Promise<number> {
  'use step';
  return i;
}

async function str4000Step(i: number): Promise<string> {
  'use step';
  return String(i % 10).repeat(4000);
}

async function str5000Step(i: number): Promise<string> {
  'use step';
  return String(i % 10).repeat(5000);
}

async function obj4Step(i: number): Promise<Record<string, number>> {
  'use step';
  return { a: i, b: i + 1, c: i + 2, d: i + 3 };
}

async function obj40Step(i: number): Promise<Record<string, number>> {
  'use step';
  const out: Record<string, number> = {};
  for (let k = 0; k < 40; k++) out[`f${k}`] = i + k;
  return out;
}

/**
 * `count` sequential null steps, each returning its own timing sample.
 *
 * Sequential + no hooks/waits/sleeps/streams means the runtime keeps the whole
 * chain inline in one invocation (see docs/content/docs/v5/changelog/
 * lazy-event-creation.md, "Queue messages: inline steps don't pay a
 * round-trip"), which is exactly the regime we want to measure.
 */
export async function timedNullStepsWorkflow(
  count: number
): Promise<StepSample[]> {
  'use workflow';
  const samples: StepSample[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(await timedNullStep(i));
  }
  return samples;
}

/**
 * `count` sequential steps that return nothing and are never collected, so the
 * workflow's in-VM state stays O(1) instead of growing with the step count.
 *
 * Used as a control: timings for this one are reconstructed from the event log
 * (`step_started` / `step_completed` `createdAt`), which proves the STSO curve
 * is not an artifact of the sample array the timed variant accumulates.
 */
export async function voidNullStepsWorkflow(count: number): Promise<number> {
  'use workflow';
  for (let i = 0; i < count; i++) {
    await voidNullStep(i);
  }
  return count;
}

/** `count` sequential steps returning a memoizable primitive number. */
export async function numberStepsWorkflow(count: number): Promise<number> {
  'use workflow';
  for (let i = 0; i < count; i++) await numberStep(i);
  return count;
}

/** `count` sequential steps returning a 4000-char string (memoizable). */
export async function str4000StepsWorkflow(count: number): Promise<number> {
  'use workflow';
  for (let i = 0; i < count; i++) await str4000Step(i);
  return count;
}

/** `count` sequential steps returning a 5000-char string (over the cap). */
export async function str5000StepsWorkflow(count: number): Promise<number> {
  'use workflow';
  for (let i = 0; i < count; i++) await str5000Step(i);
  return count;
}

/** `count` sequential steps returning a tiny 4-field object. */
export async function obj4StepsWorkflow(count: number): Promise<number> {
  'use workflow';
  for (let i = 0; i < count; i++) await obj4Step(i);
  return count;
}

/** `count` sequential steps returning a 40-field object. */
export async function obj40StepsWorkflow(count: number): Promise<number> {
  'use workflow';
  for (let i = 0; i < count; i++) await obj40Step(i);
  return count;
}
