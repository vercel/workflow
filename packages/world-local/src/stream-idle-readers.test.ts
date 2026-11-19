import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { databaseFor } from './db/index.js';
import { createStreamer } from './streamer.js';

/**
 * An idle reader at the tail of a stream polls for new chunks and for the
 * end of the stream (#4830). Each poll must cost the same however long the
 * stream is: a poll that scanned the stream made 32 idle readers of a
 * 23,500-chunk stream use more than half a core.
 */

const RUN_ID = 'wrun_01M6IDLE00000000000000000';
const READERS = 16;
const IDLE_MS = 1_000;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stream-idle-'));
});

afterEach(() => {
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** CPU time (ms) that `READERS` idle readers at the tail of a `chunks`-chunk stream use in `IDLE_MS`. */
async function idleReaderCpuMs(name: string, chunks: number): Promise<number> {
  const { streams } = createStreamer(dataDir);
  const chunk = new Uint8Array(16);
  for (let written = 0; written < chunks; written += 1_000) {
    await streams.writeMulti(
      RUN_ID,
      name,
      Array.from({ length: Math.min(1_000, chunks - written) }, () => chunk)
    );
  }
  const readers = await Promise.all(
    Array.from({ length: READERS }, () => streams.get(RUN_ID, name, chunks))
  );
  const reads = readers.map((stream) => stream.getReader());
  // Let the readers settle at the tail before measuring.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  const used = process.cpuUsage(before);
  for (const read of reads) await read.cancel();
  return (used.user + used.system) / 1_000;
}

it('an idle reader costs the same at the tail of a long stream as of a short one', async () => {
  const short = await idleReaderCpuMs('short', 100);
  const long = await idleReaderCpuMs('long', 20_000);
  // Against the same measurement on a short stream, so the bound does not
  // depend on the machine; plus a floor for the noise of a near-idle process.
  expect(long, `short: ${short} ms, long: ${long} ms`).toBeLessThan(
    Math.max(2 * short, 100)
  );
}, 60_000);
