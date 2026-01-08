import type { Streamer } from '@workflow/world';
import { type APIConfig, getHttpConfig, type HttpConfig } from './utils.js';

function getStreamUrl(
  name: string,
  runId: string | undefined,
  httpConfig: HttpConfig
) {
  if (runId) {
    return new URL(
      `${httpConfig.baseUrl}/v1/runs/${runId}/stream/${encodeURIComponent(name)}`
    );
  }
  return new URL(`${httpConfig.baseUrl}/v1/stream/${encodeURIComponent(name)}`);
}

export function createStreamer(config?: APIConfig): Streamer {
  return {
    async writeToStream(
      name: string,
      runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const resolvedRunId = await runId;

      const httpConfig = await getHttpConfig(config);
      await fetch(getStreamUrl(name, resolvedRunId, httpConfig), {
        method: 'PUT',
        body: chunk,
        headers: httpConfig.headers,
        duplex: 'half',
      });
    },

    async closeStream(name: string, runId: string | Promise<string>) {
      // Await runId if it's a promise to ensure proper flushing
      const resolvedRunId = await runId;

      const httpConfig = await getHttpConfig(config);
      httpConfig.headers.set('X-Stream-Done', 'true');
      await fetch(getStreamUrl(name, resolvedRunId, httpConfig), {
        method: 'PUT',
        headers: httpConfig.headers,
      });
    },

    async readFromStream(name: string, startIndex?: number) {
      const httpConfig = await getHttpConfig(config);
      const url = getStreamUrl(name, undefined, httpConfig);
      if (typeof startIndex === 'number') {
        url.searchParams.set('startIndex', String(startIndex));
      }
      const res = await fetch(url, { headers: httpConfig.headers });
      if (!res.ok) throw new Error(`Failed to fetch stream: ${res.status}`);
      return res.body as ReadableStream<Uint8Array>;
    },

    async listStreamsByRunId(runId: string) {
      const httpConfig = await getHttpConfig(config);
      const url = new URL(`${httpConfig.baseUrl}/v1/runs/${runId}/streams`);
      const res = await fetch(url, { headers: httpConfig.headers });
      if (!res.ok) throw new Error(`Failed to list streams: ${res.status}`);
      return (await res.json()) as string[];
    },
  };
}
