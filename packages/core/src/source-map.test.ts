import { afterEach, describe, expect, it, vi } from 'vitest';
import { remapErrorStack, stripInlineSourceMap } from './source-map.js';

describe('remapErrorStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts inline sourcemaps without regex matching the full bundle', () => {
    const sourceMap = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ['workflows/example.ts'],
        names: [],
        mappings: '',
      })
    ).toString('base64');
    const workflowCode = [
      `const padding = "${'a'.repeat(1024 * 1024)}";`,
      `//# sourceMappingURL=data:application/json;base64,${sourceMap}`,
    ].join('\n');
    const match = vi.spyOn(String.prototype, 'match');

    remapErrorStack(
      'Error: boom\n    at example (workflow.js:1:1)',
      'workflow.js',
      workflowCode
    );

    expect(
      match.mock.calls.some(([pattern]) =>
        String(pattern).includes('sourceMappingURL')
      )
    ).toBe(false);
  });

  it('returns the original stack unchanged when the bundle has no source map', () => {
    const stack = 'Error: boom\n    at example (workflow.js:1:1)';
    const workflowCode = 'const x = 1;\n// no inline source map here';

    expect(remapErrorStack(stack, 'workflow.js', workflowCode)).toBe(stack);
  });

  it('skips scanning the bundle when no frame references the workflow file', () => {
    const sourceMap = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ['workflows/example.ts'],
        names: [],
        mappings: '',
      })
    ).toString('base64');
    const workflowCode = [
      'const a = 1;',
      `//# sourceMappingURL=data:application/json;base64,${sourceMap}`,
    ].join('\n');
    const stack = 'Error: boom\n    at somewhere (other.js:2:3)';
    const indexOf = vi.spyOn(String.prototype, 'indexOf');

    const result = remapErrorStack(stack, 'workflow.js', workflowCode);

    expect(result).toBe(stack);
    // The `filename` early-out should return before scanning the bundle for the
    // inline source map comment.
    expect(
      indexOf.mock.calls.some(([arg]) =>
        String(arg).includes('sourceMappingURL')
      )
    ).toBe(false);
  });

  it('memoizes the parsed source map across repeated failures', () => {
    const sourceMap = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ['workflows/memoized.ts'],
        names: [],
        mappings: '',
      })
    ).toString('base64');
    const workflowCode = [
      'const memoized = 1;',
      `//# sourceMappingURL=data:application/json;base64,${sourceMap}`,
    ].join('\n');
    const stack = 'Error: boom\n    at example (workflow.js:1:1)';

    // First call populates the cache for this bundle.
    const first = remapErrorStack(stack, 'workflow.js', workflowCode);

    const indexOf = vi.spyOn(String.prototype, 'indexOf');
    const second = remapErrorStack(stack, 'workflow.js', workflowCode);

    expect(second).toBe(first);
    // The cached lookup must not rescan the bundle for the inline map comment.
    expect(
      indexOf.mock.calls.some(([arg]) =>
        String(arg).includes('sourceMappingURL')
      )
    ).toBe(false);
  });
});

describe('stripInlineSourceMap', () => {
  it('returns the input unchanged when there is no inline map', () => {
    const code = 'const x = 1;\nconsole.log(x);\n';
    expect(stripInlineSourceMap(code)).toBe(code);
  });

  it('strips a trailing inline source map comment', () => {
    const code =
      'var workflow = { name: "test" };\nconst result = workflow.name;\n' +
      '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n';
    const stripped = stripInlineSourceMap(code);
    expect(stripped).not.toMatch(/sourceMappingURL/);
    expect(stripped).toContain('var workflow');
    expect(stripped).toContain('workflow.name');
  });

  it('strips a long source map comment without trailing newline', () => {
    // Many bundlers emit the comment as the very last line with no
    // trailing newline. The regex must match end-of-input too.
    const longBase64 = 'A'.repeat(4 * 1024 * 1024); // 4 MB of payload
    const code = `globalThis.x = 1;\n//# sourceMappingURL=data:application/json;base64,${longBase64}`;
    const stripped = stripInlineSourceMap(code);
    expect(stripped).not.toMatch(/sourceMappingURL/);
    expect(stripped.length).toBeLessThan(code.length);
    // The bundle proper is preserved — only the trailing comment is gone.
    expect(stripped).toContain('globalThis.x = 1;');
  });

  it('only strips the trailing inline map (not embedded substrings)', () => {
    // A workflow could legitimately contain the literal string
    // "sourceMappingURL" inside JS code (e.g. inside a string literal
    // for an unrelated reason). The regex anchors to end-of-line/end
    // and only matches the comment form, so non-comment occurrences
    // are preserved.
    const code = `
const literal = "sourceMappingURL=foo";
console.log(literal);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbXSwibWFwcGluZ3MiOiIifQ==
`;
    const stripped = stripInlineSourceMap(code);
    expect(stripped).toContain(`"sourceMappingURL=foo"`);
    expect(stripped).not.toMatch(/\/\/# sourceMappingURL/);
  });
});
