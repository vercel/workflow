import { createLlmsRoute } from '@vercel/geistdocs/routes/llms';
import { currentSources } from '@/lib/geistdocs/source';

export const { GET, revalidate } = createLlmsRoute({
  sources: currentSources,
});
