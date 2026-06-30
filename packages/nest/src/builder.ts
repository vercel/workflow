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
   */
  moduleType?: 'es6' | 'commonjs';
  /**
   * Directory where NestJS compiles .ts source files to .js (relative to workingDir).
   * Used when moduleType is 'commonjs' to resolve compiled file paths.
   * This should match the `outDir` in your tsconfig.json.
   * @default tsconfig compilerOptions.outDir or 'dist'
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

type NestCliConfig = { sourceRoot?: unknown };
type SwcConfig = { module?: { type?: unknown } };
type TsConfig = { compilerOptions?: { module?: unknown; outDir?: unknown } };

/** @internal */
export function resolveNestBuilderConfig(options: NestBuilderOptions = {}): {
  workingDir: string;
  outDir: string;
  dirs: string[];
  projectRoot: string;
  moduleType: 'es6' | 'commonjs';
  distDir: string;
} {
  const workingDir = resolve(options.workingDir ?? process.cwd());
  const nestCli = readJsonIfExists<NestCliConfig>(
    join(workingDir, 'nest-cli.json')
  );
  const swcrc = readJsonIfExists<SwcConfig>(join(workingDir, '.swcrc'));
  const tsconfig = readJsonIfExists<TsConfig>(
    join(workingDir, 'tsconfig.json')
  );
  const moduleType =
    options.moduleType ??
    readModuleType(readString(swcrc?.module?.type, '.swcrc module.type')) ??
    readModuleType(
      readString(tsconfig?.compilerOptions?.module, 'tsconfig module')
    ) ??
    'es6';

  return {
    workingDir,
    outDir: options.outDir ?? join(workingDir, '.nestjs/workflow'),
    dirs: options.dirs ?? [
      readString(nestCli?.sourceRoot, 'nest-cli sourceRoot') ?? 'src',
    ],
    projectRoot: options.projectRoot ?? findPnpmWorkspaceRoot(workingDir),
    moduleType,
    distDir:
      options.distDir ??
      readString(tsconfig?.compilerOptions?.outDir, 'tsconfig outDir') ??
      'dist',
  };
}

function readJsonIfExists<T extends object>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;

  const value = JSON.parse(readFileSync(path, 'utf-8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }
  return value as T;
}

function readString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Expected ${name} to be a string.`);
  }
  return value;
}

function readModuleType(
  value: string | undefined
): 'es6' | 'commonjs' | undefined {
  switch (value?.toLowerCase()) {
    case undefined:
      return undefined;
    case 'commonjs':
      return 'commonjs';
    case 'es6':
    case 'es2015':
    case 'es2020':
    case 'es2022':
    case 'esnext':
    case 'node16':
    case 'node18':
    case 'node20':
    case 'nodenext':
    case 'preserve':
      return 'es6';
    default:
      throw new Error(`Unsupported Nest module type: ${value}`);
  }
}

function findPnpmWorkspaceRoot(workingDir: string): string {
  let current = resolve(workingDir);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return workingDir;
    }
    current = parent;
  }
}
