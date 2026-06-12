/**
 * validate-registry — structural validation of every installable pattern's
 * shadcn registry payload. Run via `pnpm validate-registry` (from docs/);
 * CI runs it on every PR touching patterns.
 *
 * Checks, per installable item:
 *   1. The /r payload contains at least one file; every file has non-empty
 *      content and a `workflows/`-prefixed path.
 *   2. Every emitted file parses as TypeScript (catches template-literal
 *      escaping bugs and corrupted generated output).
 *   3. The manifest's `files[]` metadata agrees with the actually-emitted
 *      workflow files (no phantom or missing paths).
 *   4. Bare (npm) imports in emitted files are declared in `dependencies`
 *      — except `workflow`/`workflow/*`, which every workflow app has.
 *   5. `shadcnSlug` ends with `/r/<id>`; `DOCS:` URLs in file content point
 *      at existing pattern ids.
 *   6. `process.env.X` references in emitted files are declared in
 *      `envVars`.
 */

import ts from 'typescript';
import { registryItems } from '../lib/patterns/manifest';

const WORKFLOW_PATH_PREFIX = 'workflows/';
// Packages every workflow app has by definition.
const IMPLICIT_PACKAGES = new Set(['workflow']);

interface Problem {
  id: string;
  message: string;
}

const problems: Problem[] = [];

function barePackageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('@/')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function collectImports(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

const allIds = new Set(registryItems.map((item) => item.id));

for (const item of registryItems) {
  if (item.installable === false) continue;

  // Mirror the /r route's file-collection logic.
  const seenPaths = new Set<string>();
  const files: Array<{ path: string; content: string }> = [];
  for (const snippet of item.snippets) {
    const caption = snippet.caption;
    if (
      !caption ||
      !(caption.startsWith(WORKFLOW_PATH_PREFIX) || caption.startsWith('lib/'))
    )
      continue;
    if (seenPaths.has(caption)) continue;
    seenPaths.add(caption);
    files.push({
      path: snippet.caption,
      content: snippet.installCode ?? snippet.code,
    });
  }

  // 1. Non-empty payload
  if (files.length === 0) {
    problems.push({
      id: item.id,
      message:
        'payload contains zero files — no snippet caption starts with workflows/',
    });
    continue;
  }
  for (const file of files) {
    if (!file.content || file.content.trim().length < 40) {
      problems.push({
        id: item.id,
        message: `${file.path}: empty or suspiciously short content`,
      });
    }
  }

  // 2. Files parse as TypeScript
  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true
    );
    const diagnostics = (
      sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }
    ).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const first = diagnostics[0];
      problems.push({
        id: item.id,
        message: `${file.path}: parse error — ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`,
      });
    }
  }

  // 3. files[] metadata agrees with emitted workflow files
  const declaredWorkflowPaths = item.files
    .map((f) => f.path)
    .filter((p) => p.startsWith(WORKFLOW_PATH_PREFIX) || p.startsWith('lib/'));
  for (const declared of declaredWorkflowPaths) {
    if (!seenPaths.has(declared)) {
      problems.push({
        id: item.id,
        message: `files[] declares ${declared} but the payload does not emit it`,
      });
    }
  }
  for (const emitted of seenPaths) {
    if (!declaredWorkflowPaths.includes(emitted)) {
      problems.push({
        id: item.id,
        message: `payload emits ${emitted} but files[] does not declare it`,
      });
    }
  }

  // 4. npm imports are declared dependencies
  const declaredDeps = new Set(item.dependencies ?? []);
  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true
    );
    for (const spec of collectImports(sf)) {
      const pkg = barePackageName(spec);
      if (!pkg || IMPLICIT_PACKAGES.has(pkg)) continue;
      if (!declaredDeps.has(pkg)) {
        problems.push({
          id: item.id,
          message: `${file.path} imports "${pkg}" but dependencies does not declare it`,
        });
      }
    }
  }

  // 5. Slug + DOCS links
  if (!item.shadcnSlug.endsWith(`/r/${item.id}`)) {
    problems.push({
      id: item.id,
      message: `shadcnSlug "${item.shadcnSlug}" does not end with /r/${item.id}`,
    });
  }
  for (const file of files) {
    for (const match of file.content.matchAll(
      /workflow-sdk\.dev\/patterns\/([a-z0-9-]+)/g
    )) {
      if (!allIds.has(match[1])) {
        problems.push({
          id: item.id,
          message: `${file.path}: DOCS link points at unknown pattern "${match[1]}"`,
        });
      }
    }
  }

  // 6. env vars referenced are declared
  const declaredEnv = new Set((item.envVars ?? []).map((e) => e.name));
  for (const file of files) {
    for (const match of file.content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!declaredEnv.has(match[1])) {
        problems.push({
          id: item.id,
          message: `${file.path} reads process.env.${match[1]} but envVars does not declare it`,
        });
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} registry problem(s):\n`);
  for (const p of problems) {
    console.error(`- [${p.id}] ${p.message}`);
  }
  process.exit(1);
}

console.log(
  `Registry OK — ${registryItems.filter((i) => i.installable !== false).length} installable patterns validated.`
);
