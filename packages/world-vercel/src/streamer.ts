import type { Streamer } from '@workflow/world';
import { type APIConfig, getHttpConfig, type HttpConfig } from './utils.js';

function getStreamUrl(runId: string, name: string, httpConfig: HttpConfig) {
  return new URL(
    `${httpConfig.baseUrl}/v1/run/${runId}/stream/${encodeURIComponent(name)}`
  );
}

export function createStreamer(config?: APIConfig): Streamer {
  return {
    async writeToStream(
      runId: string,
      name: string,
      chunk: string | Uint8Array
    ) {
      const httpConfig = await getHttpConfig(config);
      await fetch(getStreamUrl(runId, name, httpConfig), {
        method: 'PUT',
        body: chunk,
        headers: httpConfig.headers,
        duplex: 'half',
      });
    },

    async closeStream(runId: string, name: string) {
      const httpConfig = await getHttpConfig(config);
      httpConfig.headers.set('X-Stream-Done', 'true');
      await fetch(getStreamUrl(runId, name, httpConfig), {
        method: 'PUT',
        headers: httpConfig.headers,
      });
    },

    async readFromStream(runId: string, name: string, startIndex?: number) {
      const httpConfig = await getHttpConfig(config);
      const url = getStreamUrl(runId, name, httpConfig);
      if (typeof startIndex === 'number') {
        url.searchParams.set('startIndex', String(startIndex));
      }
      const res = await fetch(url, { headers: httpConfig.headers });
      if (!res.ok) throw new Error(`Failed to fetch stream: ${res.status}`);
      return res.body as ReadableStream<Uint8Array>;
    },
  };
}
