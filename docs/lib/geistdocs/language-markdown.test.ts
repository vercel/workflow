import { createProcessor } from '@mdx-js/mdx';
import { createSource } from '@vercel/geistdocs/source';
import { mdxJsxToMarkdown } from 'mdast-util-mdx-jsx';
import { toMarkdown } from 'mdast-util-to-markdown';
import { describe, expect, it } from 'vitest';
import {
  renderLanguageMarkdown,
  withLanguageMarkdown,
} from './language-markdown';

function processedMarkdown(markdown: string): string {
  let processed = '';
  createProcessor({
    remarkPlugins: [
      () => (tree) => {
        processed = toMarkdown(tree, { extensions: [mdxJsxToMarkdown()] });
      },
    ],
  }).processSync(markdown);
  return processed;
}

describe('language Markdown exports', () => {
  it('removes JSX serializer indentation while preserving code and container indentation', () => {
    const markdown = [
      '<LanguageContent value="py">',
      '',
      'Text',
      '',
      '- Item',
      '  - Nested',
      '',
      '```python',
      'if True:',
      '    work()',
      '```',
      '',
      '<LanguageContent value="py">',
      '',
      'Nested text',
      '',
      '</LanguageContent>',
      '',
      '<Callout>',
      '',
      'Callout text',
      '',
      '</Callout>',
      '',
      '</LanguageContent>',
      '',
      '- <LanguageContent value="py">',
      '',
      '  Item text',
      '',
      '  </LanguageContent>',
      '',
      '> <LanguageContent value="py">',
      '>',
      '> Quote text',
      '>',
      '> </LanguageContent>',
      '',
    ].join('\n');
    // Fumadocs getText('processed') serializes JSX before our export runs.
    // Run the compiler too: it promotes paragraphs of JSX to flow elements.
    const processed = processedMarkdown(markdown);
    const exported = renderLanguageMarkdown(processed, 'py');
    expect(exported).toContain(
      '\nText\n\n* Item\n  * Nested\n\n```python\nif True:\n    work()\n```\n'
    );
    expect(exported).toContain('\nNested text\n');
    expect(exported).toContain('<Callout>\n  Callout text\n</Callout>');
    expect(exported).toContain('* \n  Item text\n');
    expect(exported).toContain('> \n> Quote text\n> \n');
  });

  it('selects inline content while preserving block whitespace', () => {
    const markdown = [
      '# Example',
      '',
      'Use <LanguageContent value="ts" inline>`start()`</LanguageContent><LanguageContent value="py" inline>`await start()`</LanguageContent> here.',
      '',
      '<LanguageContent value="py">',
      '',
      '**Python** with <LanguageText ts="Node.js" py="Python" />.',
      '',
      '<LanguageContent value="ts">Hidden nested content</LanguageContent>',
      '',
      '</LanguageContent>',
      '',
    ].join('\n');

    expect(renderLanguageMarkdown(markdown, 'py')).toBe(
      '# Example\n\nUse `await start()` here.\n\n\n\n**Python** with Python.\n\n\n\n\n'
    );
    expect(renderLanguageMarkdown(markdown, 'ts')).toBe(
      '# Example\n\nUse `start()` here.\n\n\n'
    );
  });

  it('trims inline content after JSX serialization, including explicit boolean props', () => {
    for (const inline of ['inline', 'inline={true}']) {
      const markdown = [
        `<LanguageContent value="py" ${inline}>`,
        '',
        '**Python** with <LanguageText ts="Node.js" py="Python" />.',
        '',
        '</LanguageContent>',
      ].join('\n');
      const processed = processedMarkdown(markdown);
      expect(renderLanguageMarkdown(processed, 'py')).toBe(
        '**Python** with Python.\n'
      );
    }
    expect(
      renderLanguageMarkdown(
        '<LanguageContent value="py" inline={false}>\n\nPython\n\n</LanguageContent>',
        'py'
      )
    ).toBe('\n\nPython\n\n');
  });

  it('keeps inline content in surrounding sentences and list items', () => {
    const markdown = [
      'Use <LanguageContent value="ts" inline> `start()` </LanguageContent><LanguageContent value="py" inline={true}>\n`await start()`\n</LanguageContent> here.',
      '',
      '- <LanguageContent value="ts" inline>Node.js</LanguageContent><LanguageContent value="py" inline>Python</LanguageContent>',
      '',
      '> <LanguageContent value="ts" inline>Node.js</LanguageContent><LanguageContent value="py" inline>Python</LanguageContent>',
    ].join('\n');
    const processed = processedMarkdown(markdown);
    expect(renderLanguageMarkdown(processed, 'py')).toBe(
      'Use `await start()` here.\n\n* Python\n\n> Python\n'
    );
    expect(renderLanguageMarkdown(processed, 'ts')).toBe(
      'Use `start()` here.\n\n* Node.js\n\n> Node.js\n'
    );
    expect(() =>
      renderLanguageMarkdown(
        '<LanguageContent value="py" inline="false">Python</LanguageContent>',
        'py'
      )
    ).toThrow('LanguageContent.inline must be a boolean literal');
    expect(() =>
      renderLanguageMarkdown(
        '<LanguageContent value="py" inline={process.exit()}>Python</LanguageContent>',
        'py'
      )
    ).toThrow('LanguageContent.inline must be a boolean literal');
  });

  it('inserts text and links with formatted children and literal attributes', () => {
    const markdown =
      'Use <LanguageText ts={"Node.js"} py="Python &amp; friends" />: <LanguageLink\n ts="/docs/start"\n py="/docs/python/start#returns"\n title="API > reference">`start()` **API**</LanguageLink>.';
    expect(renderLanguageMarkdown(markdown, 'py')).toBe(
      'Use Python & friends: [`start()` **API**](/docs/python/start#returns "API > reference").'
    );
    expect(
      renderLanguageMarkdown(
        '<LanguageLink ts="/docs/a(b) c">Link</LanguageLink>',
        'ts'
      )
    ).toBe('[Link](/docs/a%28b%29%20c)');
  });

  it('leaves code examples and unrelated components intact', () => {
    const markdown = [
      'Inline `<LanguageText ts="Node.js" py="Python" />`.',
      '',
      '```mdx',
      '<LanguageContent value="py">example</LanguageContent>',
      '```',
      '',
      '<Callout type="info">',
      '',
      'For <LanguageText ts="Node.js" py="Python" />.',
      '',
      '</Callout>',
    ].join('\n');
    expect(renderLanguageMarkdown(markdown, 'ts')).toBe(
      markdown.replace(
        'For <LanguageText ts="Node.js" py="Python" />.',
        'For Node.js.'
      )
    );
  });

  it('drops absent values and empty content, including nested discarded branches', () => {
    expect(
      renderLanguageMarkdown(
        '<Callout><LanguageContent value="ts" /><LanguageText py="Python" /><LanguageLink py="/python">Python</LanguageLink></Callout>',
        'ts'
      )
    ).toBe('<Callout></Callout>');
    expect(
      renderLanguageMarkdown(
        'Text <LanguageContent value="py"><LanguageText ts={process.exit()} /></LanguageContent>.',
        'ts'
      )
    ).toBe('Text .');
    expect(() =>
      renderLanguageMarkdown('<LanguageText ts={process.exit()} />', 'ts')
    ).toThrow('LanguageText.ts must be a string literal');
  });

  it('uses the first configured language and isolates concurrent exports before URL rewriting', async () => {
    const markdown =
      '<LanguageContent value="ts">TypeScript</LanguageContent><LanguageContent value="py">Python</LanguageContent> <LanguageLink ts="/docs/start" py="/docs/python/start">API</LanguageLink>';
    const raw = createSource({
      config: { defaultLanguage: 'en' },
      baseUrl: '/docs',
      docs: {
        toFumadocsSource: () => ({
          files: [
            {
              type: 'page',
              path: 'example.mdx',
              data: {
                title: 'Example',
                languageSwitcher: ['py', 'ts'],
                getText: async () => markdown,
              },
            },
          ],
        }),
      },
      markdown: {
        transform: (text) => text.replaceAll('](/docs/', '](/v5/docs/'),
      },
    });
    const bundle = withLanguageMarkdown(raw);
    const page = bundle.source.getPage(['example'], 'en');
    if (!page) throw new Error('Missing fixture page');

    const [defaultText, tsText, pyText, invalidText] = await Promise.all([
      bundle.getPageMarkdown(page),
      bundle.getPageMarkdown(page, 'ts'),
      bundle.getPageMarkdown(page, 'py'),
      bundle.getPageMarkdown(page, 'unknown'),
    ]);
    expect(defaultText).toContain('Python [API](/v5/docs/python/start)');
    expect(defaultText).not.toContain('TypeScript');
    expect(tsText).toContain('TypeScript [API](/v5/docs/start)');
    expect(tsText).not.toContain('Python');
    expect(pyText).toBe(defaultText);
    expect(invalidText).toBe(defaultText);
    expect(defaultText).toContain('[/sitemap.md](/sitemap.md)');
    expect(defaultText).toContain('[/llms.txt](/llms.txt)');
    expect(await raw.getPageMarkdown(page)).toContain('<LanguageContent');
  });
});
