import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  inlineHookWorkflow,
  inlineTimingWorkflow,
  processInstanceId,
} from '@/workflows/inline_start';

/**
 * Starts `inlineTimingWorkflow` (or `inlineHookWorkflow` with `hookToken`)
 * and answers with when `start()` was called and returned, and this
 * process's instance ID (see `processInstanceId`). On a World that can hold
 * queue messages, `start()` runs the run's first orchestrator delivery in
 * this route.
 *
 * Body: `{ queued?: boolean, speculation?: boolean, skipRunCreated?: boolean,
 * specVersion?: number, hookToken?: string }`. `queued: true` starts with the
 * kill switch (`WORKFLOW_INLINE_DELIVERY=0`) set for the call, from the same
 * Function, for a queued baseline; `speculation: false` sets
 * `WORKFLOW_INLINE_SPECULATION=0` the same way, and `skipRunCreated: true`
 * sets `WORKFLOW_INLINE_SKIP_RUN_CREATED=1`. The switches are process-wide,
 * so the e2e suite makes those calls one at a time.
 * `runExistedAtReturn` says whether the World had the run as soon as
 * `start()` returned (read right after it, from this process).
 * `firstStartInProcess` says whether this was the process's first start (a
 * fresh instance, which has not loaded the flow entry yet).
 */
let startsInProcess = 0;
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    queued?: boolean;
    speculation?: boolean;
    specVersion?: number;
    hookToken?: string;
    skipRunCreated?: boolean;
  };
  const options =
    body.specVersion !== undefined ? { specVersion: body.specVersion } : {};
  const startCalledAt = Date.now();
  const firstStartInProcess = startsInProcess++ === 0;
  const previous = process.env.WORKFLOW_INLINE_DELIVERY;
  const previousSpeculation = process.env.WORKFLOW_INLINE_SPECULATION;
  const previousSkip = process.env.WORKFLOW_INLINE_SKIP_RUN_CREATED;
  if (body.skipRunCreated) process.env.WORKFLOW_INLINE_SKIP_RUN_CREATED = '1';
  if (body.queued) process.env.WORKFLOW_INLINE_DELIVERY = '0';
  if (body.speculation === false) {
    process.env.WORKFLOW_INLINE_SPECULATION = '0';
  }
  let runId: string;
  let startReturnedAt: number;
  try {
    const run = body.hookToken
      ? await start(inlineHookWorkflow, [body.hookToken], options)
      : await start(inlineTimingWorkflow, [startCalledAt], options);
    startReturnedAt = Date.now();
    runId = run.runId;
  } finally {
    if (body.skipRunCreated) {
      if (previousSkip === undefined) {
        delete process.env.WORKFLOW_INLINE_SKIP_RUN_CREATED;
      } else process.env.WORKFLOW_INLINE_SKIP_RUN_CREATED = previousSkip;
    }
    if (body.queued) {
      if (previous === undefined) delete process.env.WORKFLOW_INLINE_DELIVERY;
      else process.env.WORKFLOW_INLINE_DELIVERY = previous;
    }
    if (body.speculation === false) {
      if (previousSpeculation === undefined) {
        delete process.env.WORKFLOW_INLINE_SPECULATION;
      } else process.env.WORKFLOW_INLINE_SPECULATION = previousSpeculation;
    }
  }
  const runExistedAtReturn = await (await getWorld()).runs
    .get(runId, { resolveData: 'none' })
    .then(
      () => true,
      () => false
    );
  return Response.json({
    runId,
    queued: body.queued === true,
    skipRunCreated: body.skipRunCreated === true,
    runExistedAtReturn,
    speculation: body.speculation !== false,
    firstStartInProcess,
    startCalledAt,
    startReturnedAt,
    instance: processInstanceId(),
    region: process.env.VERCEL_REGION ?? null,
  });
}
