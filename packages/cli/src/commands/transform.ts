import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import {
  analyzeSerdeCompliance,
  applySwcTransform,
  detectWorkflowPatterns,
} from '@workflow/builders';
import chalk from 'chalk';
import { BaseCommand } from '../base.js';

type TransformMode = 'workflow' | 'step';

const ALL_MODES: TransformMode[] = ['workflow', 'step'];

export default class Transform extends BaseCommand {
  static description =
    'Show SWC transform output for a workflow file. Useful for inspecting what code runs in each execution context.';

  static examples = [
    '$ workflow transform src/MyClass.ts',
    '$ workflow transform src/MyClass.ts --mode workflow',
    '$ workflow transform src/MyClass.ts --mode step',
    '$ workflow transform src/MyClass.ts --check-serde',
    '$ workflow transform src/MyClass.ts --json',
  ];

  static args = {
    file: Args.string({
      description: 'The file to transform',
      required: true,
    }),
  };

  static flags = {
    mode: Flags.string({
      char: 'm',
      description: 'Transform mode (workflow, step, or all)',
      default: 'all',
      options: ['workflow', 'step', 'all'],
    }),
    'check-serde': Flags.boolean({
      description: 'Run serde compliance analysis on the transformed output',
      default: false,
    }),
  };

  public async run(): Promise<Record<string, unknown>> {
    const { args, flags } = await this.parse(Transform);
    const filePath = resolve(args.file);
    const relPath = relative(process.cwd(), filePath);

    let source: string;
    try {
      source = await readFile(filePath, 'utf-8');
    } catch {
      this.error(`Could not read file: ${filePath}`);
    }

    // Detect if this file has workflow patterns
    const patterns = detectWorkflowPatterns(source);
    if (!patterns.hasDirective && !patterns.hasSerde) {
      this.logInfo(
        chalk.yellow(
          `Warning: ${relPath} does not contain "use workflow", "use step", or serde patterns.`
        )
      );
    }

    const modes: TransformMode[] =
      flags.mode === 'all' ? ALL_MODES : [flags.mode as TransformMode];

    const results: Record<string, { code: string; error?: string }> = {};

    for (const mode of modes) {
      try {
        const { code } = await applySwcTransform(
          relPath,
          source,
          mode,
          filePath
        );
        results[mode] = { code };
      } catch (err) {
        results[mode] = {
          code: '',
          error: err instanceof Error ? err.message : 'Transform failed',
        };
      }
    }

    // Serde analysis
    let serdeAnalysis = null;
    if (flags['check-serde'] || patterns.hasSerde) {
      // Ensure we have workflow mode output for serde analysis
      let workflowCode = results.workflow?.code;
      let workflowManifest = null;

      if (!workflowCode) {
        try {
          const result = await applySwcTransform(
            relPath,
            source,
            'workflow',
            filePath
          );
          workflowCode = result.code;
          workflowManifest = result.workflowManifest;
        } catch {
          workflowCode = '';
        }
      } else {
        // Re-run to get the manifest
        try {
          const result = await applySwcTransform(
            relPath,
            source,
            'workflow',
            filePath
          );
          workflowManifest = result.workflowManifest;
        } catch {
          // ignore
        }
      }

      if (workflowCode && workflowManifest) {
        serdeAnalysis = analyzeSerdeCompliance({
          sourceCode: source,
          workflowCode,
          manifest: workflowManifest,
        });
      }
    }

    // JSON output
    if (flags.json) {
      return {
        file: relPath,
        patterns: {
          hasUseWorkflow: patterns.hasUseWorkflow,
          hasUseStep: patterns.hasUseStep,
          hasSerde: patterns.hasSerde,
        },
        transforms: results,
        ...(serdeAnalysis
          ? {
              serdeAnalysis: {
                hasSerdeClasses: serdeAnalysis.hasSerdeClasses,
                globalNodeImports: serdeAnalysis.globalNodeImports,
                classes: serdeAnalysis.classes,
              },
            }
          : {}),
      };
    }

    // Human-readable output
    for (const mode of modes) {
      const result = results[mode];
      this.logInfo('');
      this.logInfo(chalk.bold.cyan(`═══ ${mode.toUpperCase()} MODE ═══`));
      if (result.error) {
        this.logInfo(chalk.red(`Error: ${result.error}`));
      } else {
        this.logInfo(result.code);
      }
    }

    // Serde analysis output
    if (serdeAnalysis) {
      this.logInfo('');
      this.logInfo(chalk.bold.cyan('═══ SERDE ANALYSIS ═══'));

      if (
        !serdeAnalysis.hasSerdeClasses &&
        serdeAnalysis.classes.length === 0
      ) {
        this.logInfo(chalk.gray('No serde-enabled classes detected.'));
      } else {
        for (const cls of serdeAnalysis.classes) {
          this.logInfo('');
          this.logInfo(
            cls.compliant
              ? chalk.green(`✓ Class "${cls.className}" is serde-compliant`)
              : chalk.red(`✗ Class "${cls.className}" is NOT serde-compliant`)
          );

          if (cls.classId) {
            this.logInfo(chalk.gray(`  classId: ${cls.classId}`));
          }
          this.logInfo(
            `  Detected by SWC: ${cls.detected ? chalk.green('yes') : chalk.red('no')}`
          );
          this.logInfo(
            `  Registration IIFE: ${cls.registered ? chalk.green('yes') : chalk.red('no')}`
          );

          if (cls.nodeImports.length > 0) {
            this.logInfo(
              chalk.yellow(
                `  Node.js imports in workflow bundle: ${cls.nodeImports.join(', ')}`
              )
            );
          }

          for (const issue of cls.issues) {
            this.logInfo(chalk.yellow(`  ⚠ ${issue}`));
          }
        }

        if (serdeAnalysis.globalNodeImports.length > 0) {
          this.logInfo('');
          this.logInfo(
            chalk.yellow(
              `Node.js built-in imports found in workflow output: ${serdeAnalysis.globalNodeImports.join(', ')}`
            )
          );
          this.logInfo(
            chalk.yellow(
              'Add "use step" to methods that depend on these modules.'
            )
          );
        }
      }
    }

    return {};
  }
}
