/**
 * Finds module-scope state that changes at runtime.
 *
 * `@workflow/world-vercel` and `@workflow/world-local` are *bundled* into the
 * host application's server build (see `VERCEL_WORLD_DEPENDENCY_PACKAGES` in
 * `packages/next/src/index.ts`). A bundler keys module identity on
 * (resource, layer), so one process holds one copy of each of these modules
 * *per layer* — Next.js alone builds `instrument`, app-route, `ssr` and `edge`
 * layers, and code registered from `instrumentation.ts` therefore does not
 * share module scope with code that runs in a route handler.
 *
 * That makes every mutable module-scope binding a per-copy variable rather
 * than the process-wide singleton its author assumed. vercel/workflow#3493
 * turned these packages from external into bundled and the WebSocket events
 * transport silently regressed to HTTP for exactly this reason: the queue
 * consumer registered its channel in the `instrument` copy's `Map` and the
 * write path looked it up in the route copy's empty one.
 *
 * The fix is `globalSingleton()` from `@workflow/utils`, which parks the state
 * on `globalThis` under a `Symbol.for()` key so every copy shares one object.
 * This rule fails the build on anything that reintroduces the pattern.
 *
 * Two escapes:
 *   - initialize the binding with `globalSingleton(...)` — the fix itself;
 *   - annotate it `// per-copy-ok: <why per-copy is correct here>` when the
 *     state is deliberately per module instance (a diagnostic describing what
 *     *this* copy sees, for example).
 *
 * Usage: node scripts/lint/module-scope-state.mjs <packageDir> [...]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Methods that mutate the receiver in place. */
const MUTATORS = new Set([
  'set',
  'delete',
  'clear',
  'add',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

const SINGLETON_HELPER = 'globalSingleton';
const PRAGMA = /(?:^|\s)per-copy-ok:\s*(\S.*)$/;

function walkSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) {
      continue;
    }
    out.push(full);
  }
  return out;
}

/** `globalSingleton(...)` — including a namespaced `utils.globalSingleton(...)`. */
function isGlobalSingletonCall(node) {
  if (!node) return false;
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return isGlobalSingletonCall(node.expression);
  }
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === SINGLETON_HELPER;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === SINGLETON_HELPER;
  }
  return false;
}

/**
 * The identifier a member chain is rooted at, so `state.pools.set(…)` is
 * recognized as a mutation of `state`.
 */
function rootIdentifier(node) {
  let current = node;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

/** A `// per-copy-ok: <reason>` comment directly above the declaration. */
function perCopyReason(statement, text) {
  const ranges = ts.getLeadingCommentRanges(text, statement.getFullStart());
  if (!ranges) return undefined;
  for (const range of ranges) {
    const match = PRAGMA.exec(text.slice(range.pos, range.end).trim());
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Module-scope `const`/`let` bindings in `source`, keyed by name. */
function collectDeclarations(source) {
  const declared = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      declared.set(declaration.name.text, {
        name: declaration.name.text,
        isConst,
        declaration,
        statement,
      });
    }
  }
  return declared;
}

/** `x = …`, `x.field = …`, `x += …`. */
function assignment(node) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
    node.operatorToken.kind > ts.SyntaxKind.LastAssignment
  ) {
    return undefined;
  }
  if (ts.isIdentifier(node.left)) {
    return { name: node.left.text, reason: 'reassigned' };
  }
  if (
    ts.isPropertyAccessExpression(node.left) ||
    ts.isElementAccessExpression(node.left)
  ) {
    return { name: rootIdentifier(node.left), reason: 'field written' };
  }
  return undefined;
}

/** `x++`, `--x`. */
function increment(node) {
  if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node)) {
    return undefined;
  }
  if (
    (node.operator !== ts.SyntaxKind.PlusPlusToken &&
      node.operator !== ts.SyntaxKind.MinusMinusToken) ||
    !ts.isIdentifier(node.operand)
  ) {
    return undefined;
  }
  return { name: node.operand.text, reason: 'reassigned' };
}

/** `x.set(…)`, `x.items.push(…)` — a call that mutates its receiver. */
function mutatingCall(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !MUTATORS.has(node.expression.name.text)
  ) {
    return undefined;
  }
  return {
    name: rootIdentifier(node.expression.expression),
    reason: `\`.${node.expression.name.text}()\``,
  };
}

/** `delete x.field`. */
function deletion(node) {
  if (
    !ts.isDeleteExpression(node) ||
    (!ts.isPropertyAccessExpression(node.expression) &&
      !ts.isElementAccessExpression(node.expression))
  ) {
    return undefined;
  }
  return { name: rootIdentifier(node.expression), reason: 'field deleted' };
}

/** How `node` changes a binding, if it changes one at all. */
function mutationIn(node) {
  return (
    assignment(node) ?? increment(node) ?? mutatingCall(node) ?? deletion(node)
  );
}

function scanFile(file, repoRoot) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true
  );

  const declared = collectDeclarations(source);
  if (declared.size === 0) return [];

  /** name -> how it was first seen changing. */
  const mutations = new Map();
  const visit = (node) => {
    const mutation = mutationIn(node);
    if (
      mutation?.name &&
      declared.has(mutation.name) &&
      !mutations.has(mutation.name)
    ) {
      mutations.set(mutation.name, mutation.reason);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const findings = [];
  for (const binding of declared.values()) {
    const how = mutations.get(binding.name);
    if (!how) continue; // never changes: one copy per layer is harmless
    if (isGlobalSingletonCall(binding.declaration.initializer)) continue;
    if (perCopyReason(binding.statement, text)) continue;

    const { line } = source.getLineAndCharacterOfPosition(
      binding.declaration.getStart(source)
    );
    findings.push({
      file: path.relative(repoRoot, file),
      line: line + 1,
      name: binding.name,
      keyword: binding.isConst ? 'const' : 'let',
      reason: how,
    });
  }
  return findings;
}

/** Scan one package directory (the one holding its `package.json`). */
export function scanPackage(packageDir, repoRoot = process.cwd()) {
  const findings = [];
  for (const file of walkSourceFiles(path.join(packageDir, 'src'))) {
    findings.push(...scanFile(file, repoRoot));
  }
  return findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
  );
}

export function formatFindings(findings) {
  return findings
    .map(
      (f) =>
        `${f.file}:${f.line}  ${f.keyword} ${f.name}  (${f.reason})\n` +
        '    A bundler keys module identity on (resource, layer), so once this\n' +
        '    package is bundled one process holds one copy of this module per\n' +
        '    layer — Next.js alone builds instrument, app-route, ssr and edge.\n' +
        '    This binding is therefore per-copy state, not a process singleton.\n' +
        '\n' +
        '    Hold it on the World instance if it is per-World, or on globalThis\n' +
        '    via globalSingleton() from @workflow/utils if it is process-wide.\n' +
        '    If per-copy is what you want, say why:\n' +
        '      // per-copy-ok: <reason>\n' +
        '\n' +
        '    Background: packages/utils/src/global-singleton.ts, and\n' +
        '    docs/content/worlds/v5/building-a-world.mdx#process-wide-state.'
    )
    .join('\n\n');
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const packages = process.argv.slice(2);
  if (packages.length === 0) {
    console.error(
      'usage: node scripts/lint/module-scope-state.mjs <packageDir> [...]'
    );
    process.exit(2);
  }
  let total = 0;
  for (const pkg of packages) {
    const findings = scanPackage(pkg);
    total += findings.length;
    console.log(`\n${pkg} — ${findings.length}`);
    if (findings.length > 0) console.log(formatFindings(findings));
  }
  console.log(`\nTOTAL ${total}`);
  process.exit(total === 0 ? 0 : 1);
}
