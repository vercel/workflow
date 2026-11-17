#!/usr/bin/env node
/**
 * Regenerates the geistcn token block in `src/styles.css` from a local
 * checkout of vercel/front, so the observability UI uses the same design
 * tokens as the Vercel dashboard.
 *
 *   pnpm --filter @workflow/web-shared sync-geist-tokens /absolute/path/to/vercel/front
 *
 * vercel/front is private, so this runs by hand rather than in CI. It only
 * replaces the text between the `geistcn:begin` and `geistcn:end` markers.
 * Pass `--check` to fail instead of writing when the block is out of date.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '/* geistcn:begin */';
const END = '/* geistcn:end */';
const STYLES_DIR = 'packages/geistcn/src/styles';
const TARGET = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/styles.css'
);

const args = process.argv.slice(2);
const check = args.includes('--check');
const frontDir = args.find((arg) => !arg.startsWith('--'));
if (!frontDir) {
  console.error(
    'Usage: sync-geist-tokens.mjs <path-to-vercel-front-checkout> [--check]'
  );
  process.exit(1);
}

const read = (path) => readFileSync(join(frontDir, STYLES_DIR, path), 'utf8');
const sha = execFileSync('git', ['-C', frontDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rules of a stylesheet as `{ prelude, body }`. */
function topLevelRules(source) {
  const css = stripComments(source);
  const rules = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === ';' && depth === 0) {
      preludeStart = i + 1; // an at-statement such as @import
    } else if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}' && --depth === 0) {
      rules.push({
        prelude: css.slice(preludeStart, bodyStart - 1).trim(),
        body: css.slice(bodyStart, i),
      });
      preludeStart = i + 1;
    }
  }
  return rules;
}

/** Splits a rule body on `;` outside parentheses, dropping nested blocks. */
function statements(body) {
  const chunks = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')') depth--;
    else if (ch === '}' && --depth === 0) start = i + 1;
    else if (ch === ';' && depth === 0) {
      chunks.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return chunks;
}

/** Re-indents a multi-line value for a two-space-indented declaration. */
const formatValue = (value) =>
  value
    .trim()
    .split('\n')
    .map((line, index) => {
      const text = line.trim();
      if (index === 0) return text;
      return `${text.startsWith(')') ? '  ' : '    '}${text}`;
    })
    .join('\n');

/** Custom-property declarations directly inside a rule body, in order. */
function customProperties(body) {
  const declarations = new Map();
  for (const chunk of statements(stripComments(body))) {
    const match = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(chunk);
    if (match) declarations.set(match[1], formatValue(match[2]));
  }
  return declarations;
}

/**
 * Picks the declarations that `include` accepts, plus any custom properties
 * from the same rule that they reference, keeping source order.
 */
function pick(declarations, include) {
  const picked = new Set(
    [...declarations.keys()].filter((name) =>
      include(name, declarations.get(name))
    )
  );
  const queue = [...picked];
  while (queue.length > 0) {
    const value = declarations.get(queue.pop());
    for (const [, ref] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (declarations.has(ref) && !picked.has(ref)) {
        picked.add(ref);
        queue.push(ref);
      }
    }
  }
  return [...declarations].filter(([name]) => picked.has(name));
}

function printRule(prelude, entries) {
  const selector = prelude
    .split(',')
    .map((part) => part.trim())
    .join(',\n');
  const body = entries
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}

/** Prints every top-level style rule's `--ds-*` tokens that `include` accepts. */
function extract(css, include) {
  return topLevelRules(css)
    .filter((rule) => !rule.prelude.startsWith('@'))
    .map((rule) => [
      rule.prelude,
      pick(customProperties(rule.body), (name, value) =>
        include(name, value, rule.prelude)
      ),
    ])
    .filter(([, entries]) => entries.length > 0)
    .map(([prelude, entries]) => printRule(prelude, entries));
}

const isDsToken = (name) => name.startsWith('--ds-');

// base.css: the token block on `:root, :host`. Its non-token rules (html,
// helper classes, legacy --geist-* palette) are not copied.
const base = extract(
  read('themes/base.css'),
  (name, _value, prelude) =>
    isDsToken(name) && prelude.replace(/\s/g, '') === ':root,:host'
);

// design-system.css is the full-style entry. Its colours duplicate the
// Tailwind entry's oklch scale, so only the tokens that are not colour steps
// are copied (focus colour, focus border, contrast foreground).
const designSystem = extract(
  read('components/design-system.css'),
  (name, value) =>
    isDsToken(name) && !name.endsWith('-value') && !value.includes('-value)')
);

const dark = extract(read('themes/dark.css'), isDsToken);

const gray = read('themes/gray.css').trim();

const tailwind = read('tailwind.css')
  .replace(/^@(layer|import)\b[^;]*;[ \t]*\n/gm, '')
  .trim();

const block = [
  BEGIN,
  `/*
 * Geist design tokens, copied 1:1 from geistcn in vercel/front@${sha}.
 * Do not edit by hand: run \`pnpm --filter @workflow/web-shared
 * sync-geist-tokens <absolute-path-to-vercel-front>\` to regenerate this block.
 *
 * Sources, under ${STYLES_DIR}/:
 *   themes/gray.css               verbatim
 *   themes/base.css               --ds-* tokens on \`:root, :host\` and the
 *                                 custom properties they reference
 *   components/design-system.css  --ds-* tokens that are not colour steps
 *   themes/dark.css               dark --ds-* tokens
 *   tailwind.css                  verbatim, minus its @layer/@import lines
 */`,
  `/* ${STYLES_DIR}/themes/gray.css */`,
  gray,
  `/* ${STYLES_DIR}/themes/base.css */`,
  ...base,
  `/* ${STYLES_DIR}/components/design-system.css */`,
  ...designSystem,
  `/* ${STYLES_DIR}/themes/dark.css */`,
  ...dark,
  `/* ${STYLES_DIR}/tailwind.css */`,
  tailwind,
  END,
].join('\n\n');

const current = readFileSync(TARGET, 'utf8');
const begin = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (begin === -1 || end === -1 || end < begin) {
  console.error(`${TARGET} is missing the ${BEGIN} / ${END} markers.`);
  process.exit(1);
}
const next = current.slice(0, begin) + block + current.slice(end + END.length);

if (check) {
  if (next !== current) {
    console.error(`${TARGET} is out of date with vercel/front@${sha}.`);
    process.exit(1);
  }
  console.log(`${TARGET} matches vercel/front@${sha}.`);
} else {
  writeFileSync(TARGET, next);
  console.log(`Updated ${TARGET} from vercel/front@${sha}.`);
}
