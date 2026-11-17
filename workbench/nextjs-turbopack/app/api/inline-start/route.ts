import { start } from 'workflow/api';
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
 * Body: `{ queued?: boolean, speculation?: boolean, specVersion?: number,
 * hookToken?: string }`. `queued: true` starts with the kill switch
 * (`WORKFLOW_INLINE_DELIVERY=0`) set for the call, from the same Function, for
 * a queued baseline; `speculation: false` sets
 * `WORKFLOW_INLINE_SPECULATION=0` the same way. Both switches are
 * process-wide, so the e2e suite makes those calls one at a time.
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
  };
  const options =
    body.specVersion !== undefined ? { specVersion: body.specVersion } : {};
  const startCalledAt = Date.now();
  const firstStartInProcess = startsInProcess++ === 0;
  const previous = process.env.WORKFLOW_INLINE_DELIVERY;
  const previousSpeculation = process.env.WORKFLOW_INLINE_SPECULATION;
  if (body.queued) process.env.WORKFLOW_INLINE_DELIVERY = '0';
  if (body.speculation === false) {
    process.env.WORKFLOW_INLINE_SPECULATION = '0';
  }
  let runId: string;
  try {
    const run = body.hookToken
      ? await start(inlineHookWorkflow, [body.hookToken], options)
      : await start(inlineTimingWorkflow, [startCalledAt], options);
    runId = run.runId;
  } finally {
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
  return Response.json({
    runId,
    queued: body.queued === true,
    speculation: body.speculation !== false,
    firstStartInProcess,
    startCalledAt,
    startReturnedAt: Date.now(),
    instance: processInstanceId(),
    region: process.env.VERCEL_REGION ?? null,
  });
}
