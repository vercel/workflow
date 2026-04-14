/**
 * Cookbook: tool-streaming pattern
 *
 * Demonstrates getWritable() inside a step function to stream
 * incremental results to the client while a tool executes.
 */
import { getWritable } from 'workflow';

async function searchWithProgress(query: string) {
  'use step';

  const writable = getWritable<{ type: string; data: unknown }>();
  const writer = writable.getWriter();

  try {
    const items = [
      { title: 'Result A', score: 95 },
      { title: 'Result B', score: 87 },
    ];

    for (const item of items) {
      await writer.write({ type: 'found-item', data: item });
    }

    return { count: items.length, query };
  } finally {
    writer.releaseLock();
  }
}

export async function toolStreamingWorkflow(query: string) {
  'use workflow';

  const result = await searchWithProgress(query);
  return result;
}
