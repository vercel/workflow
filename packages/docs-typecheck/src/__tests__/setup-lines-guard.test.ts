import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `// @setup` marks a line of a docs code sample that exists for the type
 * checker (a `declare function` stub, a variable from an earlier snippet),
 * not the reader. The docs app strips those lines at build time with
 * `docs/lib/remark-strip-setup-lines.ts`; these tests keep that from
 * regressing (it once did, when a docs framework migration dropped the
 * component that hid them). The docs smoke check also asserts that a
 * rendered page shows none.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const pluginPath = path.join(repoRoot, 'docs/lib/remark-strip-setup-lines.ts');

const listMdx = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listMdx(fullPath);
    return entry.name.endsWith('.mdx') ? [fullPath] : [];
  });

describe('Docs @setup lines guard', async () => {
  const { stripSetupLines, remarkStripSetupLines } = await import(pluginPath);

  it('drops @setup lines and the blank lines they leave at the top', () => {
    const code = [
      'import { sleep } from "workflow"',
      'declare function sendSms(userId: string): Promise<void>; // @setup',
      '',
      'export async function notify() {}',
    ].join('\n');
    expect(stripSetupLines(code)).toBe(
      [
        'import { sleep } from "workflow"',
        '',
        'export async function notify() {}',
      ].join('\n')
    );
    expect(
      stripSetupLines('declare const a: number; // @setup\n\nconst b = a;')
    ).toBe('const b = a;');
  });

  it('drops a whole multi-line declaration whose marker is on its last line', () => {
    const code = [
      'declare function subscribe<T>(',
      '  source: AsyncIterable<T>',
      '): { drain: () => T[] }; // @setup',
      '',
      'const x = 1;',
    ].join('\n');
    expect(stripSetupLines(code)).toBe('const x = 1;');
  });

  it('leaves code without the marker as it is', () => {
    const code = 'const a = 1; // setup the thing\n\n\nconst b = 2;';
    expect(stripSetupLines(code)).toBe(code);
  });

  it('strips the code nodes of an mdast tree', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'code',
          value: 'declare const a: number; // @setup\nconst b = a;',
        },
        { type: 'paragraph', children: [{ type: 'text', value: '// @setup' }] },
      ],
    };
    remarkStripSetupLines()(tree);
    expect(tree.children[0]).toMatchObject({ value: 'const b = a;' });
    // Prose is left alone: only code samples carry the marker.
    expect(tree.children[1]).toMatchObject({
      children: [{ value: '// @setup' }],
    });
  });

  it('is registered in the docs source config, ahead of rendering', () => {
    const config = fs.readFileSync(
      path.join(repoRoot, 'docs/source.config.ts'),
      'utf-8'
    );
    expect(config).toMatch(
      /import \{ remarkStripSetupLines \} from '\.\/lib\/remark-strip-setup-lines'/
    );
    expect(config).toMatch(/remarkPlugins:\s*\[[^\]]*remarkStripSetupLines/);
  });

  it('removes every @setup line in the docs content', () => {
    const fences = /```[^\n]*\n([\s\S]*?)```/g;
    const left: string[] = [];
    for (const file of listMdx(path.join(repoRoot, 'docs/content'))) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const [, code] of source.matchAll(fences)) {
        if (!code.includes('@setup')) continue;
        if (stripSetupLines(code).includes('@setup')) {
          left.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(left).toEqual([]);
  });
});
