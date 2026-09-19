/**
 * Sandbox-safety checks for the workflow ("flow") bundle.
 *
 * The flow bundle is evaluated with `vm.runInContext()` inside a sandbox that
 * deliberately has no `require`: `createContext()` in
 * `packages/core/src/vm/index.ts` only shims `module` and `exports`. esbuild
 * emits the flow bundle as CJS, which means:
 *
 * - every import that stays **external** turns into a literal
 *   `require("<specifier>")` call, and
 * - every `require(...)` esbuild could not statically resolve is copied into
 *   the output verbatim.
 *
 * Both throw `ReferenceError: require is not defined` as soon as they are
 * evaluated. External imports are the worst case: esbuild hoists them to the
 * top level of the bundle, so the whole bundle fails to load and *every*
 * workflow in the deployment breaks, not just the code path that needed the
 * module.
 *
 * Those failures used to be silent at build time.
 * `createNodeModuleErrorPlugin()` marks Node.js/Bun builtins as external and
 * only reports the ones it can trace back to an `import … from "pkg"`
 * statement inside user code, so transitively imported builtins (and
 * re-exported ones, and side-effect-only imports) shipped a bundle that could
 * never run. This module is the backstop that turns those into build errors.
 */

import { ERROR_SLUGS, WorkflowBuildError } from '@workflow/errors';
import * as esbuild from 'esbuild';
import { isRuntimeBuiltinSpecifier } from './node-module-esbuild-plugin.js';

/**
 * Set to `1` to downgrade flow bundle safety failures to warnings.
 *
 * The bundle still crashes at runtime if the offending code is reached; this
 * only exists as an escape hatch for the rare case where the detection is
 * wrong (for example a `require()` that is provably unreachable, or guarded by
 * a `try`/`catch` that swallows the `ReferenceError`).
 */
export const ALLOW_UNSAFE_FLOW_BUNDLE_ENV = 'WORKFLOW_ALLOW_UNSAFE_FLOW_BUNDLE';

const DOCS_URL = `https://workflow-sdk.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`;

/** Maximum number of violations of each kind included in the error message. */
const MAX_REPORTED = 10;

/** Placeholder esbuild substitutes for free `require` references. */
const FREE_REQUIRE_SENTINEL = '__workflow_free_require_probe__';

/** An import esbuild left external, which becomes a top-level `require()`. */
export interface ExternalImportViolation {
  /** The externalized specifier, e.g. `node:fs`. */
  specifier: string;
  /** Bundle inputs that imported it, as metafile keys. */
  importers: string[];
  /**
   * Import chain from the bundle entry down to the first importer, with the
   * synthetic virtual entry removed. Empty when it cannot be reconstructed.
   */
  importChain: string[];
  /** Whether the specifier names a Node.js or Bun built-in module. */
  isRuntimeBuiltin: boolean;
}

/** A `require(...)` call left in the bundle that resolves to the global. */
export interface DynamicRequireViolation {
  /** Bundle module the call belongs to, when esbuild labelled the section. */
  module?: string;
  /** 1-based line within the flow bundle. */
  line: number;
  /** 1-based column within the flow bundle. */
  column: number;
  /** The requested specifier when the call site passes a string literal. */
  specifier?: string;
  /** Trimmed source line, for context. */
  snippet: string;
}

export interface FlowBundleSafetyReport {
  externalImports: ExternalImportViolation[];
  dynamicRequires: DynamicRequireViolation[];
}

export function isFlowBundleSafetyReportEmpty(
  report: FlowBundleSafetyReport
): boolean {
  return (
    report.externalImports.length === 0 && report.dynamicRequires.length === 0
  );
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/** A `//` comment that starts at column 0 — esbuild's module section marker. */
export interface BannerComment {
  /** Offset of the `//`. */
  index: number;
  /** Comment text with the leading `// ` removed. */
  text: string;
}

export interface MaskResult {
  /**
   * `code` with every comment, string literal, template literal chunk and
   * regex literal replaced by spaces. Offsets and line breaks are preserved,
   * so positions map 1:1 back onto the original text. Template *substitutions*
   * (`${…}`) are left intact because they contain real code.
   */
  masked: string;
  /** Column-0 line comments, in source order. */
  banners: BannerComment[];
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * Keywords after which a `/` starts a regex literal rather than a division.
 * Everything else that ends in an identifier character (a name, a number) is
 * treated as an operand, so `/` divides.
 */
const KEYWORDS_BEFORE_REGEX = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function blankOut(text: string): string {
  // Keep newlines so line numbers still line up.
  return text.replace(/[^\n]/g, ' ');
}

/** Reads the identifier that ends at `end` (exclusive). */
function identifierEndingAt(code: string, end: number): string {
  let start = end;
  while (start > 0 && IDENTIFIER_CHAR.test(code[start - 1])) start -= 1;
  return code.slice(start, end);
}

/**
 * Scans a quoted string starting at `start` (the quote). Returns the offset
 * just past the closing quote, or `-1` when the literal is unterminated on its
 * line (in which case the caller should not mask anything).
 */
function scanQuoted(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '\n') return -1;
    if (ch === quote) return i + 1;
  }
  return -1;
}

/**
 * Scans a regex literal starting at `start` (the `/`). Returns the offset just
 * past the trailing flags, or `-1` when the token is not a well-formed regex
 * on a single line — which means it was really a division operator.
 */
function scanRegex(code: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '\n') return -1;
    if (ch === '[') inClass = true;
    if (ch === ']') inClass = false;
    if (ch === '/' && !inClass) return scanRegexFlags(code, i + 1);
  }
  return -1;
}

function scanRegexFlags(code: string, start: number): number {
  let end = start;
  while (end < code.length && /[a-z]/.test(code[end])) end += 1;
  return end;
}

/**
 * Scans the literal portion of a template starting at `start`. Stops at the
 * closing backtick or at a `${` substitution.
 */
function scanTemplateChunk(
  code: string,
  start: number
): { end: number; substitution: boolean } {
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') return { end: i, substitution: false };
    if (ch === '$' && code[i + 1] === '{') {
      return { end: i, substitution: true };
    }
  }
  return { end: code.length, substitution: false };
}

/**
 * Decides whether a `/` opens a regex literal or divides. Anything that ends
 * an operand (a closing bracket, a literal, a non-keyword identifier) means
 * division; everything else means a regex can start here.
 */
function isRegexPosition(
  code: string,
  previousChar: string,
  previousIndex: number
): boolean {
  if (
    previousChar === ')' ||
    previousChar === ']' ||
    previousChar === '"' ||
    previousChar === "'" ||
    previousChar === '`'
  ) {
    return false;
  }
  if (!IDENTIFIER_CHAR.test(previousChar)) return true;
  return KEYWORDS_BEFORE_REGEX.has(identifierEndingAt(code, previousIndex + 1));
}

interface NonCodeToken {
  /** Offset just past the token. */
  end: number;
  /** Comments do not terminate an operand; strings and regexes do. */
  isOperand: boolean;
  isLineComment: boolean;
}

/**
 * Scans the non-code token starting at `i`, if there is one. Returns
 * `undefined` for ordinary code, and for a `/` or quote that turned out not to
 * open a literal (a division operator, an unterminated string).
 */
function scanNonCodeToken(
  code: string,
  i: number,
  previousChar: string,
  previousIndex: number
): NonCodeToken | undefined {
  const ch = code[i];

  if (ch === '/' && code[i + 1] === '/') {
    const newline = code.indexOf('\n', i);
    return {
      end: newline === -1 ? code.length : newline,
      isOperand: false,
      isLineComment: true,
    };
  }

  if (ch === '/' && code[i + 1] === '*') {
    const close = code.indexOf('*/', i + 2);
    return {
      end: close === -1 ? code.length : close + 2,
      isOperand: false,
      isLineComment: false,
    };
  }

  if (ch === '"' || ch === "'") {
    const end = scanQuoted(code, i);
    return end === -1
      ? undefined
      : { end, isOperand: true, isLineComment: false };
  }

  if (ch === '/' && isRegexPosition(code, previousChar, previousIndex)) {
    const end = scanRegex(code, i);
    return end === -1
      ? undefined
      : { end, isOperand: true, isLineComment: false };
  }

  return undefined;
}

/**
 * Blanks out every non-code region of `code` so the result can be scanned with
 * plain string matching without tripping over `require` inside comments,
 * strings or regexes.
 */
export function maskNonCodeRegions(code: string): MaskResult {
  const parts: string[] = [];
  const banners: BannerComment[] = [];
  let copyFrom = 0;
  let i = 0;
  let lastSignificantChar = '';
  let lastSignificantIndex = -1;
  let inTemplate = false;
  let braceDepth = 0;
  // Brace depth recorded when entering each `${`, so the matching `}` can be
  // told apart from ordinary object/block braces.
  const templateBraceStack: number[] = [];

  const mask = (start: number, end: number): void => {
    parts.push(code.slice(copyFrom, start), blankOut(code.slice(start, end)));
    copyFrom = end;
  };

  while (i < code.length) {
    if (inTemplate) {
      const chunk = scanTemplateChunk(code, i);
      mask(i, chunk.end);
      if (chunk.substitution) {
        inTemplate = false;
        templateBraceStack.push(braceDepth);
        i = chunk.end + 2; // skip `${`
      } else {
        inTemplate = false;
        i = chunk.end + 1; // skip the closing backtick
        lastSignificantChar = '`';
        lastSignificantIndex = chunk.end;
      }
      continue;
    }

    const ch = code[i];

    const token = scanNonCodeToken(
      code,
      i,
      lastSignificantChar,
      lastSignificantIndex
    );
    if (token) {
      if (token.isLineComment && (i === 0 || code[i - 1] === '\n')) {
        banners.push({ index: i, text: code.slice(i + 2, token.end).trim() });
      }
      mask(i, token.end);
      if (token.isOperand) {
        lastSignificantChar = code[token.end - 1];
        lastSignificantIndex = token.end - 1;
      }
      i = token.end;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
    } else if (ch === '}') {
      if (
        templateBraceStack.length > 0 &&
        templateBraceStack[templateBraceStack.length - 1] === braceDepth
      ) {
        templateBraceStack.pop();
        inTemplate = true;
        i += 1;
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }

    if (!/\s/.test(ch)) {
      lastSignificantChar = ch;
      lastSignificantIndex = i;
    }
    i += 1;
  }

  parts.push(code.slice(copyFrom));
  return { masked: parts.join(''), banners };
}

// ---------------------------------------------------------------------------
// Free `require` detection
// ---------------------------------------------------------------------------

/**
 * Word-boundary match for the `require` identifier. The lookarounds also rule
 * out esbuild's own helpers — `__require` (the `__commonJS` shim) and
 * `require_<name>()` (a bundled CommonJS module wrapper) — because `_` counts
 * as an identifier character.
 */
const REQUIRE_TOKEN = /(?<![A-Za-z0-9_$])require(?![A-Za-z0-9_$])/g;

/** Preceding keywords that make the `require` token harmless or bound. */
const SAFE_PRECEDING_KEYWORDS = new Set([
  // `typeof require` never throws; it is the standard UMD/CJS feature probe.
  'typeof',
  // A declaration means references in scope are bound, not global.
  'class',
  'const',
  'function',
  'let',
  'var',
]);

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function locationOf(
  lineStarts: number[],
  index: number
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - lineStarts[low] + 1 };
}

function skipWhitespaceForward(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function skipWhitespaceBackward(text: string, from: number): number {
  let i = from;
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  return i;
}

/** Reads the string literal argument of a `require(` call, when there is one. */
function readLiteralArgument(
  code: string,
  openParen: number
): string | undefined {
  const start = skipWhitespaceForward(code, openParen + 1);
  const quote = code[start];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = scanQuoted(code, start);
  if (end === -1) return undefined;
  const raw = code.slice(start + 1, end - 1);
  // Specifiers are plain text in practice, so a JSON round-trip is enough to
  // undo any escaping. Fall back to the raw text if it is not valid JSON.
  const json =
    quote === '"'
      ? code.slice(start, end)
      : `"${raw.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`;
  try {
    return JSON.parse(json) as string;
  } catch {
    return raw;
  }
}

function moduleForIndex(
  banners: BannerComment[],
  knownModules: Set<string> | undefined,
  index: number
): string | undefined {
  let match: string | undefined;
  for (const banner of banners) {
    if (banner.index > index) break;
    if (knownModules && !knownModules.has(banner.text)) continue;
    match = banner.text;
  }
  return match;
}

/**
 * Finds every `require` token in `bundleText` that looks like it will be
 * evaluated at runtime.
 *
 * This is a cheap pre-filter: it runs on every build, so it must be fast and
 * must not flag the patterns that show up in ordinary bundled output
 * (`typeof require`, `__require`, `require_pkg()`, `obj.require`). Anything it
 * does flag is confirmed with esbuild's own scope analysis before it fails a
 * build — see {@link probeFreeRequireReferences}.
 */
export function findDynamicRequireCandidates(
  bundleText: string,
  knownModules?: Set<string>
): DynamicRequireViolation[] {
  const { masked, banners } = maskNonCodeRegions(bundleText);
  const lineStarts = computeLineStarts(bundleText);
  const violations: DynamicRequireViolation[] = [];

  REQUIRE_TOKEN.lastIndex = 0;
  let match = REQUIRE_TOKEN.exec(masked);
  while (match !== null) {
    const index = match.index;
    const beforeEnd = skipWhitespaceBackward(masked, index);
    const previousChar = beforeEnd > 0 ? masked[beforeEnd - 1] : '';
    const previousWord = IDENTIFIER_CHAR.test(previousChar)
      ? identifierEndingAt(masked, beforeEnd)
      : '';
    const afterStart = skipWhitespaceForward(masked, index + 'require'.length);
    const nextChar = masked[afterStart] ?? '';

    const isMemberAccess = previousChar === '.' || previousChar === '#';
    const isPropertyKey = nextChar === ':';
    const isSafeKeyword = SAFE_PRECEDING_KEYWORDS.has(previousWord);

    if (!isMemberAccess && !isPropertyKey && !isSafeKeyword) {
      const { line, column } = locationOf(lineStarts, index);
      const lineText = bundleText.slice(
        lineStarts[line - 1],
        lineStarts[line] ?? bundleText.length
      );
      violations.push({
        module: moduleForIndex(banners, knownModules, index),
        line,
        column,
        specifier:
          nextChar === '('
            ? readLiteralArgument(bundleText, afterStart)
            : undefined,
        snippet: truncate(lineText.trim(), 160),
      });
    }

    match = REQUIRE_TOKEN.exec(masked);
  }

  return violations;
}

interface FreeRequireProbe {
  /** Specifiers passed to a free `require("…")`. */
  literals: Set<string>;
  /** Free `require` references that are not a call with a literal argument. */
  otherReferences: number;
}

/**
 * Confirms candidates with esbuild's scope analysis.
 *
 * `define` only rewrites identifiers that resolve to the global scope, so any
 * `require` that a surrounding function parameter or declaration shadows is
 * left alone. `typeof require` survives as `typeof <sentinel>`, which we skip
 * because it cannot throw.
 *
 * Returns `undefined` when the probe itself fails, in which case the caller
 * keeps the candidates rather than silently dropping a real problem.
 */
async function probeFreeRequireReferences(
  bundleText: string
): Promise<FreeRequireProbe | undefined> {
  let code: string;
  try {
    const result = await esbuild.transform(bundleText, {
      loader: 'js',
      define: { require: FREE_REQUIRE_SENTINEL },
      legalComments: 'none',
      sourcemap: false,
    });
    code = result.code;
  } catch {
    return undefined;
  }

  const probe: FreeRequireProbe = { literals: new Set(), otherReferences: 0 };
  const sentinel = new RegExp(
    `(?<![A-Za-z0-9_$])${FREE_REQUIRE_SENTINEL}(?![A-Za-z0-9_$])`,
    'g'
  );
  const { masked } = maskNonCodeRegions(code);
  let match = sentinel.exec(masked);
  while (match !== null) {
    const beforeEnd = skipWhitespaceBackward(masked, match.index);
    const previousWord = identifierEndingAt(masked, beforeEnd);
    if (previousWord !== 'typeof') {
      const afterStart = skipWhitespaceForward(
        masked,
        match.index + FREE_REQUIRE_SENTINEL.length
      );
      const literal =
        masked[afterStart] === '('
          ? readLiteralArgument(code, afterStart)
          : undefined;
      if (literal === undefined) probe.otherReferences += 1;
      else probe.literals.add(literal);
    }
    match = sentinel.exec(masked);
  }
  return probe;
}

// ---------------------------------------------------------------------------
// External imports (metafile)
// ---------------------------------------------------------------------------

/** esbuild uses `<…>` for synthetic inputs (`<runtime>`, `<stdin>`). */
function isSyntheticPath(path: string): boolean {
  return path.startsWith('<') && path.endsWith('>');
}

/** Inputs nobody imports — the entry points, when the metafile omits them. */
function findRootInputs(metafile: esbuild.Metafile): string[] {
  const imported = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const imp of input.imports) {
      if (!imp.external) imported.add(imp.path);
    }
  }
  return Object.keys(metafile.inputs).filter((input) => !imported.has(input));
}

/**
 * Walks the metafile input graph breadth-first from the bundle entry so each
 * external import can be reported with the chain of modules that pulled it in.
 */
function buildParentIndex(metafile: esbuild.Metafile): {
  parents: Map<string, string>;
  entries: Set<string>;
} {
  const entries = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    if (output.entryPoint) entries.add(output.entryPoint);
  }
  if (entries.size === 0) {
    for (const input of findRootInputs(metafile)) entries.add(input);
  }

  const parents = new Map<string, string>();
  const queue = [...entries];
  const seen = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const imp of metafile.inputs[current]?.imports ?? []) {
      if (imp.external || seen.has(imp.path)) continue;
      seen.add(imp.path);
      parents.set(imp.path, current);
      queue.push(imp.path);
    }
  }
  return { parents, entries };
}

function chainTo(
  parents: Map<string, string>,
  entries: Set<string>,
  module: string
): string[] {
  const chain = [module];
  const seen = new Set(chain);
  let current = module;
  while (!entries.has(current)) {
    const parent = parents.get(current);
    if (parent === undefined || seen.has(parent)) break;
    seen.add(parent);
    chain.unshift(parent);
    current = parent;
  }
  // The virtual entry is generated by the builder, not written by the user.
  return chain.filter((module) => !entries.has(module));
}

/** The specifiers esbuild emitted as external in any output chunk. */
function collectExternalSpecifiers(metafile: esbuild.Metafile): Set<string> {
  const specifiers = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports) {
      if (imp.external && !isSyntheticPath(imp.path)) specifiers.add(imp.path);
    }
  }
  return specifiers;
}

/** Attributes each external specifier to the inputs that imported it. */
function mapImporters(
  metafile: esbuild.Metafile,
  specifiers: Set<string>
): Map<string, string[]> {
  const importersBySpecifier = new Map<string, string[]>();
  for (const [input, info] of Object.entries(metafile.inputs)) {
    if (isSyntheticPath(input)) continue;
    for (const imp of info.imports) {
      if (!imp.external || !specifiers.has(imp.path)) continue;
      const importers = importersBySpecifier.get(imp.path);
      if (importers) importers.push(input);
      else importersBySpecifier.set(imp.path, [input]);
    }
  }
  return importersBySpecifier;
}

/**
 * Collects the imports esbuild left external. In a CJS bundle each of these is
 * emitted as a top-level `require("…")`.
 */
export function collectExternalImports(
  metafile: esbuild.Metafile
): ExternalImportViolation[] {
  const specifiers = collectExternalSpecifiers(metafile);
  if (specifiers.size === 0) return [];

  const importersBySpecifier = mapImporters(metafile, specifiers);
  const { parents, entries } = buildParentIndex(metafile);
  return [...specifiers].sort().map((specifier) => {
    const importers = (importersBySpecifier.get(specifier) ?? []).sort();
    return {
      specifier,
      importers,
      importChain: importers[0] ? chainTo(parents, entries, importers[0]) : [],
      isRuntimeBuiltin: isRuntimeBuiltinSpecifier(specifier),
    };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Inspects a finished flow bundle for constructs the workflow sandbox cannot
 * evaluate.
 */
export async function analyzeFlowBundleSafety({
  bundleText,
  metafile,
}: {
  bundleText: string;
  metafile?: esbuild.Metafile;
}): Promise<FlowBundleSafetyReport> {
  const externalImports = metafile ? collectExternalImports(metafile) : [];
  const externalSpecifiers = new Set(
    externalImports.map((violation) => violation.specifier)
  );

  const knownModules = metafile
    ? new Set(Object.keys(metafile.inputs))
    : undefined;

  // External imports are emitted as `require("<specifier>")`, so drop the
  // candidates they account for: they are already reported above, with a much
  // better import chain than a bundle line number.
  const candidates = findDynamicRequireCandidates(
    bundleText,
    knownModules
  ).filter(
    (candidate) =>
      candidate.specifier === undefined ||
      !externalSpecifiers.has(candidate.specifier)
  );

  if (candidates.length === 0) {
    return { externalImports, dynamicRequires: [] };
  }

  const probe = await probeFreeRequireReferences(bundleText);
  const dynamicRequires =
    probe === undefined
      ? candidates
      : candidates.filter((candidate) =>
          candidate.specifier === undefined
            ? probe.otherReferences > 0
            : probe.literals.has(candidate.specifier)
        );

  return { externalImports, dynamicRequires };
}

function formatList(items: string[]): string {
  const shown = items.slice(0, MAX_REPORTED);
  const rest = items.length - shown.length;
  if (rest > 0) shown.push(`…and ${rest} more`);
  return shown.join('\n');
}

export function formatFlowBundleSafetyReport(
  report: FlowBundleSafetyReport
): string {
  const sections: string[] = [
    'Workflow bundle cannot run in the workflow sandbox.',
    '',
    'Workflow functions are evaluated in a sandbox without `require`. The bundle below still contains',
    '`require()` calls, which throw `ReferenceError: require is not defined` when the bundle is loaded.',
  ];

  if (report.externalImports.length > 0) {
    const lines = report.externalImports.map((violation) => {
      const detail: string[] = [`  • "${violation.specifier}"`];
      if (violation.importers.length > 0) {
        detail.push(`    imported by ${violation.importers[0]}`);
        if (violation.importers.length > 1) {
          detail.push(
            `    (and ${violation.importers.length - 1} other ${
              violation.importers.length === 2 ? 'module' : 'modules'
            })`
          );
        }
      }
      if (violation.importChain.length > 1) {
        detail.push(`    via ${violation.importChain.join(' → ')}`);
      }
      return detail.join('\n');
    });
    sections.push(
      '',
      `Imports left external (${report.externalImports.length}):`,
      formatList(lines)
    );
  }

  if (report.dynamicRequires.length > 0) {
    const lines = report.dynamicRequires.map((violation) => {
      const where = violation.module
        ? `${violation.module} (bundle ${violation.line}:${violation.column})`
        : `bundle ${violation.line}:${violation.column}`;
      const what = violation.specifier
        ? `require("${violation.specifier}")`
        : 'dynamic require()';
      return `  • ${what} in ${where}\n    ${violation.snippet}`;
    });
    sections.push(
      '',
      `Unresolved require() calls (${report.dynamicRequires.length}):`,
      formatList(lines)
    );
  }

  sections.push('', `Learn more: ${DOCS_URL}`);
  return sections.join('\n');
}

function buildHint(report: FlowBundleSafetyReport): string {
  const parts: string[] = [];
  if (report.externalImports.length > 0) {
    parts.push(
      report.externalImports.some((violation) => violation.isRuntimeBuiltin)
        ? 'Move the code that needs Node.js built-ins into a "use step" function, or import the package only from step files.'
        : 'Import these modules from a "use step" function instead of from workflow code.'
    );
  }
  if (report.dynamicRequires.length > 0) {
    parts.push(
      'Replace dynamic require() with a static import, or move the calling code into a "use step" function.'
    );
  }
  parts.push(
    `Set ${ALLOW_UNSAFE_FLOW_BUNDLE_ENV}=1 to downgrade this to a warning (the bundle will still fail at runtime if the code runs).`
  );
  return parts.join(' ');
}

/**
 * Fails the build when the flow bundle contains anything the workflow sandbox
 * cannot evaluate.
 *
 * @param warn - Sink for the downgraded message when the escape hatch is set.
 */
export async function assertFlowBundleIsSandboxSafe({
  bundleText,
  metafile,
  warn = (message: string) => console.warn(message),
}: {
  bundleText: string;
  metafile?: esbuild.Metafile;
  warn?: (message: string) => void;
}): Promise<FlowBundleSafetyReport> {
  const report = await analyzeFlowBundleSafety({ bundleText, metafile });
  if (isFlowBundleSafetyReportEmpty(report)) return report;

  const message = formatFlowBundleSafetyReport(report);
  const hint = buildHint(report);

  if (process.env[ALLOW_UNSAFE_FLOW_BUNDLE_ENV] === '1') {
    warn(`${message}\n${hint}`);
    return report;
  }

  throw new WorkflowBuildError(message, { hint });
}
