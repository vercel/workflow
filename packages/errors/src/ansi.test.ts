import { describe, expect, it } from 'vitest';
import * as Ansi from './ansi.js';

describe('Ansi.frame', () => {
  it('renders a single-line title with no contents', () => {
    expect(Ansi.frame('something went wrong', [])).toMatchInlineSnapshot(
      `"something went wrong"`
    );
  });

  it('renders a single content line with ╰▶', () => {
    expect(
      Ansi.frame('something went wrong', ['here is why'])
    ).toMatchInlineSnapshot(`
      "something went wrong
      ╰▶ here is why"
    `);
  });

  it('renders multiple contents with ├▶ and ╰▶', () => {
    expect(
      Ansi.frame('something went wrong', ['first reason', 'second reason'])
    ).toMatchInlineSnapshot(`
      "something went wrong
      ├▶ first reason
      ╰▶ second reason"
    `);
  });

  it('indents continuation lines under their branch', () => {
    expect(
      Ansi.frame('title', ['first\nwith two lines', 'last\nalso two lines'])
    ).toMatchInlineSnapshot(`
      "title
      ├▶ first
      │  with two lines
      ╰▶ last
         also two lines"
    `);
  });
});

describe('Ansi.code', () => {
  it('wraps a token in dim backticks and italics', () => {
    expect(Ansi.code('fn()')).toMatchInlineSnapshot(`"\`fn()\`"`);
  });
});

describe('Ansi.hint / note / help / docs', () => {
  it('renders a hint line', () => {
    expect(Ansi.hint('try reloading')).toMatchInlineSnapshot(
      `"hint: try reloading"`
    );
  });

  it('renders a note line', () => {
    expect(
      Ansi.note(['read more:', 'https://example.com'])
    ).toMatchInlineSnapshot(
      `
      "note: read more:
      https://example.com"
    `
    );
  });

  it('renders a help line', () => {
    expect(Ansi.help('run `wf inspect run run_123`')).toMatchInlineSnapshot(
      `"help: run \`wf inspect run run_123\`"`
    );
  });

  it('renders a docs line', () => {
    expect(
      Ansi.docs('https://workflow-sdk.dev/docs/api-reference/workflow/sleep')
    ).toMatchInlineSnapshot(
      `"docs: https://workflow-sdk.dev/docs/api-reference/workflow/sleep"`
    );
  });
});

describe('Ansi.inline', () => {
  it('underlines a single token on a single line', () => {
    const out = Ansi.inline`function ${{ text: 'hello', explain: 'name not allowed' }}()`;
    expect(out).toMatchInlineSnapshot(`
      "function hello()
               ──┬──
                 ╰▶ name not allowed"
    `);
  });

  it('preserves subsequent lines unchanged', () => {
    const out = Ansi.inline`const ${{ text: 'x', explain: 'unused' }} = 1
const y = 2`;
    expect(out).toMatchInlineSnapshot(`
      "const x = 1
            ┬
            ╰▶ unused
      const y = 2"
    `);
  });
});
