import { createDocsMarkdownRoute } from '@vercel/geistdocs/routes/llms';
import { allSources } from '@/lib/geistdocs/source';
import { canViewPage } from '@/lib/geistdocs/visibility';

export const { GET, generateStaticParams, revalidate } =
  createDocsMarkdownRoute({
    canViewPage,
    sources: allSources,
  });
