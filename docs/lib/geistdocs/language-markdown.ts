import { createProcessor } from '@mdx-js/mdx';
import type { GeistdocsSourceBundle } from '@vercel/geistdocs/source';
import type { Nodes } from 'mdast';
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx';
import { toMarkdown } from 'mdast-util-to-markdown';
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

function booleanAttribute(node: LanguageElement, name: string): boolean {
  const attribute = node.attributes.find(
    (attribute) =>
      attribute.type === 'mdxJsxAttribute' && attribute.name === name
  );
  if (!attribute || attribute.type !== 'mdxJsxAttribute') return false;
  if (attribute.value === null) return true;

  const statement =
    typeof attribute.value === 'object'
      ? attribute.value.data?.estree?.body[0]
      : undefined;
  if (
    statement?.type === 'ExpressionStatement' &&
    statement.expression.type === 'Literal' &&
    typeof statement.expression.value === 'boolean'
  ) {
    return statement.expression.value;
  }

  throw new TypeError(`${node.name}.${name} must be a boolean literal`);
}

function removeWrapperIndent(content: string, node: LanguageElement): string {
  const start = node.position?.start;
  const childStart = node.children[0]?.position?.start;
  if (
    node.type !== 'mdxJsxFlowElement' ||
    !start ||
    !childStart ||
    childStart.line === start.line ||
    childStart.column - start.column < 2
  ) {
    return content;
  }

  // Fumadocs' JSX serializer adds two spaces per flow wrapper. Remove only
  // that layer, after any enclosing list/blockquote prefix, leaving relative
  // indentation in code blocks and remaining JSX components intact.
  const offset = start.column - 1;
  return content
    .split('\n')
    .map((line, index) =>
      index > 0 && line.slice(offset, offset + 2) === '  '
        ? line.slice(0, offset) + line.slice(offset + 2)
        : line
    )
    .join('\n');
}

/** Select language components while leaving the surrounding Markdown intact. */
export function renderLanguageMarkdown(
  markdown: string,
  language: string
): string {
  if (!/<Language(?:Content|Text|Link)\b/.test(markdown)) return markdown;

  const tree = createProcessor().parse(markdown);

  function isInlineFlowElement(node: Nodes | undefined): boolean {
    return (
      node?.type === 'mdxJsxFlowElement' &&
      (node.name === 'LanguageText' ||
        node.name === 'LanguageLink' ||
        (node.name === 'LanguageContent' && booleanAttribute(node, 'inline')))
    );
  }

  function renderRange(start: number, end: number, children: Nodes[]): string {
    let result = '';
    let cursor = start;
    let previous: Nodes | undefined;
    for (const child of children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (childStart === undefined || childEnd === undefined) continue;
      // MDX promotes paragraphs containing only JSX to flow elements. Their
      // serializer inserts line breaks between otherwise adjacent inline tags.
      const separator =
        isInlineFlowElement(previous) && isInlineFlowElement(child)
          ? ''
          : markdown.slice(cursor, childStart);
      result += separator + renderNode(child);
      cursor = childEnd;
      previous = child;
    }
    return result + markdown.slice(cursor, end);
  }

  function renderContent(node: LanguageElement, inline = false): string {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    // Attribute positions skip quoted/expression values containing `>`.
    // Flow content also loses the serializer's wrapper indentation, which
    // isn't present in the authored MDX.
    const attributesEnd = node.attributes.at(-1)?.position?.end.offset ?? start;
    let contentStart = markdown.indexOf('>', attributesEnd) + 1;
    if (markdown.slice(contentStart - 2, contentStart) === '/>') return '';
    let contentEnd = markdown.lastIndexOf('</', end - 1);
    if (inline) {
      if (node.children.length === 0) return '';
      // Child positions also exclude list/blockquote prefixes on the blank
      // lines around flow content, which trimming whitespace alone would keep.
      contentStart = node.children[0].position?.start.offset ?? contentStart;
      contentEnd = node.children.at(-1)?.position?.end.offset ?? contentEnd;
    }
    return removeWrapperIndent(
      renderRange(contentStart, contentEnd, node.children),
      node
    );
  }

  function renderElement(node: LanguageElement): string | undefined {
    switch (node.name) {
      case 'LanguageText': {
        const value = stringAttribute(node, language) ?? '';
        return booleanAttribute(node, 'code') && value
          ? toMarkdown({ type: 'inlineCode', value }).trimEnd()
          : value;
      }
      case 'LanguageContent': {
        if (stringAttribute(node, 'value') !== language) return '';
        const inline = booleanAttribute(node, 'inline');
        const content = renderContent(node, inline);
        return inline ? content.trim() : content;
      }
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
