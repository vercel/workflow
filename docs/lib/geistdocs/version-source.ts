import type { Node, Root } from 'fumadocs-core/page-tree';
import { getDocsTreeWithoutCookbook } from './cookbook-source';
import { source } from './source';
import type { DocsVersion } from './versions';
import { PRE_RELEASE_VERSION } from './versions';

type FolderNode = Extract<Node, { type: 'folder' }>;
type PageNode = Extract<Node, { type: 'page' }>;

function isPreReleaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  const page = source.getPageByHref(url);
  return page?.page.data.preRelease === true;
}

function isPreReleasePage(node: PageNode): boolean {
  return isPreReleaseUrl(node.url);
}

function filterPreReleaseFromNodes(nodes: Node[]): Node[] {
  const result: Node[] = [];
  for (const node of nodes) {
    if (node.type === 'page') {
      if (!isPreReleasePage(node)) result.push(node);
      continue;
    }
    if (node.type === 'folder') {
      const children = filterPreReleaseFromNodes(node.children);
      // Drop empty folders that become empty only because of filtering.
      if (children.length === 0 && node.children.length > 0) continue;
      const folder: FolderNode = { ...(node as FolderNode), children };
      // If the folder's index page is itself preRelease, drop the index
      // reference so we don't render a broken link.
      if (folder.index && isPreReleasePage(folder.index as PageNode)) {
        delete folder.index;
      }
      result.push(folder);
      continue;
    }
    result.push(node);
  }
  return result;
}

function rewriteUrl(
  url: string | undefined,
  prefix: string
): string | undefined {
  if (!url || !prefix) return url;
  // Only rewrite in-app docs links. External and cookbook links are left alone.
  if (!url.startsWith('/docs')) return url;
  return `${prefix}${url}`;
}

function rewriteNodeUrls(nodes: Node[], prefix: string): Node[] {
  return nodes.map((node) => {
    if (node.type === 'page') {
      return { ...node, url: rewriteUrl(node.url, prefix) } as PageNode;
    }
    if (node.type === 'folder') {
      const folder = { ...(node as FolderNode) };
      folder.children = rewriteNodeUrls(folder.children, prefix);
      if (folder.index) {
        folder.index = {
          ...folder.index,
          url: rewriteUrl(folder.index.url, prefix),
        } as PageNode;
      }
      return folder;
    }
    return node;
  });
}

/**
 * Build the sidebar tree for a given docs version.
 *
 * - v4 (latest): excludes pages marked `preRelease: true`.
 * - v5 (pre-release): includes every page, with URLs rewritten to the
 *   `/v5/docs/...` namespace so sidebar links stay inside the v5 view.
 */
export function getDocsTreeForVersion(
  lang: string,
  version: DocsVersion
): Root {
  const base = getDocsTreeWithoutCookbook(lang);
  if (version.preRelease) {
    return {
      ...base,
      children: rewriteNodeUrls(base.children, version.prefix),
    };
  }
  return {
    ...base,
    children: filterPreReleaseFromNodes(base.children),
  };
}

export function isPagePreRelease(slug: string[] | undefined): boolean {
  const page = source.getPage(slug ?? []);
  return page?.data.preRelease === true;
}

export { PRE_RELEASE_VERSION };
