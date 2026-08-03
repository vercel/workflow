import { type ModuleItem, parseSync } from '@swc/core';
import { join, relative, resolve } from 'pathe';

/**
 * Rewrite externalized .ts/.tsx imports in steps bundle content to use require()
 * for CommonJS compatibility.
 *
 * @returns Object with rewritten content and the number of imports rewritten.
 * matchCount is 0 when no relative .ts/.tsx imports were found.
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
  const module = parseSync(stepsContent, {
    syntax: 'ecmascript',
    target: 'es2022',
    comments: false,
  });

  if (module.body.length === 0) return { content: stepsContent, matchCount: 0 };

  // SWC's `span.start` is a 1-based UTF-8 byte offset into a global counter
  // shared across all parseSync calls in the process (each parse leaves the
  // cursor at the end of the previous source). For a freshly-parsed source,
  // `module.span.start` points to the first byte SWC considers part of the
  // module's text — which empirically:
  //   • starts BEFORE leading line/block comments and a leading BOM
  //     (SWC skips those out of `module.span`), but
  //   • starts AT a leading shebang line (SWC keeps the shebang inside the
  //     module span and exposes its text via `module.interpreter`).
  // We want a base such that for any token, `token.span.start - base - 1`
  // equals the local UTF-8 byte offset of that token within `stepsContent`.
  // Subtracting the byte-length of leading comments/BOM (but NOT the
  // shebang) from `module.span.start` gives us the SWC position
  // corresponding to source byte 0, and the trailing `- 1` converts the
  // 1-based offset into a 0-based base.
  const toStringIndex = createBytePositionMapper(
    stepsContent,
    module.span.start - getLeadingCommentByteOffset(stepsContent) - 1
  );

  const replacements = module.body.flatMap((item, index) => {
    const rewriteOptions = {
      importIndex: index,
      toStringIndex,
      outDir,
      workingDir,
      distDir,
      dirs,
    };
    return getImportRewrite(item, rewriteOptions);
  });

  if (replacements.length === 0)
    return { content: stepsContent, matchCount: 0 };

  let rewritten = stepsContent;
  for (const replacement of [...replacements].reverse()) {
    rewritten =
      rewritten.slice(0, replacement.start) +
      replacement.code +
      rewritten.slice(replacement.end);
  }

  return { content: rewritten, matchCount: replacements.length };
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

type ImportRewriteOptions = {
  importIndex: number;
  toStringIndex: (swcBytePosition: number) => number;
  outDir: string;
  workingDir: string;
  distDir: string;
  dirs: string[];
};

type Replacement = {
  start: number;
  end: number;
  code: string;
};

function getImportRewrite(
  item: ModuleItem,
  options: ImportRewriteOptions
): Replacement[] {
  if (item.type !== 'ImportDeclaration') return [];

  const source = item.source.value;
  if (!isRelativeTypeScriptImport(source)) return [];

  const requirePath = getRequirePath(source, options);
  const code = importDeclarationToRequire(
    item,
    requirePath,
    options.importIndex
  );

  return [
    {
      start: options.toStringIndex(item.span.start),
      end: options.toStringIndex(item.span.end),
      code,
    },
  ];
}

function isRelativeTypeScriptImport(source: string): boolean {
  return (
    (source.startsWith('./') || source.startsWith('../')) &&
    /\.tsx?$/.test(source)
  );
}

function getRequirePath(
  tsRelativePath: string,
  { outDir, workingDir, distDir, dirs }: ImportRewriteOptions
): string {
  const absSourcePath = resolve(outDir, tsRelativePath);
  const relToWorkingDir = relative(workingDir, absSourcePath);
  const distRelPath = mapSourceToDistPath(relToWorkingDir, dirs, distDir);
  const distAbsPath = join(workingDir, distRelPath);
  let newRelPath = relative(outDir, distAbsPath).replace(/\\/g, '/');
  if (!newRelPath.startsWith('.')) {
    newRelPath = `./${newRelPath}`;
  }
  return newRelPath;
}

function importDeclarationToRequire(
  declaration: Extract<ModuleItem, { type: 'ImportDeclaration' }>,
  requirePath: string,
  importIndex: number
): string {
  const requireCall = `require(${JSON.stringify(requirePath)})`;
  const bindings = getImportBindings(declaration);

  if (declaration.specifiers.length === 0) {
    return `${requireCall};`;
  }

  if (bindings.defaultLocal || bindings.namespaceLocal) {
    return moduleBindingToRequire(bindings, requireCall, importIndex);
  }

  return `const { ${bindings.namedProperties.join(', ')} } = ${requireCall};`;
}

type ImportBindings = {
  defaultLocal?: string;
  namespaceLocal?: string;
  namedProperties: string[];
};

function getImportBindings(
  declaration: Extract<ModuleItem, { type: 'ImportDeclaration' }>
): ImportBindings {
  const bindings: ImportBindings = { namedProperties: [] };

  for (const specifier of declaration.specifiers) {
    if (specifier.type === 'ImportDefaultSpecifier')
      bindings.defaultLocal = specifier.local.value;
    if (specifier.type === 'ImportNamespaceSpecifier')
      bindings.namespaceLocal = specifier.local.value;
    if (specifier.type === 'ImportSpecifier') {
      bindings.namedProperties.push(getNamedProperty(specifier));
    }
  }

  return bindings;
}

function getNamedProperty(
  specifier: Extract<
    Extract<ModuleItem, { type: 'ImportDeclaration' }>['specifiers'][number],
    { type: 'ImportSpecifier' }
  >
): string {
  const imported =
    specifier.imported?.type === 'StringLiteral'
      ? JSON.stringify(specifier.imported.value)
      : (specifier.imported?.value ?? specifier.local.value);
  const local = specifier.local.value;
  return imported === local ? local : `${imported}: ${local}`;
}

function moduleBindingToRequire(
  bindings: ImportBindings,
  requireCall: string,
  importIndex: number
): string {
  const moduleBinding = `__workflow_cjs_import_${importIndex}`;
  const statements = [`const ${moduleBinding} = ${requireCall};`];

  if (bindings.defaultLocal) {
    statements.push(
      defaultBindingToRequire(bindings.defaultLocal, moduleBinding)
    );
  }
  if (bindings.namespaceLocal) {
    statements.push(`const ${bindings.namespaceLocal} = ${moduleBinding};`);
  }
  if (bindings.namedProperties.length > 0) {
    statements.push(
      `const { ${bindings.namedProperties.join(', ')} } = ${moduleBinding};`
    );
  }

  return statements.join('\n');
}

function defaultBindingToRequire(
  localName: string,
  moduleBinding: string
): string {
  return (
    `const ${localName} = ${moduleBinding} != null && ` +
    `Object.prototype.hasOwnProperty.call(${moduleBinding}, "default") ` +
    `? ${moduleBinding}.default : ${moduleBinding};`
  );
}

function createBytePositionMapper(
  source: string,
  swcBasePosition: number
): (swcBytePosition: number) => number {
  const byteOffsetToStringIndex = new Map<number, number>();
  const encoder = new TextEncoder();
  let byteOffset = 0;

  for (let index = 0; index < source.length; ) {
    byteOffsetToStringIndex.set(byteOffset, index);
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    byteOffset += encoder.encode(character).byteLength;
    index += character.length;
  }
  byteOffsetToStringIndex.set(byteOffset, source.length);

  return (swcBytePosition: number) => {
    // SWC positions are 1-based UTF-8 byte offsets.
    const byteOffset = swcBytePosition - swcBasePosition - 1;
    const stringIndex = byteOffsetToStringIndex.get(byteOffset);
    if (stringIndex === undefined) {
      throw new Error(
        `Unable to map SWC byte position ${swcBytePosition} to a string index`
      );
    }
    return stringIndex;
  };
}

/**
 * Compute the UTF-8 byte length of any leading content that SWC excludes from
 * `module.span` — leading whitespace (including a BOM), `//` line comments,
 * and `/* … *\/` block comments.
 *
 * A leading shebang line is intentionally NOT skipped: SWC keeps the shebang
 * inside `module.span`, so this helper must return 0 for it.
 */
function getLeadingCommentByteOffset(source: string): number {
  let index = 0;

  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }

    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index);
      continue;
    }

    if (source.startsWith('/*', index)) {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }

    break;
  }

  return new TextEncoder().encode(source.slice(0, index)).byteLength;
}

function skipLineComment(source: string, index: number): number {
  const newlineIndex = source.indexOf('\n', index);
  return newlineIndex === -1 ? source.length : newlineIndex + 1;
}
