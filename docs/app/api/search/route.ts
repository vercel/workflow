import { createSearchRoute } from '@vercel/geistdocs/routes/search';
import { config } from '@/lib/geistdocs/config';
import { currentSources } from '@/lib/geistdocs/source';

const bootedAt = Date.now();

// Throwaway timing for the preview comparison: how long the Mixedbread call
// takes from this function, and how long the whole request takes.
const timedFetch: typeof fetch = async (input, init) => {
  const start = performance.now();
  const response = await fetch(input, init);
  const headersMs = Math.round(performance.now() - start);
  const body = await response.arrayBuffer();
  console.log(
    `[search-timing] mixedbread status=${response.status} headersMs=${headersMs} totalMs=${Math.round(performance.now() - start)} bytes=${body.byteLength}`
  );
  return new Response(body, {
    headers: { 'content-type': 'application/json' },
    status: response.status,
    statusText: response.statusText,
  });
};

const search = createSearchRoute({
  config,
  sources: currentSources,
  // Throwaway, for the preview comparison: real Mixedbread calls often exceed
  // the 1500 ms default, and a timeout answers from local search without a
  // visible sign.
  mixedbread: { fetchImpl: timedFetch, requestTimeoutMs: 8000 },
});

export const GET = async (request: Request) => {
  const start = performance.now();
  const response = await search(request);
  console.log(
    `[search-timing] handler provider=${response.headers.get('x-geistdocs-search-provider')} totalMs=${Math.round(performance.now() - start)} instanceAgeMs=${Date.now() - bootedAt}`
  );
  return response;
};
