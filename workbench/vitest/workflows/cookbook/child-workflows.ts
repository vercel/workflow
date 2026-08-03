import { defineHook } from 'workflow';
import { start } from 'workflow/api';
import { z } from 'zod';

async function processItem(item: string): Promise<string> {
  'use step';
  return `processed-${item}`;
}

const childCompletionHook = defineHook({
  schema: z.discriminatedUnion('status', [
    z.object({ status: z.literal('completed'), value: z.unknown() }),
    z.object({ status: z.literal('failed'), error: z.string() }),
  ]),
});

async function resumeParentCompletion(
  token: string,
  result:
    | { status: 'completed'; value: unknown }
    | { status: 'failed'; error: string }
) {
  'use step';
  await childCompletionHook.resume(token, result);
}

// Child workflow
export async function childWorkflow(item: string) {
  'use workflow';

  const result = await processItem(item);
  return { item, result };
}

export async function childWorkflowWithCompletion(
  item: string,
  completionToken: string
) {
  'use workflow';

  let payload:
    | { status: 'completed'; value: { item: string; result: string } }
    | { status: 'failed'; error: string }
    | undefined;

  try {
    const value = await childWorkflow(item);
    payload = { status: 'completed', value };
  } catch (error) {
    payload = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (payload) {
      await resumeParentCompletion(completionToken, payload);
    }
  }
}

async function spawnChildWithCompletion(
  item: string,
  completionToken: string
): Promise<string> {
  'use step';

  const run = await start(childWorkflowWithCompletion, [item, completionToken]);
  return run.runId;
}

// Parent workflow — spawns one child and waits via hook resume
export async function parentWorkflow(item: string) {
  'use workflow';

  const hook = childCompletionHook.create({
    token: `child-completion:${item}`,
  });

  const childRunId = await spawnChildWithCompletion(item, hook.token);
  const completion = await hook;

  if (completion.status === 'failed') {
    throw new Error(completion.error);
  }

  return {
    childRunId,
    result: completion.value as { item: string; result: string },
  };
}
