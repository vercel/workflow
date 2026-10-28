import type { Root } from 'fumadocs-core/page-tree';
import { getDocsTreeWithoutCookbook } from './cookbook-source';
import type { DocsVersion } from './versions';
import { MAINTENANCE_VERSION } from './versions';

function rewriteUrl(url: string, prefix: string): string;
function rewriteUrl(url: undefined, prefix: string): undefined;
function rewriteUrl(url: string | undefined, prefix: string) {
  if (!url || !prefix) return url;
  // Only rewrite in-app docs links. External and cookbook links are left alone.
  if (!url.startsWith('/docs')) return url;
  return `${prefix}${url}`;
}

function rewriteNodeUrls(
  nodes: Root['children'],
  prefix: string
): Root['children'] {
  return nodes.map((node) => {
    if (node.type === 'page') {
      return { ...node, url: rewriteUrl(node.url, prefix) };
    }
    if (node.type === 'folder') {
      return {
        ...node,
        children: rewriteNodeUrls(node.children, prefix),
        ...(node.index
          ? {
              index: {
                ...node.index,
                url: rewriteUrl(node.index.url, prefix),
              },
            }
          : {}),
      };
    }
    return node;
  });
}

/**
 * Build the sidebar tree for a given docs version.
 *
 * - v5 (latest): returns the v5 source tree (content/docs/v5) with cookbook
 *   nodes stripped. No URL rewriting needed — the current version is served
 *   unprefixed.
 * - v4 (maintenance): returns the v4 source tree (content/docs/v4) with
 *   cookbook nodes stripped and URLs rewritten to the `/v4/docs/...` namespace
 *   so sidebar links stay inside the v4 view.
 */
export function getDocsTreeForVersion(
  lang: string,
  version: DocsVersion
): Root {
  if (version.maintenance) {
    const base = getDocsTreeWithoutCookbook(lang, 'v4');
    return {
      ...base,
      children: rewriteNodeUrls(base.children, version.prefix),
    };
  }
  return getDocsTreeWithoutCookbook(lang, 'v5');
}

export { MAINTENANCE_VERSION };
