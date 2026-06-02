import { createLlmsRoute } from '@vercel/geistdocs/routes/llms';
import { allSources } from '@/lib/geistdocs/source';

export const { GET, revalidate } = createLlmsRoute({
  sources: allSources,
});
