import { createDocsMarkdownRoute } from '@vercel/geistdocs/routes/llms';
import { allSources } from '@/lib/geistdocs/source';

export const { GET, generateStaticParams, revalidate } =
  createDocsMarkdownRoute({
    sources: allSources,
  });
