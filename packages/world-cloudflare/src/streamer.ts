import type { Streamer } from '@workflow/world';
import type { CloudflareWorldConfig } from './config.js';
import { doFetch, doFetchStream, getRunStub } from './util.js';

/**
 * Creates a Streamer implementation backed by Durable Objects.
 * Stream chunks are stored in the run's DO storage.
 */
export function createStreamer(config: CloudflareWorldConfig): Streamer {
  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ): Promise<void> {
      const runId = await _runId;
      const stub = getRunStub(config.runs, runId);
      const chunkData =
        typeof chunk === 'string'
          ? [...new TextEncoder().encode(chunk)]
          : [...chunk];

      await stub.fetch(`http://do/streams/${encodeURIComponent(name)}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunk: chunkData, runId }),
      });
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ): Promise<void> {
      if (chunks.length === 0) return;
      const runId = await _runId;
      const stub = getRunStub(config.runs, runId);
      const serializedChunks = chunks.map((chunk) =>
        typeof chunk === 'string'
          ? [...new TextEncoder().encode(chunk)]
          : [...chunk]
      );

      await stub.fetch(
        `http://do/streams/${encodeURIComponent(name)}/write-multi`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chunks: serializedChunks, runId }),
        }
      );
    },

    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      const runId = await _runId;
      const stub = getRunStub(config.runs, runId);
      await stub.fetch(`http://do/streams/${encodeURIComponent(name)}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      // readFromStream doesn't receive runId in the interface.
      // The stream name typically encodes the runId. We need a convention.
      // For Cloudflare, we expect stream names to be formatted as `{runId}:{streamName}`.
      const parts = name.split(':');
      if (parts.length < 2) {
        throw new Error(
          'Stream name must be in format "runId:streamName" for Cloudflare world'
        );
      }
      const runId = parts[0];
      const streamName = parts.slice(1).join(':');

      const stub = getRunStub(config.runs, runId);
      const qs = startIndex ? `?startIndex=${startIndex}` : '';
      return doFetchStream(
        stub,
        `/streams/${encodeURIComponent(streamName)}/read${qs}`
      );
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      const stub = getRunStub(config.runs, runId);
      const names = await doFetch<string[]>(stub, '/streams');
      // Prefix each stream name with `runId:` so the result can be passed
      // directly to readFromStream, which expects that format.
      return names.map((name) => `${runId}:${name}`);
    },
  };
}
