import { createSource } from '@vercel/geistdocs/source';
import { describe, expect, it } from 'vitest';
import {
  renderLanguageMarkdown,
  withLanguageMarkdown,
} from './language-markdown';

describe('language Markdown exports', () => {
  it('unwraps matching block and inline content without changing whitespace', () => {
    const markdown = [
      '# Example',
      '',
      'Use <LanguageContent value="ts" as="span">`start()`</LanguageContent><LanguageContent value="py">`await start()`</LanguageContent> here.',
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
