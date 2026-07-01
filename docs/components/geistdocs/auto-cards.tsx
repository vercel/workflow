import { Card, Cards } from 'fumadocs-ui/components/card';
import type { SectionChild } from '@/lib/geistdocs/section-children';

/**
 * Renders a card grid for a section landing page from children resolved off the
 * fumadocs page tree (see `resolveSectionChildren`). Because the list is derived
 * from `meta.json` + page frontmatter rather than hand-written, the cards can
 * never drift from the sidebar navigation.
 *
 * The `items` are bound per-request in the docs route handlers, where the active
 * version's page tree and the current page URL are known.
 */
export function AutoCards({ items }: { items: SectionChild[] }) {
  return (
    <Cards>
      {items.map((item) => (
        <Card
          key={item.url}
          href={item.url}
          title={item.title}
          description={item.description}
          icon={item.icon}
        />
      ))}
    </Cards>
  );
}
