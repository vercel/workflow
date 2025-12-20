import { source } from '@/lib/geistdocs/source';
import type { Node, Root } from 'fumadocs-core/page-tree';

export const revalidate = false;
export const dynamic = 'force-static';

export async function GET(_req: Request) {
  let mdText = '';

  function traverseTree(node: Node | Root, depth = 0) {
    const indent = '  '.repeat(depth);

    if ('type' in node) {
      if (node.type === 'page') {
        mdText += `${indent}- [${node.name}](${node.url})\n`;
      } else if (node.type === 'folder') {
        if (node.index) {
          mdText += `${indent}- [${node.name}](${node.index.url})\n`;
        } else {
          mdText += `${indent}- ${node.name}\n`;
        }
        if (node.children.length > 0) {
          for (const child of node.children) {
            traverseTree(child, depth + 1);
          }
        }
      }
    } else {
      // Root node
      if (node.children.length > 0) {
        for (const child of node.children) {
          traverseTree(child, depth);
        }
      }
    }
  }

  const tree = source.getPageTree();
  traverseTree(tree, 0);

  return new Response(mdText, {
    headers: {
      'Content-Type': 'text/markdown',
    },
  });
}
