import { createSearchExportRoute } from '@vercel/geistdocs/routes/search-export';
import { config } from '@/lib/geistdocs/config';
import { currentSources } from '@/lib/geistdocs/source';

// This app does not enable cacheComponents, and `geistdocs search sync`
// reads only a statically generated export.
export const dynamic = 'force-static';

export const { GET } = createSearchExportRoute({
  config,
  sources: currentSources,
});
