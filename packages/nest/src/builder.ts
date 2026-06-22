import { mkdir, writeFile, readFile } from 'node:fs/promises';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  type DiscoveredEntries,
} from '@workflow/builders';
import { join } from 'pathe';
import { rewriteTsImportsInContent } from './cjs-rewrite.js';

/**
 * SDK packages that exist purely to build/integrate workflows and never ship
 * runtime step/workflow/serde sources. Workflow discovery follows imports out
 * of `workflow/nest` (imported by the app's module) into these packages, where
 * files like `@workflow/builders`' `serde-checker` match the serde heuristic.
 *
 * The Nest steps bundle externalizes non-step code into an ESM bundle that
 * Node loads directly, so any such file's transitive `node_modules` imports
 * surface as bare runtime imports. `@workflow/builders/serde-checker`, for
 * example, pulls in `builtin-modules` (a JSON module) whose externalized
 * `import` has no `with { type: 'json' }` attribute and crashes the step
 * handler at runtime. Dropping these build-time packages from the discovered
 * set keeps them out of the runtime bundle entirely.
 *
 * Runtime SDK packages that legitimately export steps/classes (`@workflow/ai`,
 * `workflow`/`@workflow/core` stdlib, `@workflow/serde`) are intentionally
 * absent here.
 */
const BUILD_TOOLING_PACKAGES = [
  'builders',
  'swc-plugin-workflow',
  'cli',
  'typescript-plugin',
  'next',
  'nest',
  'nitro',
  'vite',
  'rollup',
  'sveltekit',
  'vitest',
];

/**
 * Matches a file that lives inside one of the build-tooling packages, in both
 * the monorepo workspace form (`/packages/<name>/`) and the installed form
 * (`/@workflow/<name>/`, which also covers pnpm's
 * `.pnpm/@workflow+<name>@x/node_modules/@workflow/<name>/`).
 */
const buildToolingPathPattern = new RegExp(
  `(?:/packages/|/@workflow/)(?:${BUILD_TOOLING_PACKAGES.join('|')})/`
);

export interface NestBuilderOptions {
  /**
   * Working directory for the NestJS application
   * @default process.cwd()
   */
  workingDir?: string;
  /**
   * Directories to scan for workflow files
   * @default ['src']
   */
  dirs?: string[];
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
   * @default 'es6'
   */
  moduleType?: 'es6' | 'commonjs';
  /**
   * Directory where NestJS compiles .ts source files to .js (relative to workingDir).
   * Used when moduleType is 'commonjs' to resolve compiled file paths.
   * This should match the `outDir` in your tsconfig.json.
   * @default 'dist'
   */
  distDir?: string;
}

export class NestLocalBuilder extends BaseBuilder {
  #outDir: string;
  #moduleType: 'es6' | 'commonjs';
  #distDir: string;
  #dirs: string[];
  #workingDir: string;

  constructor(options: NestBuilderOptions = {}) {
    const workingDir = options.workingDir ?? process.cwd();
    const outDir = options.outDir ?? join(workingDir, '.nestjs/workflow');
    const dirs = options.dirs ?? ['src'];
    super({
      ...createBaseBuilderConfig({
        workingDir,
        watch: options.watch ?? false,
        dirs,
      }),
      // Use 'standalone' as base target - we handle the specific bundling ourselves
      buildTarget: 'standalone',
      stepsBundlePath: join(outDir, 'steps.mjs'),
      workflowsBundlePath: join(outDir, 'workflows.mjs'),
      webhookBundlePath: join(outDir, 'webhook.mjs'),
    });
    this.#outDir = outDir;
    this.#moduleType = options.moduleType ?? 'es6';
    this.#distDir = options.distDir ?? 'dist';
    this.#dirs = dirs;
    this.#workingDir = workingDir;
  }

  get outDir(): string {
    return this.#outDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    // Discover once and strip SDK build-tooling files before bundling, so they
    // never reach the externalized ESM steps bundle (see
    // BUILD_TOOLING_PACKAGES). Both bundle calls reuse this filtered set rather
    // than re-running discovery.
    const discoveredEntries = this.#filterBuildTooling(
      await this.discoverEntries(inputFiles, this.#outDir)
    );

    const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.mjs'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
      discoveredEntries,
    });

    const { manifest: stepsManifest } = await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
      discoveredEntries,
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

    // Merge manifests from both bundles
    const manifest = {
      steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
      workflows: { ...stepsManifest.workflows, ...workflowsManifest.workflows },
      classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
    };

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
   * Removes SDK build-tooling files (see BUILD_TOOLING_PACKAGES) from the
   * discovered entries so they are never bundled into the runtime steps/
   * workflows output.
   */
  #filterBuildTooling(discovered: DiscoveredEntries): DiscoveredEntries {
    const keep = (file: string): boolean => !buildToolingPathPattern.test(file);
    return {
      discoveredSteps: new Set([...discovered.discoveredSteps].filter(keep)),
      discoveredWorkflows: new Set(
        [...discovered.discoveredWorkflows].filter(keep)
      ),
      discoveredSerdeFiles: new Set(
        [...discovered.discoveredSerdeFiles].filter(keep)
      ),
    };
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
