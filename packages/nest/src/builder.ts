import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import { join } from 'pathe';
import { rewriteTsImportsInContent } from './cjs-rewrite.js';

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

    const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.mjs'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
    });

    const { manifest: stepsManifest } = await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
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
