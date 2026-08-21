/**
 * Finds module-scope state that changes at runtime.
 *
 * `@workflow/world-vercel` and `@workflow/world-local` are *bundled* into the
 * host application's server build (see `VERCEL_WORLD_DEPENDENCY_PACKAGES` in
 * `packages/next/src/index.ts`). A bundler keys module identity on
 * (resource, layer), so one process holds one copy of each of these modules
 * *per layer*. Next.js alone builds `instrument`, app-route, `ssr` and `edge`
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
 *   - initialize the binding from `globalSingleton(...)` or from `globalThis`
 *     directly, the fix itself;
 *   - annotate it `// per-copy-ok: <why per-copy is correct here>` when the
 *     state is deliberately per module instance (a diagnostic describing what
 *     *this* copy sees, for example).
 *
 * What it sees: `const`/`let` statements and `static` class fields, mutated
 * from inside a function body. Writes in top-level statements are ignored,
 * because they run identically in every copy at module evaluation, so a
 * precomputed lookup table is not a finding. An *exported* binding initialized
 * to an empty collection is a finding on its own, since the code that fills it
 * is often in another file.
 *
 * What it does not see: a write to an imported binding, resolved across files.
 * That needs whole-package resolution. The exported-empty-collection rule above
 * is the cheap approximation, and it is why exporting a mutable registry is
 * reported even when this file never writes to it.
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
    // `.mts`/`.cts` as well as `.ts`: `@workflow/world-testing` is authored in
    // `.mts`, and skipping those extensions made its sweep pass vacuously.
    if (!/\.(ts|mts|cts)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|mts|cts)$/.test(entry.name)) continue;
    if (/\.d\.(ts|mts|cts)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** `globalSingleton(...)`, including a namespaced `utils.globalSingleton(...)`. */
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
 * Whether an initializer reaches `globalThis`, so the hand-rolled
 * `const store = globalThis as …` / `const x = (globalThis[Key] ??= …)` shape is
 * accepted alongside `globalSingleton()`. Both park the state off-module, which
 * is the property this rule is actually checking for; `packages/core`'s step
 * registry and the pattern documented for custom world authors in
 * `docs/content/worlds/*\/building-a-world.mdx` are both written this way.
 */
function isGlobalThisBacked(node, aliases = new Set()) {
  if (!node) return false;
  if (ts.isIdentifier(node)) {
    return node.text === 'globalThis' || aliases.has(node.text);
  }
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return isGlobalThisBacked(node.expression, aliases);
  }
  if (ts.isBinaryExpression(node)) {
    // `globalThis[Key] ??= {…}` and friends.
    return (
      isGlobalThisBacked(node.left, aliases) ||
      isGlobalThisBacked(node.right, aliases)
    );
  }
  return false;
}

/**
 * Names in this file that are themselves globalThis-backed, so a binding
 * derived from one is too. The documented pattern takes two statements: an
 * alias for `globalThis`, then the state read off it.
 */
function globalThisAliases(declared) {
  const aliases = new Set();
  for (const binding of declared.values()) {
    if (isGlobalThisBacked(binding.declaration.initializer, aliases)) {
      aliases.add(binding.name);
    }
  }
  return aliases;
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

/**
 * Module-scope bindings in `source`, keyed by the name a mutation would be
 * attributed to.
 *
 * Covers `const`/`let` statements and `static` class fields. A static field is
 * module-scope state wearing a class as its namespace: `Registry.transports`
 * duplicates per copy exactly like a top-level `const` would, and is attributed
 * to the class name because that is how it is written to.
 */
function collectDeclarations(source) {
  const declared = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
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
      continue;
    }
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    for (const member of statement.members) {
      if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) {
        continue;
      }
      const isStatic = member.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.StaticKeyword
      );
      if (!isStatic) continue;
      // Keyed on the class name: writes read as `Registry.transports.set(…)`,
      // which `rootIdentifier` attributes to `Registry`.
      declared.set(statement.name.text, {
        name: `${statement.name.text}.${member.name.text}`,
        isConst: false,
        declaration: member,
        statement,
        keyword: 'static',
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

/** `x.set(…)`, `x.items.push(…)`: a call that mutates its receiver. */
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

/**
 * An empty collection literal: `new Map()`, `new Set()`, `[]`. A module-scope
 * binding initialized to one and *exported* is a registry something fills, and
 * the filling is often in another file, which this single-file walk cannot see.
 * That is the shipped bug's exact shape, so the emptiness plus the export is
 * treated as the signal. A non-empty initializer is a lookup table and is left
 * alone.
 */
function isEmptyCollection(node) {
  if (!node) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.length === 0;
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  const collections = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
  if (!collections.has(node.expression.text)) return false;
  return !node.arguments || node.arguments.length === 0;
}

function isExported(statement) {
  return Boolean(
    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

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
  const aliases = globalThisAliases(declared);

  /** key -> how it was first seen changing. */
  const mutations = new Map();
  // Only mutations inside a function body count. A write in a top-level
  // statement runs once per copy at module evaluation and produces the same
  // value in each, so a precomputed lookup table is not the hazard this rule
  // is looking for; divergence needs a write that happens later, per request.
  const visit = (node, inFunction) => {
    if (inFunction) {
      const mutation = mutationIn(node);
      if (
        mutation?.name &&
        declared.has(mutation.name) &&
        !mutations.has(mutation.name)
      ) {
        mutations.set(mutation.name, mutation.reason);
      }
    }
    const nowInFunction = inFunction || FUNCTION_LIKE.has(node.kind);
    ts.forEachChild(node, (child) => visit(child, nowInFunction));
  };
  visit(source, false);

  const findings = [];
  for (const [key, binding] of declared) {
    const initializer = binding.declaration.initializer;
    let how = mutations.get(key);
    if (
      !how &&
      isExported(binding.statement) &&
      isEmptyCollection(initializer)
    ) {
      how = 'exported empty collection';
    }
    if (!how) continue; // never changes: one copy per layer is harmless
    if (isGlobalSingletonCall(initializer)) continue;
    if (isGlobalThisBacked(initializer, aliases)) continue;
    if (perCopyReason(binding.statement, text)) continue;

    const { line } = source.getLineAndCharacterOfPosition(
      binding.declaration.getStart(source)
    );
    findings.push({
      file: path.relative(repoRoot, file),
      line: line + 1,
      name: binding.name,
      keyword: binding.keyword ?? (binding.isConst ? 'const' : 'let'),
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
        '    layer. Next.js alone builds instrument, app-route, ssr and edge.\n' +
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
    console.log(`\n${pkg}: ${findings.length}`);
    if (findings.length > 0) console.log(formatFindings(findings));
  }
  console.log(`\nTOTAL ${total}`);
  process.exit(total === 0 ? 0 : 1);
}
