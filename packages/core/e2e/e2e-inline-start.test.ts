import { describe, expect, test } from 'vitest';
import { fetchWithTrustedSources } from '../../../scripts/trusted-sources-headers.mjs';

/**
 * Vercel-specific suite for inline orchestrator delivery: on a World that can
 * hold queue messages, `start()` and `resumeHook()` run the run's orchestrator
 * delivery in the route that called them, through send-and-hold
 * (`QueueOptions.experimental_hold`), instead of a queue hop to the flow
 * route.
 *
 * The workbench fixtures (workbench/nextjs-turbopack/workflows/inline_start.ts)
 * have every step report the process it ran in. `withWorkflow()` makes the
 * flow entry loadable from every route (app/api/inline-start/*), so a step
 * that reports the route's process ran inline.
 *
 * Runs are read back through the deployment (app/api/inline-start/run/[runId]),
 * so the suite needs only `DEPLOYMENT_URL` and a protection bypass.
 *
 * Each test also looks for double delivery: every step must run once
 * (attempt 1) and reach one committed outcome, and the log must not grow
 * after the run completes and the hold's lease has long lapsed.
 *
 * Until send-and-hold is on for the target, every send comes back
 * `not_held`, the run is queued, and only the fallback is proven. With
 * `WORKFLOW_E2E_EXPECT_QUEUE_HOLD=1` (the `e2e-vercel-queue-hold` job reads
 * it from a repository variable) a run that did not go inline fails.
 *
 * `WORKFLOW_E2E_INLINE_SAMPLES` (default 5) sets how many runs of each mode
 * the timing comparison takes.
 */

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

const expectInline = process.env.WORKFLOW_E2E_EXPECT_QUEUE_HOLD === '1';
const samples = Number(process.env.WORKFLOW_E2E_INLINE_SAMPLES ?? 5);

/** Vercel Queues' default hold lease, plus margin. */
const LEASE_LAPSE_MS = 45_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StepReport {
  label: string;
  at: number;
  attempt: number;
  instance: string;
}

interface StartAnswer {
  runId: string;
  queued: boolean;
  startCalledAt: number;
  startReturnedAt: number;
  instance: string;
  region: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTrustedSources(new URL(path, deploymentUrl), init);
  if (!res.ok) {
    throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface RunAnswer<T> {
  status: string;
  completedAt: number | null;
  returnValue: T | null;
  events: { eventType: string; correlationId: string | null }[];
}

/** The run's outcome and log, read by the deployment once it finished. */
async function readRun<T>(runId: string): Promise<RunAnswer<T>> {
  for (let i = 0; i < 5; i++) {
    const answer = await request<RunAnswer<T>>(
      `/api/inline-start/run/${runId}?waitMs=50000`
    );
    if (answer.status !== 'pending' && answer.status !== 'running') {
      expect(answer.status).toBe('completed');
      return answer;
    }
  }
  throw new Error(`run ${runId} did not finish`);
}

/** The event types of a run's log, by correlation ID. */
function eventLog(answer: RunAnswer<unknown>) {
  const types: string[] = [];
  const byCorrelation = new Map<string, string[]>();
  for (const event of answer.events) {
    types.push(event.eventType);
    if (event.correlationId) {
      const list = byCorrelation.get(event.correlationId) ?? [];
      list.push(event.eventType);
      byCorrelation.set(event.correlationId, list);
    }
  }
  return { types, byCorrelation };
}

/** Every step started once and completed once: no double delivery. */
function expectEachStepOnce(
  log: ReturnType<typeof eventLog>,
  steps: StepReport[]
) {
  for (const step of steps) expect(step.attempt).toBe(1);
  const stepLogs = [...log.byCorrelation.entries()].filter(([id]) =>
    id.startsWith('step_')
  );
  expect(stepLogs).toHaveLength(steps.length);
  for (const [id, types] of stepLogs) {
    expect(
      types.filter((t) => t === 'step_started'),
      `${id}: ${types.join(',')}`
    ).toHaveLength(1);
    expect(
      types.filter((t) => t === 'step_completed'),
      `${id}: ${types.join(',')}`
    ).toHaveLength(1);
  }
  expect(log.types.filter((t) => t === 'run_completed')).toHaveLength(1);
}

/** Whether the run's first step ran in the route's process. */
function ranInline(answer: { instance: string }, steps: StepReport[]): boolean {
  const inline = steps[0]?.instance === answer.instance;
  if (expectInline) {
    expect(
      inline,
      `expected the first step to run in the calling route (${answer.instance}), it ran in ${steps[0]?.instance}`
    ).toBe(true);
  } else if (!inline) {
    console.info(
      '[e2e-inline-start] run was queued (send not held); asserting the fallback'
    );
  }
  return inline;
}

interface TimingValue {
  startCalledAt: number;
  steps: StepReport[];
}

async function startTiming(inline: boolean, specVersion?: number) {
  const answer = await post<StartAnswer>('/api/inline-start', {
    queued: !inline,
    ...(specVersion !== undefined && { specVersion }),
  });
  const read = await readRun<TimingValue>(answer.runId);
  return { answer, read, value: read.returnValue as TimingValue };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe
  // Sequential: the queued baseline sets the process-wide kill switch for
  // the duration of its `start()` call.
  .skipIf(!process.env.WORKFLOW_VERCEL_ENV)(
  'inline orchestrator delivery',
  () => {
    test.each([
      ['the default spec', undefined],
      ['spec 9 (single orchestrator)', 9],
    ])(
      'a start with %s runs in the calling route, once',
      { timeout: 240_000 },
      async (_label, specVersion) => {
        const { answer, read, value } = await startTiming(true, specVersion);
        ranInline(answer, value.steps);
        // Both steps of a two-step run belong to the one delivery.
        expect(value.steps[1]?.instance).toBe(value.steps[0]?.instance);

        const log = eventLog(read);
        expectEachStepOnce(log, value.steps);
        // Past the hold's lease: a redelivery that ran the run again would
        // have written to the log by now.
        await sleep(LEASE_LAPSE_MS);
        const after = eventLog(await readRun(answer.runId));
        expect(after.types).toEqual(log.types);
      }
    );

    test(
      'with the kill switch the same route queues the run',
      { timeout: 120_000 },
      async () => {
        const { answer, read, value } = await startTiming(false);
        expect(value.steps[0]?.instance).not.toBe(answer.instance);
        expectEachStepOnce(eventLog(read), value.steps);
      }
    );

    test(
      'resumeHook wakes the run in the calling route, once',
      { timeout: 240_000 },
      async () => {
        const token = `inline-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // Queued, so the start's own delivery is not what the resume races.
        const started = await post<StartAnswer>('/api/inline-start', {
          queued: true,
          hookToken: token,
        });
        // Resume once the hook exists (the run has suspended on it); until
        // then the route answers with the resume's not-found error.
        let resumed: { instance: string; resumedAt: number } | undefined;
        let lastError: unknown;
        for (let i = 0; i < 60 && !resumed; i++) {
          try {
            resumed = await post('/api/inline-start/resume', { token });
          } catch (error) {
            lastError = error;
            await sleep(1_000);
          }
        }
        expect(resumed, String(lastError)).toBeDefined();
        const read = await readRun<{ resumedAt: number; steps: StepReport[] }>(
          started.runId
        );
        const value = read.returnValue as {
          resumedAt: number;
          steps: StepReport[];
        };
        const after = value.steps[1];
        const inline = after?.instance === resumed?.instance;
        if (expectInline) expect(inline).toBe(true);
        const log = eventLog(read);
        expectEachStepOnce(log, value.steps);
        expect(log.types.filter((t) => t === 'hook_received')).toHaveLength(1);
      }
    );

    test(
      'time to first step and to completion, inline versus queued',
      { timeout: 600_000 },
      async () => {
        const rows: Record<string, number | string | boolean>[] = [];
        // Interleaved, so both modes see the same conditions.
        for (let i = 0; i < samples; i++) {
          for (const inline of [true, false]) {
            const { answer, read, value } = await startTiming(inline);
            const { completedAt } = read;
            rows.push({
              mode: inline ? 'inline' : 'queued',
              ranInline: value.steps[0]?.instance === answer.instance,
              startMs: answer.startReturnedAt - answer.startCalledAt,
              firstStepMs: value.steps[0].at - answer.startCalledAt,
              lastStepMs: value.steps[1].at - answer.startCalledAt,
              completedMs: completedAt
                ? completedAt - answer.startCalledAt
                : Number.NaN,
              region: answer.region ?? '',
            });
          }
        }
        const summary = (['inline', 'queued'] as const).map((mode) => {
          const of = rows.filter((r) => r.mode === mode);
          const pick = (key: string) => median(of.map((r) => Number(r[key])));
          return {
            mode,
            samples: of.length,
            ranInline: of.filter((r) => r.ranInline).length,
            medianStartMs: pick('startMs'),
            medianFirstStepMs: pick('firstStepMs'),
            medianLastStepMs: pick('lastStepMs'),
            medianCompletedMs: pick('completedMs'),
          };
        });
        console.info(
          '[e2e-inline-start] timing samples',
          JSON.stringify(rows, null, 2)
        );
        console.info(
          '[e2e-inline-start] timing summary',
          JSON.stringify(summary, null, 2)
        );
        if (expectInline) {
          expect(summary[0].ranInline).toBe(samples);
        }
      }
    );
  }
);
