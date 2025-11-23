import { defineHook, getWritable } from 'workflow';
import * as z from 'zod';

export const Hook = defineHook({
  schema: z.object({
    data: z.string(),
    done: z.boolean().optional(),
    metadata: z.unknown(),
  }),
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
