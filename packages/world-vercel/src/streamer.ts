import type { Streamer } from '@workflow/world';
import { type APIConfig, getHttpConfig, type HttpConfig } from './utils.js';

function getStreamUrl(
  name: string,
  runId: string | undefined,
  httpConfig: HttpConfig
) {
  if (runId) {
    return new URL(
      `${httpConfig.baseUrl}/v1/run/${runId}/stream/${encodeURIComponent(name)}`
    );
  }
  return new URL(`${httpConfig.baseUrl}/v1/stream/${encodeURIComponent(name)}`);
}

export function createStreamer(config?: APIConfig): Streamer {
  return {
    async writeToStream(
      name: string,
      runId: string,
      chunk: string | Uint8Array
    ) {
      const httpConfig = await getHttpConfig(config);
      await fetch(getStreamUrl(name, runId, httpConfig), {
        method: 'PUT',
        body: chunk,
        headers: httpConfig.headers,
        duplex: 'half',
      });
    },

    async closeStream(name: string) {
      const httpConfig = await getHttpConfig(config);
      httpConfig.headers.set('X-Stream-Done', 'true');
      await fetch(getStreamUrl(name, undefined, httpConfig), {
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
  };
}
