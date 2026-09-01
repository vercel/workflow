import type { Node, Root } from 'fumadocs-core/page-tree';
import {
  categoryLabels,
  categoryOrder,
  type RecipeCategory,
  recipes,
} from '../cookbook-tree';
import { source, v4Source } from './source';

const COOKBOOK_DOCS_PREFIX_RE = /\/docs\/cookbook(?=\/|$)/g;

type FolderNode = Extract<Node, { type: 'folder' }>;
type PageNode = Extract<Node, { type: 'page' }>;

export function rewriteCookbookUrl(url: string): string {
  return url.replace(COOKBOOK_DOCS_PREFIX_RE, '/cookbook');
}

/**
 * Rewrite a fumadocs source URL (`/docs/cookbook/...`) to the public cookbook
 * URL for a given version prefix. Pass '' for v5 (`/cookbook/...`) or '/v4'
 * for v4 (`/v4/cookbook/...`).
 */
export function rewriteCookbookUrlForVersion(
  url: string,
  versionPrefix: string
): string {
  return url.replace(COOKBOOK_DOCS_PREFIX_RE, `${versionPrefix}/cookbook`);
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
 * Pass 'v4' to use the v4 source tree; defaults to 'v5' (the current version).
 */
export function getDocsTreeWithoutCookbook(
  lang: string,
  version: 'v4' | 'v5' = 'v5'
): Root {
  const src = version === 'v4' ? v4Source : source;
  const fullTree = src.pageTree[lang];
  return {
    ...fullTree,
    children: fullTree.children.filter((node) => !isCookbookFolder(node)),
  };
}

function createOverviewPage(versionPrefix: string): PageNode {
  return {
    type: 'page',
    $id: 'cookbook__overview',
    name: 'Overview',
    url: `${versionPrefix}/cookbook`,
  } as PageNode;
}

function createRecipePage(
  category: RecipeCategory,
  slug: string,
  versionPrefix: string
): PageNode {
  const versionId = versionPrefix ? versionPrefix.replace(/^\//, '') : 'v5';
  const recipe = recipes[slug];
  const versionedRecipe = {
    ...recipe,
    ...recipe.versionOverrides?.[versionId],
  };
  return {
    type: 'page',
    $id: `cookbook__${slug}`,
    name: versionedRecipe.title,
    description: versionedRecipe.description,
    url: `${versionPrefix}/cookbook/${category}/${slug}`,
  } as PageNode;
}

function createCategoryFolder(
  category: RecipeCategory,
  versionPrefix: string
): FolderNode {
  // Derive version ID from prefix: '/v4' → 'v4', '' → 'v5'
  const versionId = versionPrefix ? versionPrefix.replace(/^\//, '') : 'v5';
  const categoryRecipes = Object.values(recipes).filter(
    (recipe) =>
      recipe.category === category && !recipe.skipVersions?.includes(versionId)
  );
  return {
    type: 'folder',
    $id: `cookbook__${category}`,
    name: categoryLabels[category],
    children: categoryRecipes.map((recipe) =>
      createRecipePage(category as RecipeCategory, recipe.slug, versionPrefix)
    ),
  } as FolderNode;
}

/**
 * Build a standalone cookbook sidebar tree from cookbook-tree metadata.
 * Pass a versionPrefix (e.g. '/v4') to produce version-prefixed sidebar URLs.
 */
export function getCookbookTree(lang: string, versionPrefix = ''): Root {
  const src = versionPrefix ? v4Source : source;
  const fullTree = src.pageTree[lang];

  return {
    ...fullTree,
    $id: `cookbook__root__${versionPrefix ? versionPrefix.replace(/^\//, '') : 'v5'}`,
    name: 'Cookbook',
    children: [
      createOverviewPage(versionPrefix),
      ...categoryOrder.map((category) =>
        createCategoryFolder(category, versionPrefix)
      ),
    ],
  };
}
