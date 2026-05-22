import { sleep } from 'workflow';

async function processItem(
  item: string
): Promise<{ item: string; ok: boolean }> {
  'use step';
  return { item, ok: true };
}

export async function batchWorkflow(items: string[], batchSize: number = 3) {
  'use workflow';

  const results: Array<{ item: string; ok: boolean }> = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    const outcomes = await Promise.allSettled(
      batch.map((item) => processItem(item))
    );

    for (let j = 0; j < outcomes.length; j++) {
      const outcome = outcomes[j];
      results.push(
        outcome.status === 'fulfilled'
          ? outcome.value
          : { item: batch[j], ok: false }
      );
    }

    if (i + batchSize < items.length) {
      await sleep('1s');
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}
