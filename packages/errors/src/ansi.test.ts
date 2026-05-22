import { describe, expect, it, vi } from 'vitest';

// Render styles as readable HTML-like tags in snapshots so a reviewer can
// see at a glance which fragments are colored and how. The production
// implementation in `./internal-chalk.ts` emits ANSI SGR escapes and
// short-circuits to identity functions when there's no TTY (and in the
// workflow VM, where `globalThis.process` is undefined).
vi.mock('./internal-chalk.js', () => {
  const tag =
    (name: string) =>
    (s: string): string =>
      `<${name}>${s}</${name}>`;
  return {
    default: {
      bold: tag('b'),
      dim: tag('dim'),
      italic: tag('i'),
      red: tag('red'),
      blue: tag('blue'),
      cyan: tag('cyan'),
      yellow: tag('yellow'),
      magenta: tag('magenta'),
    },
  };
});

const Ansi = await import('./ansi.js');

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
    expect(Ansi.code('fn()')).toMatchInlineSnapshot(
      `"<i><dim>\`</dim>fn()<dim>\`</dim></i>"`
    );
  });
});

describe('Ansi.hint / note / help / docs', () => {
  it('renders a hint line', () => {
    expect(Ansi.hint('try reloading')).toMatchInlineSnapshot(
      `"<blue><b>hint:</b> try reloading</blue>"`
    );
  });

  it('renders a note line', () => {
    expect(
      Ansi.note(['read more:', 'https://example.com'])
    ).toMatchInlineSnapshot(
      `
      "<blue><b>note:</b> read more:
      https://example.com</blue>"
    `
    );
  });

  it('renders a help line', () => {
    expect(Ansi.help('run `wf inspect run run_123`')).toMatchInlineSnapshot(
      `"<cyan><b>help:</b> run \`wf inspect run run_123\`</cyan>"`
    );
  });

  it('renders a docs line', () => {
    expect(
      Ansi.docs('https://workflow-sdk.dev/docs/api-reference/workflow/sleep')
    ).toMatchInlineSnapshot(
      `"<blue><b>docs:</b> https://workflow-sdk.dev/docs/api-reference/workflow/sleep</blue>"`
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
