import type { Root } from 'fumadocs-core/page-tree';
import { type InferPageType, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { v4docs, v5docs } from '@/.source/server';
import { basePath } from '@/geistdocs';
import { i18n } from './i18n';
import { resolveSectionChildren } from './section-children';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  i18n,
  baseUrl: '/docs',
  source: v4docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export const v5Source = loader({
  i18n,
  baseUrl: '/docs',
  source: v5docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export const getPageImage = (page: InferPageType<typeof source>) => {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: basePath
      ? `${basePath}/og/${segments.join('/')}`
      : `/og/${segments.join('/')}`,
  };
};

// Matches the `<AutoCards />` placeholder (self-closing or paired) so the
// markdown export can substitute the rendered card list. The component itself
// only renders in the React tree, so without this the agent-facing markdown
// (llms.txt, .md routes, copy-page) would lose every child link.
const AUTO_CARDS_RE = /<AutoCards\b[^>]*?(?:\/>|>[\s\S]*?<\/AutoCards>)/g;

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Render the `<Cards>`/`<Card>` JSX a section landing page would have contained
 * by hand, derived from the page tree. Matching the existing serialized format
 * keeps the markdown export consistent across converted and unconverted pages.
 */
function renderAutoCardsMarkdown(tree: Root, sectionUrl: string): string {
  const cards = resolveSectionChildren(tree, sectionUrl)
    .map((child) => {
      const title = asText(child.title);
      const description = asText(child.description);
      const open = `<Card href="${child.url}" title="${title}">`;
      return description ? `${open}${description}</Card>` : `${open}</Card>`;
    })
    .join('\n');
  return `<Cards>\n${cards}\n</Cards>`;
}

export const getLLMText = async (
  page: InferPageType<typeof source>,
  tree?: Root
) => {
  let processed = await page.data.getText('processed');
  if (tree) {
    // `.replace` is a no-op when there's no placeholder, and the replacer only
    // walks the tree on an actual match.
    processed = processed.replace(AUTO_CARDS_RE, () =>
      renderAutoCardsMarkdown(tree, page.url)
    );
  }
  const { title, description, product, type, summary, prerequisites, related } =
    page.data;

  const frontmatter = [
    '---',
    `title: ${title}`,
    description && `description: ${description}`,
    product && `product: ${product}`,
    type && `type: ${type}`,
    summary && `summary: ${summary}`,
    prerequisites?.length &&
      `prerequisites:\n${prerequisites.map((p) => `  - ${p}`).join('\n')}`,
    related?.length && `related:\n${related.map((r) => `  - ${r}`).join('\n')}`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  return `${frontmatter}

# ${title}

${processed}`;
};
