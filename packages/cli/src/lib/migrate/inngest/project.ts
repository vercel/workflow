import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type * as TS from 'typescript';
import type { FileReport } from './report-types.js';
import {
  INFER_MARK,
  isTypeScriptFile,
  TYPE_END,
  TYPE_START,
  tidyType,
  transformInngestFile,
} from './transform.js';

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

/** Directories that never hold application source. */
export const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/.svelte-kit/**',
  '**/.vercel/**',
  '**/.turbo/**',
  '**/.well-known/workflow/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

/**
 * Load the TypeScript compiler API: the project's own copy first (so the
 * parser matches the syntax the project is written in), then the one next to
 * the CLI. TypeScript is an optional peer dependency of the CLI, because
 * only this command needs it.
 */
export function loadTypeScript(cwd: string): typeof TS {
  const candidates = [join(cwd, 'package.json'), import.meta.url];
  for (const from of candidates) {
    try {
      const required = createRequire(from)('typescript') as Partial<
        typeof TS
      > & { default?: typeof TS };
      const ts = (
        typeof required.createSourceFile === 'function'
          ? required
          : required.default
      ) as typeof TS | undefined;
      if (ts && typeof ts.createLanguageService === 'function') return ts;
    } catch {
      // try the next location
    }
  }
  throw new Error(
    'The Inngest codemod needs the TypeScript compiler API. Install it in your project (npm install --save-dev typescript), or run: npx -p typescript -p workflow workflow migrate inngest'
  );
}

export interface ProjectMigrationResult {
  reports: FileReport[];
  /** Absolute file name -> new contents, for files that changed. */
  outputs: Map<string, string>;
  /** Files whose output failed to parse; they are not in `outputs`. */
  failed: Array<{ file: string; error: string }>;
  tsconfig?: string;
}

export interface ProjectMigrationOptions {
  ts: typeof TS;
  cwd: string;
  /** Files to consider (absolute). */
  files: string[];
  tsconfig?: string;
}

export function findTsconfig(ts: typeof TS, cwd: string): string | undefined {
  const found = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
  return found ? resolve(found) : undefined;
}

/**
 * Files to migrate. With no explicit paths, the project's tsconfig decides
 * (its `include`/`exclude`), so the codemod sees the same files the project
 * compiles. Without a tsconfig, or for explicit directories, source files are
 * globbed with the usual build and dependency directories ignored.
 */
export async function resolveFiles(
  ts: typeof TS,
  cwd: string,
  paths: string[],
  tsconfig: string | undefined
): Promise<string[]> {
  const { glob } = await import('tinyglobby');
  const ignore = [...DEFAULT_IGNORES, ...gitignorePatterns(cwd)];
  const out = new Set<string>();

  if (paths.length === 0 && tsconfig) {
    const parsed = parseTsconfig(ts, tsconfig);
    for (const file of parsed?.fileNames ?? []) {
      if (isSource(file) && !file.includes('/node_modules/'))
        out.add(resolve(file));
    }
    // A tsconfig without allowJs leaves JavaScript sources out; pick them up.
    const js = await glob(['**/*.{js,jsx,mjs,cjs}'], {
      cwd,
      ignore,
      absolute: true,
    });
    for (const file of js) out.add(resolve(file));
  } else {
    for (const path of paths.length ? paths : ['.']) {
      const absolute = resolve(cwd, path);
      if (!existsSync(absolute))
        throw new Error(`No such file or directory: ${path}`);
      if (statSync(absolute).isFile()) {
        out.add(absolute);
        continue;
      }
      const matches = await glob(
        [`**/*.{${SOURCE_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`],
        {
          cwd: absolute,
          ignore,
          absolute: true,
        }
      );
      for (const file of matches) out.add(resolve(file));
    }
  }
  return [...out].filter((file) => isSource(file)).sort();
}

function isSource(file: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)) &&
    !/\.d\.[mc]?ts$/.test(file)
  );
}

function gitignorePatterns(cwd: string): string[] {
  try {
    return readFileSync(join(cwd, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
      .map((line) => {
        const pattern = line.replace(/^\//, '').replace(/\/$/, '');
        return pattern.includes('/') ? `${pattern}/**` : `**/${pattern}/**`;
      });
  } catch {
    return [];
  }
}

function parseTsconfig(
  ts: typeof TS,
  tsconfig: string
): TS.ParsedCommandLine | undefined {
  const host: TS.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  return ts.getParsedCommandLineOfConfigFile(tsconfig, {}, host);
}

/** Quick text filter: only files that can contain Inngest code. */
export function mightUseInngest(text: string): boolean {
  return (
    text.includes('createFunction') ||
    /\binngest\b/i.test(text) ||
    text.includes('NonRetriableError') ||
    text.includes('RetryAfterError')
  );
}

/**
 * A language service over the project, with an in-memory overlay for the
 * files the codemod has rewritten. Each pass reads the program once, so the
 * project is type-checked three times in total, not once per file.
 */
class Project {
  private readonly versions = new Map<string, number>();
  private readonly overlay = new Map<string, string>();
  private readonly service: TS.LanguageService;

  constructor(
    private readonly ts: typeof TS,
    readonly rootNames: string[],
    readonly options: TS.CompilerOptions,
    cwd: string
  ) {
    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => this.rootNames,
      getScriptVersion: (file) => String(this.versions.get(resolve(file)) ?? 0),
      getScriptSnapshot: (file) => {
        const text = this.read(file);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => cwd,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (file) =>
        this.overlay.has(resolve(file)) || ts.sys.fileExists(file),
      readFile: (file) => this.read(file),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  read(file: string): string | undefined {
    const key = resolve(file);
    if (this.overlay.has(key)) return this.overlay.get(key);
    return this.ts.sys.readFile(file);
  }

  write(file: string, text: string): void {
    const key = resolve(file);
    this.overlay.set(key, text);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  program(): TS.Program {
    const program = this.service.getProgram();
    if (!program)
      throw new Error('TypeScript could not create a program for the project.');
    return program;
  }
}

export function migrateProject(
  options: ProjectMigrationOptions
): ProjectMigrationResult {
  const { ts, cwd } = options;
  const result: ProjectMigrationResult = {
    reports: [],
    outputs: new Map(),
    failed: [],
    tsconfig: options.tsconfig,
  };

  const candidates = options.files.filter((file) => {
    try {
      return mightUseInngest(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
  if (!candidates.length) return result;

  const parsed = options.tsconfig
    ? parseTsconfig(ts, options.tsconfig)
    : undefined;
  const compilerOptions: TS.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution:
      ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    skipLibCheck: true,
    ...(parsed?.options ?? {}),
    allowJs: true,
    checkJs: false,
    noEmit: true,
    // Unused-code checks would flag the codemod's output for reasons that
    // have nothing to do with the generated annotations.
    noUnusedLocals: false,
    noUnusedParameters: false,
  };
  const project = new Project(ts, candidates, compilerOptions, cwd);

  // Every Inngest client name in the project, so `inngest.send()` calls are
  // reported even in files that define no functions.
  const clientNames = new Set<string>();
  const program = project.program();
  for (const file of candidates) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const visit = (node: TS.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'Inngest'
      ) {
        clientNames.add(node.name.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'createFunction' &&
        ts.isIdentifier(node.expression)
      ) {
        clientNames.add(node.expression.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Pass 1: transform every file against the original program.
  const pending = new Map<string, string>();
  for (const file of candidates) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    let transformed: ReturnType<typeof transformInngestFile>;
    try {
      transformed = transformInngestFile({
        ts,
        sourceFile: sf,
        checker: program.getTypeChecker(),
        reportName: relative(cwd, file) || file,
        clientNames,
      });
    } catch (error) {
      // One file the codemod cannot handle must not stop the others.
      result.failed.push({
        file: relative(cwd, file),
        error: `the codemod failed on this file (${error instanceof Error ? error.message : String(error)}); it was left unchanged`,
      });
      continue;
    }
    const { code, report } = transformed;
    const relevant =
      report.changed || report.boundary.length || report.notes.length;
    if (relevant) result.reports.push(report);
    if (report.changed && code !== sf.text) pending.set(file, code);
  }
  for (const [file, code] of pending) project.write(file, code);

  // Pass 2: type the parameters the codemod added from their call sites.
  const typedFiles = [...pending.keys()].filter(isTypeScriptFile);
  if (typedFiles.length) {
    const program2 = project.program();
    const checker = program2.getTypeChecker();
    for (const file of typedFiles) {
      const sf = program2.getSourceFile(file);
      if (!sf) continue;
      const next = inferParameterTypes(ts, sf, checker);
      if (next !== sf.text) project.write(file, next);
    }

    // Pass 3: keep only the annotations the checker accepts.
    for (let round = 0; round < 2; round++) {
      const program3 = project.program();
      let changed = false;
      for (const file of typedFiles) {
        const sf = program3.getSourceFile(file);
        if (!sf || !sf.text.includes(TYPE_START)) continue;
        const diagnostics = program3.getSemanticDiagnostics(sf);
        const next = dropRejectedAnnotations(sf.text, diagnostics);
        if (next !== sf.text) {
          project.write(file, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  // Finalize: strip markers and refuse output that does not parse.
  for (const file of pending.keys()) {
    const text = stripMarkers(project.read(file) ?? '');
    const kind = file.endsWith('x') ? ts.ScriptKind.TSX : undefined;
    const check = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      kind
    );
    const syntax =
      (check as unknown as { parseDiagnostics?: TS.Diagnostic[] })
        .parseDiagnostics ?? [];
    if (syntax.length) {
      result.failed.push({
        file: relative(cwd, file),
        error: ts.flattenDiagnosticMessageText(syntax[0].messageText, '\n'),
      });
      continue;
    }
    result.outputs.set(file, text);
  }
  return result;
}

/** Replace each INFER_MARK with the type of the argument at the first call. */
export function inferParameterTypes(
  ts: typeof TS,
  sf: TS.SourceFile,
  checker: TS.TypeChecker
): string {
  const text = sf.text;
  if (!text.includes(INFER_MARK)) return text;
  const targets = new Map<
    string,
    Array<{
      index: number;
      markAt: number;
      declaration: TS.FunctionDeclaration;
    }>
  >();
  const calls = new Map<string, TS.CallExpression>();
  const visit = (node: TS.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      node.parameters.forEach((param, index) => {
        const at = param.name.end;
        if (text.startsWith(INFER_MARK, at)) {
          const list = targets.get(name) ?? [];
          list.push({ index, markAt: at, declaration: node });
          targets.set(name, list);
        }
      });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      !calls.has(node.expression.text)
    ) {
      calls.set(node.expression.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const replacements: Array<{ at: number; text: string }> = [];
  for (const [name, params] of targets) {
    const call = calls.get(name);
    for (const { index, markAt, declaration } of params) {
      const arg = call?.arguments[index];
      let annotation = '';
      if (arg) {
        let type = checker.getTypeAtLocation(arg);
        const base = (
          checker as { getBaseTypeOfLiteralType?: (t: TS.Type) => TS.Type }
        ).getBaseTypeOfLiteralType;
        if (base && type.flags & ts.TypeFlags.Literal)
          type = base.call(checker, type);
        if (type.flags & ts.TypeFlags.Any) {
          annotation = ': any';
        } else {
          const printed = checker.typeToString(
            type,
            declaration,
            ts.TypeFormatFlags.NoTruncation |
              ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
          );
          if (printed && printed.length <= 600 && !printed.includes('...')) {
            annotation = `: ${TYPE_START}${tidyType(printed)}${TYPE_END}`;
          }
        }
      }
      replacements.push({ at: markAt, text: annotation });
    }
  }
  let out = text;
  for (const { at, text: annotation } of replacements.sort(
    (a, b) => b.at - a.at
  )) {
    out = out.slice(0, at) + annotation + out.slice(at + INFER_MARK.length);
  }
  return out;
}

interface MarkedRange {
  /** Start of what to remove if the annotation is rejected. */
  removeStart: number;
  removeEnd: number;
  typeStart: number;
  typeEnd: number;
}

function markedRanges(text: string): MarkedRange[] {
  const out: MarkedRange[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(TYPE_START, from);
    if (start === -1) break;
    const end = text.indexOf(TYPE_END, start);
    if (end === -1) break;
    let removeStart = start;
    let removeEnd = end + TYPE_END.length;
    if (text.slice(start - 2, start) === ': ') removeStart = start - 2;
    else if (text[start - 1] === '<' && text[removeEnd] === '>') {
      removeStart = start - 1;
      removeEnd += 1;
    }
    out.push({
      removeStart,
      removeEnd,
      typeStart: start,
      typeEnd: end + TYPE_END.length,
    });
    from = end + TYPE_END.length;
  }
  return out;
}

export function dropRejectedAnnotations(
  text: string,
  diagnostics: readonly TS.Diagnostic[]
): string {
  const ranges = markedRanges(text);
  const rejected = ranges.filter((range) =>
    diagnostics.some(
      (d) =>
        d.start !== undefined &&
        d.start >= range.typeStart &&
        d.start < range.typeEnd
    )
  );
  let out = text;
  for (const range of rejected.sort((a, b) => b.removeStart - a.removeStart)) {
    // A parameter keeps an explicit `any` so strict projects still compile;
    // a rejected type argument is dropped and the default applies.
    const isParameter =
      out.slice(range.removeStart, range.removeStart + 2) === ': ';
    out =
      out.slice(0, range.removeStart) +
      (isParameter ? ': any' : '') +
      out.slice(range.removeEnd);
  }
  return out;
}

export function stripMarkers(text: string): string {
  return text
    .split(TYPE_START)
    .join('')
    .split(TYPE_END)
    .join('')
    .split(INFER_MARK)
    .join('');
}

export function projectRootFor(file: string): string {
  return dirname(file);
}
