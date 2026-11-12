import { createSearchRoute } from '@vercel/geistdocs/routes/search';
import { config } from '@/lib/geistdocs/config';
import { currentSources } from '@/lib/geistdocs/source';

export const GET = createSearchRoute({
  config,
  sources: currentSources,
  // Throwaway, for the preview comparison: real Mixedbread calls often exceed
  // the 1500 ms default, and a timeout answers from local search without a
  // visible sign.
  mixedbread: { requestTimeoutMs: 8000 },
});
