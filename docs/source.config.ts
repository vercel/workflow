import {
  defineGeistdocsSourceConfig,
  geistdocsFrontmatterSchema,
  geistdocsMetaSchema,
} from '@vercel/geistdocs/source-config';
import { defineDocs } from 'fumadocs-mdx/config';
import { z } from 'zod';

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
const docsSchema = geistdocsFrontmatterSchema.extend({
  // Opt a section landing page out of the card↔nav completeness lint when its
  // `<Cards>` grid is intentionally curated (e.g. links outside the section or
  // deliberately omits children). Exhaustive list pages should use `<AutoCards />`
  // instead, which derives cards from the page tree and can never drift.
  manualCards: z.boolean().optional(),
});

export const v4docs = defineDocs({
  dir: 'content/docs/v4',
  docs: {
    schema: docsSchema,
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
    schema: docsSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: geistdocsMetaSchema,
  },
});

export default defineGeistdocsSourceConfig();
