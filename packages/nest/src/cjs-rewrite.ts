import { join, resolve, relative } from 'pathe';

/**
 * Regex to match named imports from relative .ts/.tsx files (externalized by esbuild).
 * esbuild's externalized output emits named imports (`import { ... } from "..."`).
 * Namespace imports (import * as) and default imports are not emitted for externalized
 * source files in this context.
 */
export const TS_IMPORT_REGEX =
  /import\s*\{([^}]+)\}\s*from\s*["']((?:\.\.?\/)+[^"']+\.tsx?)["']\s*;?/g;

/**
 * Rewrite externalized .ts/.tsx imports in steps bundle content to use require()
 * for CommonJS compatibility.
 *
 * @returns Object with rewritten content and the number of imports rewritten.
 * matchCount is 0 when no .ts/.tsx imports were found (valid when no externalized
 * imports exist, or could indicate esbuild output format change).
 */
export function rewriteTsImportsInContent(
  stepsContent: string,
  options: {
    outDir: string;
    workingDir: string;
    distDir: string;
    dirs: string[];
  }
): { content: string; matchCount: number } {
  const { outDir, workingDir, distDir, dirs } = options;
  const countRegex = new RegExp(TS_IMPORT_REGEX.source, TS_IMPORT_REGEX.flags);
  const matches: Array<{ fullMatch: string; imports: string; path: string }> =
    [];
  let m;
  while ((m = countRegex.exec(stepsContent)) !== null) {
    matches.push({ fullMatch: m[0], imports: m[1], path: m[2] });
  }

  if (matches.length === 0) {
    return { content: stepsContent, matchCount: 0 };
  }

  const replaceRegex = new RegExp(
    TS_IMPORT_REGEX.source,
    TS_IMPORT_REGEX.flags
  );
  const rewritten = stepsContent.replace(
    replaceRegex,
    (_match, imports: string, tsRelativePath: string) => {
      const absSourcePath = resolve(outDir, tsRelativePath);
      const relToWorkingDir = relative(workingDir, absSourcePath);
      const distRelPath = mapSourceToDistPath(relToWorkingDir, dirs, distDir);
      const distAbsPath = join(workingDir, distRelPath);
      let newRelPath = relative(outDir, distAbsPath).replace(/\\/g, '/');
      if (!newRelPath.startsWith('.')) {
        newRelPath = `./${newRelPath}`;
      }
      const cjsImports = imports.replace(/\s+as\s+/g, ': ');
      return `const {${cjsImports}} = require("${newRelPath}");`;
    }
  );

  return { content: rewritten, matchCount: matches.length };
}

/**
 * Map a source file path (relative to workingDir) to the compiled path in distDir.
 *
 * For dirs=['src'], distDir='dist': "src/services/foo.ts" → "dist/services/foo.js"
 *
 * When dirs includes ".", prefix is empty so no dir matches in the loop; we fall
 * through to the default which prepends distDir to the entire path.
 * e.g. dirs: [".", "src"] — "src/foo.ts" matches "src", files outside match "."
 */
export function mapSourceToDistPath(
  relToWorkingDir: string,
  dirs: string[],
  distDir: string
): string {
  const normalized = relToWorkingDir.replace(/\\/g, '/');

  for (const dir of dirs) {
    const prefix = dir === '.' ? '' : `${dir}/`;
    if (prefix && normalized.startsWith(prefix)) {
      const withinDir = normalized.slice(prefix.length);
      return join(distDir, withinDir).replace(/\.tsx?$/, '.js');
    }
  }

  return join(distDir, normalized).replace(/\.tsx?$/, '.js');
}
