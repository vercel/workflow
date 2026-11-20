// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source code under test
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: test loops stay inline so a failure reads top to bottom
/**
 * Differential tests for directive detection. Random programs are generated
 * from fragments that put `"use step"` in real directive prologues and in
 * look-alikes (strings, comments, template and regex literals, JSX, keys,
 * arguments, later statements), and `detectWorkflowPatterns()` is compared
 * with two oracles:
 *
 * - the TypeScript parser, reading directive prologues the way the language
 *   defines them, and
 * - the Workflow SWC plugin in `detect` mode, which is what discovery runs.
 *
 * Detection is a prefilter, so the property is one-sided: it may report a
 * directive that is not there (that costs a transform that finds nothing),
 * but it must never miss one (that drops a step from the build).
 *
 * The seed is fixed so a failure reproduces. To soak, raise the counts:
 * `DIRECTIVE_FUZZ_SEED=7 DIRECTIVE_FUZZ_RUNS=100000 pnpm vitest run src/transform-utils.differential.test.ts`
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applySwcTransform } from './apply-swc-transform.js';
import { detectWorkflowPatterns } from './transform-utils.js';

const SEED = Number(process.env.DIRECTIVE_FUZZ_SEED ?? 20261120);
const RUNS = Number(process.env.DIRECTIVE_FUZZ_RUNS ?? 4000);
const SWC_RUNS = Number(process.env.DIRECTIVE_FUZZ_SWC_RUNS ?? 1000);

function mulberry32(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Program {
  source: string;
  jsx: boolean;
  /** Directive spelled with an escape, such as `"use\u0020step"`. */
  escaped: boolean;
}

function createGenerator(seed: number) {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const chance = (p: number) => random() < p;

  let minified = false;
  let escaped = false;
  let counter = 0;

  const gap = () =>
    minified
      ? pick(['', '', '/**/'])
      : pick([
          '',
          ' ',
          '\n',
          '\n  ',
          '\t',
          '\r\n',
          ' /* c */ ',
          '/* "use step"; */',
          '\n// note\n',
          '// `\n',
          '/* ` */',
        ]);

  const directive = () => {
    const [text, isEscaped] = pick([
      ['"use step"', false],
      ["'use step'", false],
      ['"use steps"', false],
      ['" use step"', false],
      ['"use\\u0020step"', true],
      ["'use\\x20step'", true],
    ] as const);
    escaped ||= isEscaped;
    return text + (chance(0.7) ? ';' : '');
  };

  const statements = [
    'return 1;',
    'const x = 1;',
    'await foo();',
    'x = "use step";',
    "log('use step');",
    'return `${"use step"}`;',
    'const r = /"use step"/;',
    "if (a) { 'use step'; }",
    '"use step" + y;',
    'return { "use step": 1 };',
    'let s = "{ \'use step\'; }";',
    'const t = `a ${b} c`;',
    'return a / b / c;',
    "const q = '\\'';",
    'const rr = /[`\'"]/g;',
    '("use step");',
  ];

  const body = () => {
    const prologue: string[] = [];
    for (let i = Math.floor(random() * 3); i > 0; i--) {
      prologue.push(
        pick(['"use strict"', "'use client'", '"use workflow"']) +
          pick([';', ';', ''])
      );
    }
    const rest: string[] = [];
    const placement = random();
    if (placement < 0.6) {
      prologue.splice(
        Math.floor(random() * (prologue.length + 1)),
        0,
        directive()
      );
    } else if (placement < 0.75) {
      rest.push(pick(statements), directive());
    }
    for (let i = Math.floor(random() * 3); i > 0; i--) {
      rest.push(pick(statements));
    }
    // A prologue entry without a semicolon needs a line break after it.
    const prologueText = prologue
      .map(
        (entry) => entry + (entry.endsWith(';') ? gap() : minified ? ';' : '\n')
      )
      .join('');
    return `{${gap()}${prologueText}${rest.map((s) => s + gap()).join('')}}`;
  };

  const functionItem = () => {
    const name = `fn${counter++}`;
    const b = body();
    switch (pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      case 0:
        return `async function ${name}(a)${gap()}${b}`;
      case 1:
        return `export async function ${name}(a: number): Promise<number>${gap()}${b}`;
      case 2:
        return `export const ${name} = async (a) =>${gap()}${b};`;
      case 3:
        return `export const ${name} = async function${gap()}(a)${gap()}${b};`;
      case 4:
        return `export const o${name} = {${gap()}async ${name}(a)${gap()}${b}${gap()}};`;
      case 5:
        return `export class C${name} {${gap()}async ${name}(a)${gap()}${b}${gap()}}`;
      case 6:
        return `export class S${name} {${gap()}static async ${name}(a)${gap()}${b}${gap()}}`;
      case 7:
        return `export class G${name} {${gap()}get ${name}()${gap()}${b}${gap()}}`;
      case 8:
        return `export async function outer${name}() {${gap()}"use workflow";${gap()}const ${name} = async () => ${b};${gap()}return ${name}();${gap()}}`;
      default:
        return `(async function ()${gap()}${b})();`;
    }
  };

  const noise = [
    'const s1 = "{ \'use step\'; }";',
    'const s2 = \'async function f() { "use step"; }\';',
    'const s3 = "it\'s \\"use step\\"";',
    'const t1 = `async function f() { "use step"; }`;',
    "const t2 = `${'use step'}`;",
    'const t3 = `a ${ `b ${"use step"}` } c`;',
    "const t4 = `{ ${x} 'use step'; }`;",
    'const r1 = /"/;',
    "const r2 = /'use step'/;",
    'const r3 = /{ "use step"; }/;',
    'const r4 = /[`"\']/g;',
    'if (a) /"/.test(b);',
    "if (a) /'/.test(b);",
    'if (a) /`/.test(b);',
    'const d1 = a / b / c;',
    'const d2 = (a) / 2 / "x".length;',
    'const k1 = { "use step": true };',
    "const k2 = { 'use step'() { return 1; } };",
    'log("use step");',
    'const a1 = ["use step", "use workflow"];',
    '/* function f() { "use step"; } */',
    '// function f() { "use step"; }',
    '/** `"use step"` */',
    'const c1 = "http://x/*";',
    'const c2 = \'*/ "use step" /*\';',
    "export default 'use step';",
    'label: { "use step"; }',
    "class K { 'use step' = 1 }",
    'type T = { "use step"?: string };',
  ];
  // JSX text with an apostrophe is left out: the scanner reads it as a
  // string to the end of its line (a known limitation, tested on its own).
  const jsxNoise = [
    'export const J2 = () => <a title="use step" />;',
    'export const J3 = () => <p>{"use step"}</p>;',
    'export const J4 = () => <div>{`${x}`}</div>;',
    'export const J6 = () => <code>{ "use step"; }</code>;',
  ];

  return (): Program => {
    minified = chance(0.2);
    escaped = false;
    counter = 0;
    const jsx = chance(0.25);
    const items: string[] = [];
    if (chance(0.08)) items.push(directive());
    for (let i = 1 + Math.floor(random() * 4); i > 0; i--) {
      items.push(
        chance(0.5)
          ? functionItem()
          : pick(jsx ? [...noise, ...jsxNoise] : noise)
      );
    }
    const joiner = () =>
      minified ? pick([';', '\n']) : pick(['\n', ' ', '\n\n', '\r\n']);
    const source = items.map((item, i) => (i ? joiner() : '') + item).join('');
    return { source, jsx, escaped };
  };
}

/** Whether TypeScript reads a `"use step"` directive anywhere in the file. */
function typescriptFindsUseStep({ source, jsx }: Program): boolean | undefined {
  const file = ts.createSourceFile(
    jsx ? 'input.tsx' : 'input.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const diagnostics = (file as { parseDiagnostics?: unknown[] })
    .parseDiagnostics;
  if (diagnostics?.length) return undefined;

  let found = false;
  const readPrologue = (statements: ts.NodeArray<ts.Statement>) => {
    for (const statement of statements) {
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isStringLiteral(statement.expression)
      ) {
        return;
      }
      if (statement.expression.text === 'use step') found = true;
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && 'body' in node) {
      const body = node.body as ts.Node | undefined;
      if (body && ts.isBlock(body)) readPrologue(body.statements);
    }
    ts.forEachChild(node, visit);
  };
  readPrologue(file.statements);
  visit(file);
  return found;
}

function* validPrograms(seed: number, runs: number) {
  const next = createGenerator(seed);
  const seen = new Set<string>();
  for (let i = 0; i < runs; i++) {
    const program = next();
    if (seen.has(program.source)) continue;
    seen.add(program.source);
    const expected = typescriptFindsUseStep(program);
    if (expected === undefined) continue;
    yield { program, expected };
  }
}

describe('detectWorkflowPatterns against parsers', () => {
  it(`never misses a "use step" directive that TypeScript reads (seed ${SEED})`, () => {
    const missed: string[] = [];
    let checked = 0;
    let withDirective = 0;
    for (const { program, expected } of validPrograms(SEED, RUNS)) {
      checked++;
      if (!expected || program.escaped) continue;
      withDirective++;
      if (!detectWorkflowPatterns(program.source).hasUseStep) {
        missed.push(program.source);
      }
    }
    // Guards against a generator change that stops producing either kind.
    expect(checked).toBeGreaterThan(RUNS * 0.8);
    expect(withDirective).toBeGreaterThan(checked * 0.1);
    expect(withDirective).toBeLessThan(checked * 0.9);
    expect(missed.slice(0, 5)).toEqual([]);
  });

  it(`never misses a step the SWC plugin finds (seed ${SEED})`, async () => {
    const missed: string[] = [];
    let withSteps = 0;
    let index = 0;
    for (const { program } of validPrograms(SEED + 1, SWC_RUNS * 2)) {
      if (index++ >= SWC_RUNS) break;
      if (program.escaped) continue;
      let steps = 0;
      try {
        const { workflowManifest } = await applySwcTransform(
          program.jsx ? 'input.tsx' : 'input.ts',
          program.source,
          'detect'
        );
        for (const fns of Object.values(workflowManifest.steps ?? {})) {
          steps += Object.keys(fns).length;
        }
      } catch {
        // The plugin rejects misplaced and misspelled directives. Those are
        // not steps, so there is nothing for detection to find.
        continue;
      }
      if (steps === 0) continue;
      withSteps++;
      if (!detectWorkflowPatterns(program.source).hasUseStep) {
        missed.push(program.source);
      }
    }
    expect(withSteps).toBeGreaterThan(SWC_RUNS * 0.03);
    expect(missed.slice(0, 5)).toEqual([]);
  }, 120_000);
});
