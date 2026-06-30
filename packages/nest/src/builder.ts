import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import { dirname, join, resolve } from 'pathe';
import { rewriteTsImportsInContent } from './cjs-rewrite.js';

export interface NestBuilderOptions {
  /**
   * Working directory for the NestJS application
   * @default process.cwd()
   */
  workingDir?: string;
  /**
   * Directories to scan for workflow files
   * @default nest-cli.json sourceRoot or ['src']
   * @deprecated Prefer `sourceRoot` in nest-cli.json. This option remains as
   * an override for non-standard layouts.
   */
  dirs?: string[];
  /**
   * Project root used for monorepo workspace imports.
   * @default nearest workspace root, or workingDir when none is found
   */
  projectRoot?: string;
  /**
   * Output directory for generated workflow bundles
   * @default '.nestjs/workflow'
   */
  outDir?: string;
  /**
   * Enable watch mode for development
   * @default false
   */
  watch?: boolean;
  /**
   * SWC module compilation type.
   * Set to 'commonjs' if your NestJS project compiles to CJS via SWC.
   * When 'commonjs', the builder rewrites externalized imports in the
   * steps bundle to use require() via createRequire, avoiding ESM/CJS
   * named-export interop issues with SWC's _export() wrapper pattern.
   * @default .swcrc module.type, tsconfig module, or 'es6'
   * @deprecated Prefer `module.type` in .swcrc. This option remains as an
   * override for non-standard compiler setups.
   */
  moduleType?: 'es6' | 'commonjs';
  /**
   * Directory where NestJS compiles .ts source files to .js (relative to workingDir).
   * Used when moduleType is 'commonjs' to resolve compiled file paths.
   * This should match the `outDir` in your tsconfig.json.
   * @default tsconfig compilerOptions.outDir or 'dist'
   * @deprecated Prefer `compilerOptions.outDir` in tsconfig.json. This option
   * remains as an override for non-standard compiler setups.
   */
  distDir?: string;
  /**
   * Controls how source maps are emitted for workflow bundles. Accepts the
   * same values as esbuild's `sourcemap` option: `true`/`'inline'` (default),
   * `'linked'`, `'external'`, `'both'`, or `false` to omit source maps.
   * Can also be set via the `WORKFLOW_SOURCEMAP` environment variable.
   */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
}

export class NestLocalBuilder extends BaseBuilder {
  #outDir: string;
  #moduleType: 'es6' | 'commonjs';
  #distDir: string;
  #dirs: string[];
  #workingDir: string;

  constructor(options: NestBuilderOptions = {}) {
    const { workingDir, outDir, dirs, projectRoot, moduleType, distDir } =
      resolveNestBuilderConfig(options);
    super({
      ...createBaseBuilderConfig({
        workingDir,
        projectRoot,
        watch: options.watch ?? false,
        dirs,
        sourcemap: options.sourcemap,
      }),
      // Use 'standalone' as base target - we handle the specific bundling ourselves
      buildTarget: 'standalone',
      stepsBundlePath: join(outDir, 'steps.mjs'),
      workflowsBundlePath: join(outDir, 'workflows.mjs'),
      webhookBundlePath: join(outDir, 'webhook.mjs'),
    });
    this.#outDir = outDir;
    this.#moduleType = moduleType;
    this.#distDir = distDir;
    this.#dirs = dirs;
    this.#workingDir = workingDir;
  }

  get outDir(): string {
    return this.#outDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(this.#outDir, 'steps.mjs'),
      flowOutfile: join(this.#outDir, 'workflows.mjs'),
      format: 'esm',
      bundleFinalOutput: false,
      externalizeNonSteps: true,
    });

    // When the NestJS project compiles to CJS via SWC, the ESM steps bundle
    // can't import named exports from CJS files because cjs-module-lexer
    // doesn't recognize SWC's _export() wrapper pattern.
    // Rewrite externalized .ts imports to use require() via createRequire.
    if (this.#moduleType === 'commonjs') {
      await this.#rewriteStepsBundleForCjs();
    }

    await this.createWebhookBundle({
      outfile: join(this.#outDir, 'webhook.mjs'),
      bundle: false,
    });

    // Generate manifest
    await this.createManifest({
      workflowBundlePath: join(this.#outDir, 'workflows.mjs'),
      manifestDir: this.#outDir,
      manifest,
    });

    // Create .gitignore to exclude generated files
    if (!process.env.VERCEL_DEPLOYMENT_ID) {
      await writeFile(join(this.#outDir, '.gitignore'), '*\n');
    }
  }

  /**
   * Rewrite externalized .ts/.tsx imports in the steps bundle to use require()
   * for CommonJS compatibility.
   *
   * When NestJS compiles to CJS via SWC, the ESM steps bundle can't import
   * named exports from CJS files because cjs-module-lexer doesn't recognize
   * SWC's _export() wrapper pattern. This rewrites the imports to use
   * createRequire() and points them to the compiled .js files in distDir.
   */
  async #rewriteStepsBundleForCjs(): Promise<void> {
    const stepsPath = join(this.#outDir, 'steps.mjs');
    const stepsContent = await readFile(stepsPath, 'utf-8');

    const { content: rewritten, matchCount } = rewriteTsImportsInContent(
      stepsContent,
      {
        outDir: this.#outDir,
        workingDir: this.#workingDir,
        distDir: this.#distDir,
        dirs: this.#dirs,
      }
    );

    if (matchCount === 0) {
      console.warn(
        '[@workflow/nest] No .ts/.tsx imports found to rewrite for CommonJS. ' +
          "If you expected externalized imports, esbuild's output format may have changed."
      );
      return;
    }

    const requireShim = [
      `import { createRequire as __bundled_createRequire } from 'node:module';`,
      `const require = __bundled_createRequire(import.meta.url);`,
      ``,
    ].join('\n');

    await writeFile(stepsPath, requireShim + rewritten);
  }
}

/** @internal */
export function resolveNestBuilderConfig(options: NestBuilderOptions = {}): {
  workingDir: string;
  outDir: string;
  dirs: string[];
  projectRoot: string;
  moduleType: 'es6' | 'commonjs';
  distDir: string;
} {
  const workingDir = options.workingDir ?? process.cwd();
  return {
    workingDir,
    outDir: options.outDir ?? join(workingDir, '.nestjs/workflow'),
    dirs: options.dirs ?? getNestSourceDirs(workingDir),
    projectRoot: options.projectRoot ?? findWorkspaceRoot(workingDir),
    moduleType: options.moduleType ?? getNestModuleType(workingDir),
    distDir: options.distDir ?? getTsConfigOutDir(workingDir),
  };
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNestSourceDirs(workingDir: string): string[] {
  const config = getRecord(readJsonFile(join(workingDir, 'nest-cli.json')));
  return [getString(config?.sourceRoot) ?? 'src'];
}

function getTsConfigCompilerOptions(
  workingDir: string
): Record<string, unknown> {
  const config = getRecord(readJsonFile(join(workingDir, 'tsconfig.json')));
  return getRecord(config?.compilerOptions) ?? {};
}

function getTsConfigOutDir(workingDir: string): string {
  return getString(getTsConfigCompilerOptions(workingDir).outDir) ?? 'dist';
}

function getNestModuleType(workingDir: string): 'es6' | 'commonjs' {
  const swcrc = getRecord(readJsonFile(join(workingDir, '.swcrc')));
  const swcrcModule = getRecord(swcrc?.module);
  return (
    normalizeModuleType(swcrcModule?.type) ??
    normalizeModuleType(getTsConfigCompilerOptions(workingDir).module) ??
    'es6'
  );
}

function normalizeModuleType(
  value: unknown
): 'es6' | 'commonjs' | undefined {
  const normalized = getString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'commonjs') return 'commonjs';
  return 'es6';
}

function findWorkspaceRoot(workingDir: string): string {
  let current = resolve(workingDir);

  while (true) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) ||
      packageJsonHasWorkspaces(join(current, 'package.json'))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return workingDir;
    }
    current = parent;
  }
}

function packageJsonHasWorkspaces(path: string): boolean {
  const packageJson = getRecord(readJsonFile(path));
  return packageJson?.workspaces !== undefined;
}
