import type { Folder, Node, Root } from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';

export interface SectionChild {
  title: ReactNode;
  url: string;
  description?: ReactNode;
  icon?: ReactNode;
}

/**
 * Find the folder whose index page is served at `sectionUrl` (e.g. the
 * `foundations` folder for `/docs/foundations`). Searches the tree recursively
 * so it works regardless of nesting depth.
 */
function findSectionFolder(
  nodes: Node[],
  sectionUrl: string
): Folder | undefined {
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    if (node.index?.url === sectionUrl) return node;
    const nested = findSectionFolder(node.children, sectionUrl);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Resolve the child pages of a section's landing page directly from the
 * fumadocs page tree — the same tree that builds the sidebar (driven by
 * `meta.json` + page frontmatter). This is the single source of truth shared by
 * the `<AutoCards />` component, the markdown export in `getLLMText`, and the
 * docs lint, so the card grid can never drift from the navigation.
 *
 * Children are returned in navigation order. Both leaf pages and sub-folders
 * (which surface via their own index page) become cards; separators and
 * index-less folders are skipped.
 */
export function resolveSectionChildren(
  tree: Root,
  sectionUrl: string
): SectionChild[] {
  const folder = findSectionFolder(tree.children, sectionUrl);
  if (!folder) return [];

  const children: SectionChild[] = [];
  for (const child of folder.children) {
    if (child.type === 'page') {
      children.push({
        title: child.name,
        url: child.url,
        description: child.description,
        icon: child.icon,
      });
    } else if (child.type === 'folder' && child.index) {
      children.push({
        title: child.index.name ?? child.name,
        url: child.index.url,
        description: child.index.description ?? child.description,
        icon: child.index.icon ?? child.icon,
      });
    }
  }
  return children;
}
