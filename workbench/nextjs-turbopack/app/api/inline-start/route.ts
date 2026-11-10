// Bundles the app's flow entry (workflows, steps and the orchestrator handler)
// into this route, so `experimental_inline` can run a run's first delivery
// here. Compare with ../inline-start-queued, which does not import it.
import 'workflow/next/inline';
import { start } from 'workflow/api';
import {
  inlineHookWorkflow,
  inlineTimingWorkflow,
  processInstanceId,
} from '@/workflows/inline_start';

/**
 * Starts `inlineTimingWorkflow` (or `inlineHookWorkflow` with `hookToken`)
 * and answers with when `start()` was called and returned, and this
 * process's instance ID (see `processInstanceId`).
 *
 * Body: `{ inline?: boolean, specVersion?: number, hookToken?: string }`.
 * `inline: false` starts the same way without the option, from the same
 * Function, for a queued baseline.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    inline?: boolean;
    specVersion?: number;
    hookToken?: string;
  };
  const inline = body.inline !== false;
  const startCalledAt = Date.now();
  const run = body.hookToken
    ? await start(inlineHookWorkflow, [body.hookToken], {
        experimental_inline: inline,
        ...(body.specVersion !== undefined && {
          specVersion: body.specVersion,
        }),
      })
    : await start(inlineTimingWorkflow, [startCalledAt], {
        experimental_inline: inline,
        ...(body.specVersion !== undefined && {
          specVersion: body.specVersion,
        }),
      });
  return Response.json({
    runId: run.runId,
    inline,
    startCalledAt,
    startReturnedAt: Date.now(),
    instance: processInstanceId(),
    region: process.env.VERCEL_REGION ?? null,
  });
}
