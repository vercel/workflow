import { createProcessor } from '@mdx-js/mdx';
import type { GeistdocsSourceBundle } from '@vercel/geistdocs/source';
import type { Nodes } from 'mdast';
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx';
import { resolveLanguage } from '../language';

type LanguageElement = MdxJsxFlowElement | MdxJsxTextElement;
type Page = Parameters<GeistdocsSourceBundle['getPageMarkdown']>[0];

export interface LanguageMarkdownSource extends GeistdocsSourceBundle {
  getPageMarkdown(page: Page, language?: string | null): Promise<string>;
}

function stringAttribute(node: LanguageElement, name: string) {
  const attribute = node.attributes.find(
    (attribute) =>
      attribute.type === 'mdxJsxAttribute' && attribute.name === name
  );
  if (!attribute || attribute.type !== 'mdxJsxAttribute') return undefined;
  if (typeof attribute.value === 'string') return attribute.value;

  // Accept string literals in braces, without evaluating MDX expressions.
  const statement = attribute.value?.data?.estree?.body[0];
  if (
    statement?.type === 'ExpressionStatement' &&
    statement.expression.type === 'Literal' &&
    typeof statement.expression.value === 'string'
  ) {
    return statement.expression.value;
  }

  throw new TypeError(`${node.name}.${name} must be a string literal`);
}

/** Select language components while leaving the surrounding Markdown intact. */
export function renderLanguageMarkdown(
  markdown: string,
  language: string
): string {
  if (!/<Language(?:Content|Text|Link)\b/.test(markdown)) return markdown;

  const tree = createProcessor().parse(markdown);

  function renderRange(start: number, end: number, children: Nodes[]): string {
    let result = '';
    let cursor = start;
    for (const child of children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (childStart === undefined || childEnd === undefined) continue;
      result += markdown.slice(cursor, childStart) + renderNode(child);
      cursor = childEnd;
    }
    return result + markdown.slice(cursor, end);
  }

  function renderContent(node: LanguageElement): string {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    // Attribute positions skip quoted/expression values containing `>`.
    // Slice only the tags, retaining whitespace even for inline content.
    const attributesEnd = node.attributes.at(-1)?.position?.end.offset ?? start;
    const contentStart = markdown.indexOf('>', attributesEnd) + 1;
    if (markdown.slice(contentStart - 2, contentStart) === '/>') return '';
    const contentEnd = markdown.lastIndexOf('</', end - 1);
    return renderRange(contentStart, contentEnd, node.children);
  }

  function renderElement(node: LanguageElement): string | undefined {
    switch (node.name) {
      case 'LanguageText':
        return stringAttribute(node, language) ?? '';
      case 'LanguageContent':
        return stringAttribute(node, 'value') === language
          ? renderContent(node)
          : '';
      case 'LanguageLink': {
        const href = stringAttribute(node, language);
        if (href === undefined) return '';
        const destination = href.replace(/[\\()\s<>]/g, (character) =>
          encodeURIComponent(character).replace('(', '%28').replace(')', '%29')
        );
        const title = stringAttribute(node, 'title');
        const suffix = title ? ` ${JSON.stringify(title)}` : '';
        return `[${renderContent(node).trim()}](${destination}${suffix})`;
      }
    }
  }

  function renderNode(node: Nodes): string {
    if (
      node.type === 'mdxJsxFlowElement' ||
      node.type === 'mdxJsxTextElement'
    ) {
      const rendered = renderElement(node);
      if (rendered !== undefined) return rendered;
    }
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    return 'children' in node
      ? renderRange(start, end, node.children)
      : markdown.slice(start, end);
  }

  return renderRange(0, markdown.length, tree.children);
}

/** Filter before Geistdocs assembles metadata and rewrites versioned links. */
export function withLanguageMarkdown(
  bundle: GeistdocsSourceBundle
): LanguageMarkdownSource {
  return {
    ...bundle,
    getPageMarkdown(page, requestedLanguage) {
      const data = page.data as Page['data'] & {
        languageSwitcher?: string[];
        getText(kind: 'processed'): Promise<string>;
      };
      const language = resolveLanguage(
        data.languageSwitcher ?? [],
        requestedLanguage
      );
      const selectedData = {
        ...data,
        getText: async (kind: 'processed') =>
          renderLanguageMarkdown(await data.getText(kind), language),
      };
      return bundle.getPageMarkdown({
        ...page,
        data: selectedData,
      });
    },
  };
}
