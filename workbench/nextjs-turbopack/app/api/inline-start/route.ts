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
 * Body: `{ queued?: boolean, specVersion?: number, hookToken?: string }`.
 * `queued: true` starts with the kill switch (`WORKFLOW_INLINE_DELIVERY=0`)
 * set for the call, from the same Function, for a queued baseline. The switch
 * is process-wide, so the e2e suite makes those calls one at a time.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    queued?: boolean;
    specVersion?: number;
    hookToken?: string;
  };
  const options =
    body.specVersion !== undefined ? { specVersion: body.specVersion } : {};
  const startCalledAt = Date.now();
  const previous = process.env.WORKFLOW_INLINE_DELIVERY;
  if (body.queued) process.env.WORKFLOW_INLINE_DELIVERY = '0';
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
  }
  return Response.json({
    runId,
    queued: body.queued === true,
    startCalledAt,
    startReturnedAt: Date.now(),
    instance: processInstanceId(),
    region: process.env.VERCEL_REGION ?? null,
  });
}
