import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import { join } from 'pathe';

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
}

export class NestLocalBuilder extends BaseBuilder {
  #outDir: string;
  #moduleType: 'es6' | 'commonjs';

  constructor(options: NestBuilderOptions = {}) {
    const workingDir = options.workingDir ?? process.cwd();
    const outDir = options.outDir ?? join(workingDir, '.nestjs/workflow');
    super({
      ...createBaseBuilderConfig({
        workingDir,
        watch: options.watch ?? false,
        dirs: options.dirs ?? ['src'],
      }),
      // Use 'standalone' as base target - we handle the specific bundling ourselves
      buildTarget: 'standalone',
      stepsBundlePath: join(outDir, 'steps.mjs'),
      workflowsBundlePath: join(outDir, 'workflows.mjs'),
      webhookBundlePath: join(outDir, 'webhook.mjs'),
    });
    this.#outDir = outDir;
    this.#moduleType = options.moduleType ?? 'es6';
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
      const stepsPath = join(this.#outDir, 'steps.mjs');
      const stepsContent = await readFile(stepsPath, 'utf-8');
      const hasExternalized = /\.\.\/\.\.\/src\/.*?\.ts/.test(stepsContent);
      if (hasExternalized) {
        const requireShim = [
          `import { createRequire as __bundled_createRequire } from 'node:module';`,
          `const require = __bundled_createRequire(import.meta.url);`,
          ``,
        ].join('\n');
        const rewritten = stepsContent.replace(
          /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/\.\.\/src\/([^"']+)\.ts["']\s*;?/g,
          (_match, imports, path) => {
            const cjsImports = imports.replace(/\s+as\s+/g, ': ');
            return `const {${cjsImports}} = require("../../dist/${path}.js");`;
          }
        );
        await writeFile(stepsPath, requireShim + rewritten);
      }
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
}
