import {
  defineGeistdocsSourceConfig,
  geistdocsFrontmatterSchema,
  geistdocsMetaSchema,
} from '@vercel/geistdocs/source-config';
import { defineDocs } from 'fumadocs-mdx/config';

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const v4docs = defineDocs({
  dir: 'content/docs/v4',
  docs: {
    schema: geistdocsFrontmatterSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: geistdocsMetaSchema,
  },
});

export const v5docs = defineDocs({
  dir: 'content/docs/v5',
  docs: {
    schema: geistdocsFrontmatterSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: geistdocsMetaSchema,
  },
});

export default defineGeistdocsSourceConfig();
