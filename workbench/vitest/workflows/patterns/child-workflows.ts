/**
 * Child Workflows component — spawn independent runs, wait via hook resume.
 *
 * This file is the generic, reusable part: import startAndWait() and
 * withChildCompletionHook() from here for any parent/child pair. See
 * child-workflows-example.ts for a worked example.
 *
 * THE PATTERN:
 *   1. The parent creates a completion hook per child (stable token derived
 *      from the parent runId + a child key) and suspends on it — zero
 *      compute while waiting, immediate wake-up when the child finishes.
 *   2. Each child is an independent workflow run with its own runId, event
 *      log, and retry boundary — a failing child never affects siblings.
 *   3. withChildCompletionHook() runs the real child in try/catch/finally
 *      and resumes the parent's hook with { status, value | error } from a
 *      step, so the parent always wakes up, even on failure.
 *   4. startAndWait() ties hook creation, spawning, and the typed result
 *      together; Promise.all in the parent fans out over many children.
 *
 * WHY HOOKS INSTEAD OF POLLING getRun().status:
 *   - Zero compute while waiting — no sleep() poll loop waking the parent.
 *   - Immediate wake-up when the child finishes, not on the next poll tick.
 *   - Typed payloads — the child sends { status, value | error } directly;
 *     no separate returnValue fetch step.
 *   - No worker-pool pressure from polling inside steps.
 *
 * DOCS: https://workflow-sdk.dev/patterns/child-workflows
 */
import { defineHook, getWorkflowMetadata } from 'workflow';
import { z } from 'zod';

// Completion hook — the child resumes this on the parent when it finishes.
export const childCompletionHook = defineHook({
  schema: z.discriminatedUnion('status', [
    z.object({ status: z.literal('completed'), value: z.unknown() }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]),
});

export type ChildCompletion =
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; error: string };

// Stable token per (parent run, child key) so parallel children inside one
// parent run never collide on hook tokens.
export function completionToken(parentRunId: string, key: string) {
  return `child-completion:${parentRunId}:${key}`;
}

// resume() must be called from a step.
async function resumeParentCompletion(token: string, result: ChildCompletion) {
  'use step';
  await childCompletionHook.resume(token, result);
}

// Runs the real child in try/catch/finally and reports the outcome to the
// parent's hook — including failures, so the parent always wakes up.
export async function withChildCompletionHook<TResult>(
  runChild: () => Promise<TResult>,
  completionTokenArg: string
) {
  let result:
    | { status: 'completed'; value: TResult }
    | { status: 'failed'; error: string }
    | undefined;

  try {
    const value = await runChild();
    result = { status: 'completed', value };
  } catch (error) {
    result = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (result) {
      await resumeParentCompletion(completionTokenArg, result);
    }
  }
}

// Create the hook, spawn the child with the token, suspend until the child
// resumes it, then unwrap the typed result. Call from a parent workflow.
export async function startAndWait<TResult>(
  key: string,
  startChild: (completionTokenArg: string) => Promise<void>
): Promise<TResult> {
  const { workflowRunId } = getWorkflowMetadata();
  const token = completionToken(workflowRunId, key);
  const hook = childCompletionHook.create({ token });

  await startChild(token);

  const completion = await hook;
  if (completion.status === 'failed') {
    throw new Error(completion.error);
  }
  return completion.value as TResult;
}
