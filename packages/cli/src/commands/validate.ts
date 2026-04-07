import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Flags } from '@oclif/core';
import {
  analyzeSerdeCompliance,
  applySwcTransform,
  detectWorkflowPatterns,
  type SerdeClassCheckResult,
} from '@workflow/builders';
import chalk from 'chalk';
import { glob } from 'tinyglobby';
import { BaseCommand } from '../base.js';

/**
 * Parse a .gitignore file into glob-compatible ignore patterns.
 * Returns an empty array if the file doesn't exist.
 */
async function loadGitignorePatterns(dir: string): Promise<string[]> {
  try {
    const content = await readFile(join(dir, '.gitignore'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

interface FileValidationResult {
  file: string;
  hasUseWorkflow: boolean;
  hasUseStep: boolean;
  hasSerde: boolean;
  serdeClasses: SerdeClassCheckResult[];
  errors: string[];
}

export default class Validate extends BaseCommand {
  static description =
    'Validate workflow files for correctness, including serde compliance checks';

  static examples = [
    '$ workflow validate',
    '$ workflow validate --dir src/workflows',
    '$ workflow validate --strict',
    '$ workflow validate --json',
  ];

  static flags = {
    strict: Flags.boolean({
      description: 'exit with code 1 if any validation issues are found',
    }),
    dir: Flags.string({
      char: 'd',
      description: 'directory to validate',
      default: '.',
    }),
  };

  public async run(): Promise<Record<string, unknown>> {
    const { flags } = await this.parse(Validate);
    const targetDir = resolve(flags.dir);

    // Build ignore list from .gitignore (if present) plus baseline patterns
    const gitignorePatterns = await loadGitignorePatterns(targetDir);
    const ignore = [
      ...gitignorePatterns,
      // Always exclude these regardless of .gitignore
      '**/node_modules/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.d.ts',
    ];

    // Find all TS/JS files in the target directory
    const files = await glob(
      ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.cts'],
      {
        cwd: targetDir,
        ignore,
      }
    );

    const results: FileValidationResult[] = [];
    let totalIssues = 0;
    let filesScanned = 0;
    let filesWithWorkflowPatterns = 0;

    for (const file of files) {
      const absPath = resolve(targetDir, file);
      const relPath = relative(process.cwd(), absPath);

      let source: string;
      try {
        source = await readFile(absPath, 'utf-8');
      } catch {
        continue;
      }

      filesScanned++;
      const patterns = detectWorkflowPatterns(source);

      if (!patterns.hasDirective && !patterns.hasSerde) {
        continue;
      }

      filesWithWorkflowPatterns++;
      const fileResult: FileValidationResult = {
        file: relPath,
        hasUseWorkflow: patterns.hasUseWorkflow,
        hasUseStep: patterns.hasUseStep,
        hasSerde: patterns.hasSerde,
        serdeClasses: [],
        errors: [],
      };

      // Run SWC transform in workflow mode to check serde compliance
      if (patterns.hasSerde) {
        try {
          const { code, workflowManifest } = await applySwcTransform(
            relPath,
            source,
            'workflow',
            absPath
          );

          const serdeResult = analyzeSerdeCompliance({
            sourceCode: source,
            workflowCode: code,
            manifest: workflowManifest,
          });

          fileResult.serdeClasses = serdeResult.classes;

          for (const cls of serdeResult.classes) {
            if (!cls.compliant) {
              totalIssues += cls.issues.length;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transform failed';
          fileResult.errors.push(`SWC transform failed: ${msg}`);
          totalIssues++;
        }
      }

      // Only include files with issues or serde classes in results
      if (fileResult.serdeClasses.length > 0 || fileResult.errors.length > 0) {
        results.push(fileResult);
      }
    }

    // JSON output
    if (flags.json) {
      const output = {
        filesScanned,
        filesWithWorkflowPatterns,
        totalIssues,
        results: results.map((r) => ({
          file: r.file,
          hasUseWorkflow: r.hasUseWorkflow,
          hasUseStep: r.hasUseStep,
          hasSerde: r.hasSerde,
          serdeClasses: r.serdeClasses,
          errors: r.errors,
        })),
      };

      if (flags.strict && totalIssues > 0) {
        process.exitCode = 1;
      }

      return output;
    }

    // Human-readable output
    this.logInfo(
      chalk.bold(
        `Scanned ${filesScanned} files, ${filesWithWorkflowPatterns} with workflow patterns`
      )
    );
    this.logInfo('');

    if (results.length === 0) {
      this.logInfo(chalk.green('No serde issues found.'));
      return {};
    }

    for (const result of results) {
      this.logInfo(chalk.bold(result.file));

      // Show errors
      for (const error of result.errors) {
        this.logInfo(chalk.red(`  ✗ ${error}`));
      }

      // Show serde class results
      for (const cls of result.serdeClasses) {
        if (cls.compliant) {
          this.logInfo(
            chalk.green(`  ✓ Class "${cls.className}" is serde-compliant`)
          );
        } else {
          this.logInfo(
            chalk.red(`  ✗ Class "${cls.className}" has serde issues:`)
          );
          for (const issue of cls.issues) {
            this.logInfo(chalk.yellow(`    ⚠ ${issue}`));
          }
        }
      }

      this.logInfo('');
    }

    // Summary
    if (totalIssues > 0) {
      this.logInfo(
        chalk.red(
          `Found ${totalIssues} issue${totalIssues === 1 ? '' : 's'} across ${results.length} file${results.length === 1 ? '' : 's'}.`
        )
      );
    } else {
      this.logInfo(chalk.green('All serde classes are compliant.'));
    }

    if (flags.strict && totalIssues > 0) {
      process.exitCode = 1;
    }

    return {};
  }
}
