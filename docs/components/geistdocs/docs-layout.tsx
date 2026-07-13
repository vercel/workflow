import { GeistdocsDocsLayout as PackageDocsLayout } from '@vercel/geistdocs/layout';
import { GeistdocsVersionSelect } from '@vercel/geistdocs/versions';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { config } from '@/lib/geistdocs/config';

type DocsTree = ComponentProps<typeof PackageDocsLayout>['tree'];
type DocsTreeNode = DocsTree['children'][number];

const SIDEBAR_ITEM_BADGES: Array<{ suffix: string; label: string }> = [
  { suffix: '/docs/getting-started/python', label: 'Beta' },
  { suffix: '/v5/docs/getting-started/python', label: 'Beta' },
];

const getSidebarBadge = (url?: string) =>
  url ? SIDEBAR_ITEM_BADGES.find((badge) => url.endsWith(badge.suffix)) : null;

const withSidebarBadge = <T extends { name: ReactNode; url?: string }>(
  item: T
): T => {
  const badge = getSidebarBadge(item.url);

  if (!badge) {
    return item;
  }

  return {
    ...item,
    name: (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="truncate">{item.name}</span>
        <span className="shrink-0 rounded-sm bg-gray-200 px-1.5 py-0.5 font-medium text-[10px] text-gray-1000 leading-none dark:bg-gray-300">
          {badge.label}
        </span>
      </span>
    ),
  };
};

const addSidebarBadges = (nodes: DocsTreeNode[]): DocsTreeNode[] =>
  nodes.map((node) => {
    if (node.type === 'page') {
      return withSidebarBadge(node);
    }

    if (node.type === 'folder') {
      return {
        ...node,
        index: node.index ? withSidebarBadge(node.index) : node.index,
        children: addSidebarBadges(node.children),
      };
    }

    return node;
  });

const addSidebarBadgesToTree = (tree: DocsTree): DocsTree => ({
  ...tree,
  children: addSidebarBadges(tree.children),
});

interface DocsLayoutProps {
  children: ReactNode;
  currentVersion?: string;
  tree: ComponentProps<typeof PackageDocsLayout>['tree'];
}

export const DocsLayout = ({
  tree,
  currentVersion = config.versions?.current,
  children,
}: DocsLayoutProps) => (
  <PackageDocsLayout
    config={config}
    containerProps={{
      className: 'bg-background-100 max-w-[1448px] mx-auto',
      style: {
        '--fd-docs-row-1': '4rem',
      } as CSSProperties,
    }}
    sidebarTop={
      config.versions ? (
        <GeistdocsVersionSelect
          current={currentVersion}
          versions={config.versions}
        />
      ) : null
    }
    tree={addSidebarBadgesToTree(tree)}
  >
    {children}
  </PackageDocsLayout>
);
