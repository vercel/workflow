import { mkdir, writeFile } from 'node:fs/promises';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import { join, relative } from 'pathe';

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
   * @default '.workflow'
   */
  outDir?: string;
  /**
   * Enable watch mode for development
   * @default false
   */
  watch?: boolean;
}

interface WorkflowManifest {
  workflows?: Record<string, Record<string, { workflowId: string }>>;
  steps?: Record<string, Record<string, { stepId: string }>>;
  classes?: Record<string, Record<string, { classId: string }>>;
}

export class NestLocalBuilder extends BaseBuilder {
  #outDir: string;
  #workingDir: string;

  constructor(options: NestBuilderOptions = {}) {
    const workingDir = options.workingDir ?? process.cwd();
    const outDir = options.outDir ?? join(workingDir, '.workflow');
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

    // Generate client exports with workflowId metadata
    await this.createClientExports(manifest);

    // Create .gitignore to exclude generated files
    if (!process.env.VERCEL_DEPLOYMENT_ID) {
      await writeFile(join(this.#outDir, '.gitignore'), '*\n');
    }
  }

  /**
   * Generate client.js and client.d.ts files that export workflow metadata
   * objects. These can be imported and passed to start() without needing
   * SWC transformation of the client code.
   *
   * Generates two types of exports:
   * 1. Flat exports: `export const myWorkflow = { workflowId: '...' }`
   * 2. Per-file exports: `export const byFile = { 'path/to/file.ts': { myWorkflow: {...} } }`
   */
  private async createClientExports(manifest: WorkflowManifest): Promise<void> {
    const workflows = manifest.workflows ?? {};

    // Group workflows by source file for per-file exports
    const byFile: Record<
      string,
      Array<{ name: string; workflowId: string }>
    > = {};

    // Collect flat exports with duplicate handling
    const flatExports: Array<{
      name: string;
      exportName: string;
      workflowId: string;
      sourceFile: string;
    }> = [];

    // Track names to detect duplicates for flat exports
    const nameCount = new Map<string, number>();

    // First pass: count occurrences of each name and group by file
    for (const [filePath, fileWorkflows] of Object.entries(workflows)) {
      const relPath = relative(this.#workingDir, filePath);
      byFile[relPath] = [];

      for (const [name, data] of Object.entries(fileWorkflows)) {
        byFile[relPath].push({ name, workflowId: data.workflowId });
        const safeName = name.replace(/\./g, '_');
        nameCount.set(safeName, (nameCount.get(safeName) ?? 0) + 1);
      }
    }

    // Track used export names to generate unique suffixes for duplicates
    const usedExportNames = new Map<string, number>();

    // Second pass: create flat exports with unique names
    for (const [filePath, fileWorkflows] of Object.entries(workflows)) {
      for (const [name, data] of Object.entries(fileWorkflows)) {
        const safeName = name.replace(/\./g, '_');
        let exportName = safeName;

        // If this name appears multiple times, add a suffix
        if ((nameCount.get(safeName) ?? 0) > 1) {
          const count = usedExportNames.get(safeName) ?? 0;
          exportName = count === 0 ? safeName : `${safeName}_${count}`;
          usedExportNames.set(safeName, count + 1);
        }

        flatExports.push({
          name,
          exportName,
          workflowId: data.workflowId,
          sourceFile: relative(this.#workingDir, filePath),
        });
      }
    }

    if (flatExports.length === 0) {
      console.log('No workflows found, skipping client exports');
      return;
    }

    // Generate client.js
    const jsLines = [
      '// Auto-generated by @workflow/nest - DO NOT EDIT',
      '// Import these workflow metadata objects and pass them to start()',
      '//',
      '// Example usage:',
      "//   import { myWorkflow } from './.workflow/client.js';",
      "//   import { start } from 'workflow/api';",
      '//   await start(myWorkflow, [args]);',
      '',
      '// === Flat exports (for simple imports) ===',
      '',
    ];

    for (const { exportName, workflowId, sourceFile } of flatExports) {
      jsLines.push(`// From: ${sourceFile}`);
      jsLines.push(
        `export const ${exportName} = { workflowId: '${workflowId}' };`
      );
      jsLines.push('');
    }

    // Generate per-file exports for workbench compatibility
    jsLines.push('// === Per-file exports (for workbench compatibility) ===');
    jsLines.push('');
    jsLines.push('export const byFile = {');

    for (const [relPath, fileWorkflows] of Object.entries(byFile)) {
      jsLines.push(`  '${relPath}': {`);
      for (const { name, workflowId } of fileWorkflows) {
        // Use quoted key to preserve dots in names like "Calculator.calculate"
        jsLines.push(`    '${name}': { workflowId: '${workflowId}' },`);
      }
      jsLines.push('  },');
    }

    jsLines.push('};');
    jsLines.push('');

    await writeFile(join(this.#outDir, 'client.js'), jsLines.join('\n'));

    // Generate client.d.ts for TypeScript support
    const dtsLines = [
      '// Auto-generated by @workflow/nest - DO NOT EDIT',
      '',
      'interface WorkflowMetadata {',
      '  workflowId: string;',
      '}',
      '',
      '// === Flat exports ===',
      '',
    ];

    for (const { exportName, sourceFile } of flatExports) {
      dtsLines.push(`/** Workflow from: ${sourceFile} */`);
      dtsLines.push(`export declare const ${exportName}: WorkflowMetadata;`);
      dtsLines.push('');
    }

    // Add byFile type declaration
    dtsLines.push('// === Per-file exports ===');
    dtsLines.push('');
    dtsLines.push(
      'export declare const byFile: Record<string, Record<string, WorkflowMetadata>>;'
    );
    dtsLines.push('');

    await writeFile(join(this.#outDir, 'client.d.ts'), dtsLines.join('\n'));

    console.log(
      `Generated client exports for ${flatExports.length} workflow(s)`
    );
  }
}
