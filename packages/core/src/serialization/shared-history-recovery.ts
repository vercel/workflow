import { getWorldLazy } from '../runtime/get-world-lazy.js';
import type { PayloadKey } from './encryption.js';
import { peekFormatPrefix } from './format.js';
import { SharedHistoryContext } from './shared-history.js';
/** Cold recovery only; no workflow execution, predecessor input GETs or recursive refs. */
export async function recoverSharedHistory(
  runId: string,
  key: PayloadKey | undefined,
  data: unknown
): Promise<SharedHistoryContext | undefined> {
  if (
    !(data instanceof Uint8Array) ||
    peekFormatPrefix(data) !== 'devl' ||
    !new TextDecoder().decode(data).includes('"SharedHistoryV1"')
  )
    return;
  const world = await getWorldLazy();
  const context = new SharedHistoryContext();
  const { prepareReplayPayload } = await import('../serialization.js');
  const run = await world.runs.get(runId, { resolveData: 'all' });
  const initial = (await prepareReplayPayload(run.input, key)).data;
  if (initial instanceof Uint8Array && peekFormatPrefix(initial) === 'devl')
    context.ingestPrepared(initial);
  let cursor: string | undefined;
  const seen = new Set<string>();
  let bytes = 0;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await world.events.list({
      runId,
      resolveData: 'skip-step-inputs',
      pagination: { cursor, sortOrder: 'asc', limit: 1000 },
    });
    context.stats.recoveryFetches++;
    const prepared = await Promise.all(
      page.data.map(async (event) => {
        const value =
          event.eventType === 'hook_received'
            ? event.eventData?.payload
            : event.eventType === 'step_completed'
              ? event.eventData?.result
              : undefined;
        return value === undefined
          ? undefined
          : (await prepareReplayPayload(value, key)).data;
      })
    );
    for (const value of prepared) {
      if (!(value instanceof Uint8Array) || peekFormatPrefix(value) !== 'devl')
        continue;
      bytes += value.byteLength;
      if (bytes > 256 * 1024 * 1024)
        throw new Error('Shared history recovery byte limit');
      context.ingestPrepared(value);
    }
    if (!page.hasMore) return context;
    if (!page.cursor || seen.has(page.cursor))
      throw new Error('Shared history cursor did not advance');
    seen.add(page.cursor);
    cursor = page.cursor;
  }
  throw new Error('Shared history recovery page limit');
}
