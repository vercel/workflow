import type { Node, Root } from 'fumadocs-core/page-tree';
import {
  categoryLabels,
  categoryOrder,
  recipes,
  type RecipeCategory,
} from '../cookbook-tree';
import { source } from './source';

const COOKBOOK_DOCS_PREFIX_RE = /\/docs\/cookbook(?=\/|$)/g;

type FolderNode = Extract<Node, { type: 'folder' }>;
type PageNode = Extract<Node, { type: 'page' }>;

export function rewriteCookbookUrl(url: string): string {
  return url.replace(COOKBOOK_DOCS_PREFIX_RE, '/cookbook');
}

export function rewriteCookbookUrlsInText(text: string): string {
  return text.replace(COOKBOOK_DOCS_PREFIX_RE, '/cookbook');
}

function isCookbookFolder(node: Node): boolean {
  return (
    node.type === 'folder' &&
    (node.index?.url?.startsWith('/docs/cookbook') ?? false)
  );
}

/**
 * Return the docs page tree with cookbook nodes removed.
 * Used by the docs layout so the sidebar never shows cookbook entries.
 */
export function getDocsTreeWithoutCookbook(lang: string): Root {
  const fullTree = source.pageTree[lang];
  return {
    ...fullTree,
    children: fullTree.children.filter((node) => !isCookbookFolder(node)),
  };
}

function createOverviewPage(): PageNode {
  return {
    type: 'page',
    $id: 'cookbook__overview',
    name: 'Overview',
    url: '/cookbook',
  } as PageNode;
}

function createRecipePage(category: RecipeCategory, slug: string): PageNode {
  const recipe = recipes[slug];
  return {
    type: 'page',
    $id: `cookbook__${slug}`,
    name: recipe.title,
    url: `/cookbook/${category}/${slug}`,
  } as PageNode;
}

function createCategoryFolder(category: RecipeCategory): FolderNode {
  const categoryRecipes = Object.values(recipes).filter(
    (recipe) => recipe.category === category
  );
  return {
    type: 'folder',
    $id: `cookbook__${category}`,
    name: categoryLabels[category],
    children: categoryRecipes.map((recipe) =>
      createRecipePage(category as RecipeCategory, recipe.slug)
    ),
  } as FolderNode;
}

/**
 * Build a standalone cookbook sidebar tree from cookbook-tree metadata.
 * No longer depends on locating a cookbook node inside the docs page tree.
 */
export function getCookbookTree(lang: string): Root {
  const fullTree = source.pageTree[lang];

  return {
    ...fullTree,
    name: 'Cookbook',
    children: [
      createOverviewPage(),
      ...categoryOrder.map((category) => createCategoryFolder(category)),
    ],
  };
}
