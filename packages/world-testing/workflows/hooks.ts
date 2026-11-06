import { createHook, defineHook, getWritable } from '@workflow/core';
import * as z from 'zod';

export const Hook = defineHook({
  schema: z.compile(
    z.object({
      data: z.string(),
      done: z.boolean().optional(),
      metadata: z.unknown(),
    })
  ),
});

export async function collectWithHook(token: string, customData: string) {
  'use workflow';

  const hook = Hook.create({ token, metadata: { customData } });
  const collected: Parameters<(typeof Hook)['resume']>[1][] = [];
  const wf = getWritable();
  await writeEvent(wf, 'hookCreated');
  for await (const event of hook) {
    await writeEvent(wf, 'hookResumed', event);
    collected.push(event);
    if (event.done) break;
  }

  return { collected };
}

async function writeEvent(
  writable: WritableStream,
  event: string,
  payload?: unknown
) {
  'use step';

  console.log('writing event', event, payload);
  const writer = writable.getWriter();
  await writer.write(
    new TextEncoder().encode(
      `${JSON.stringify({
        event,
        payload,
      })}\r\n`
    )
  );
}

// Deliberately leave the hook undisposed: the World must release its token
// when the run completes or fails, without relying on a hook_disposed event.
export async function registerUntilTerminal(token: string, fail: boolean) {
  'use workflow';

  const hook = createHook({ token });
  if (await hook.getConflict()) throw new Error('Token was not released');
  if (fail) throw new Error('Intentional terminal failure');
  return 'registered';
}
