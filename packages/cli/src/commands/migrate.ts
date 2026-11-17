import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../base.js';
import {
  findTsconfig,
  loadTypeScript,
  migrateProject,
  resolveFiles,
} from '../lib/migrate/inngest/project.js';
import {
  plural,
  renderMarkdown,
  summarize,
} from '../lib/migrate/inngest/report.js';
import { TODO_TAG } from '../lib/migrate/inngest/transform.js';

export default class Migrate extends BaseCommand {
  static description =
    'Migrate code from another durable-execution framework to the Workflow SDK. Supports Inngest: functions become "use workflow" functions, and each step.run() closure is lifted into a "use step" function that takes the variables it captured as arguments.';

  static examples = [
    '$ workflow migrate inngest',
    '$ workflow migrate inngest src/inngest',
    '$ workflow migrate inngest --dry-run',
    '$ workflow migrate inngest --report inngest-migration.md',
  ];

  static strict = false;

  static args = {
    from: Args.string({
      description: 'The framework to migrate from',
      required: true,
      options: ['inngest'],
    }),
    paths: Args.string({
      description:
        'Files or directories to migrate. Defaults to the files in the project tsconfig, or the current directory.',
      required: false,
    }),
  } as const;

  static flags = {
    'dry-run': Flags.boolean({
      description: 'Report what would change without writing any files',
      default: false,
    }),
    report: Flags.string({
      description: 'Write a Markdown migration report to this file',
    }),
    tsconfig: Flags.string({
      description:
        'tsconfig.json to read the project files and compiler options from',
    }),
    force: Flags.boolean({
      description: 'Write files even if they have uncommitted changes',
      default: false,
    }),
  };

  // BaseCommand.finally() exits the process before oclif prints a returned
  // JSON result or a thrown error, so this command prints both itself.
  public async run(): Promise<void> {
    try {
      await this.migrate();
    } catch (error) {
      this.logToStderr(
        chalk.red(error instanceof Error ? error.message : String(error))
      );
      process.exitCode = 1;
    }
  }

  private async migrate(): Promise<void> {
    const { args, argv, flags } = await this.parse(Migrate);
    const cwd = process.cwd();
    const paths = argv.slice(argv.indexOf(args.from) + 1).map(String);

    const ts = loadTypeScript(cwd);
    const tsconfig = flags.tsconfig
      ? resolve(cwd, flags.tsconfig)
      : findTsconfig(ts, cwd);
    const files = await resolveFiles(ts, cwd, paths, tsconfig);
    const result = migrateProject({ ts, cwd, files, tsconfig });
    const summary = summarize(result.reports);

    const changed = [...result.outputs.keys()];
    if (!flags['dry-run'] && !flags.force && changed.length) {
      const dirty = uncommitted(cwd, changed);
      if (dirty.length) {
        throw new Error(
          `These files have uncommitted changes:\n${dirty.map((f) => `  ${f}`).join('\n')}\nCommit or stash them first so the codemod's changes are easy to review, or pass --force.`
        );
      }
    }
    if (!flags['dry-run']) {
      for (const [file, code] of result.outputs) await writeFile(file, code);
    }

    const markdown = renderMarkdown(result.reports, result.failed);
    if (flags.report) await writeFile(resolve(cwd, flags.report), markdown);

    if (!this.jsonEnabled())
      this.print(result, summary, Boolean(flags['dry-run']), flags.report);

    if (this.jsonEnabled()) {
      // this.log() is silenced under --json.
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun: Boolean(flags['dry-run']),
            tsconfig: tsconfig ? relative(cwd, tsconfig) : null,
            summary,
            files: result.reports,
            failed: result.failed,
          },
          null,
          2
        )}\n`
      );
    }
    if (result.failed.length) process.exitCode = 1;
  }

  private print(
    result: ReturnType<typeof migrateProject>,
    summary: ReturnType<typeof summarize>,
    dryRun: boolean,
    reportPath: string | undefined
  ): void {
    if (!result.reports.length) {
      this.log('No Inngest functions found.');
      return;
    }
    for (const report of result.reports) {
      if (
        !report.functions.length &&
        !report.notes.length &&
        !report.boundary.length
      )
        continue;
      this.log(chalk.bold(report.file));
      for (const fn of report.functions) {
        this.log(
          `  ${chalk.cyan(fn.workflowName)}${fn.inngestId ? chalk.dim(` (was ${fn.inngestId})`) : ''}`
        );
        for (const step of fn.steps) {
          const captured = step.captured.length
            ? `captures ${step.captured.map((c) => c.name).join(', ')}`
            : 'captures nothing';
          this.log(
            `    ${chalk.green('step')} ${step.stepId} -> ${step.functionName}() ${chalk.dim(captured)}`
          );
        }
        for (const hook of fn.hooks) {
          this.log(
            `    ${chalk.green('hook')} ${hook.name} -> token ${hook.token}`
          );
        }
        const todos = fn.notes.filter((n) => n.severity === 'todo');
        for (const todo of todos) {
          this.log(
            `    ${chalk.yellow('todo')} line ${todo.line}: ${todo.message}`
          );
        }
      }
      for (const note of report.notes.filter((n) => n.severity === 'todo')) {
        this.log(
          `  ${chalk.yellow('todo')} line ${note.line}: ${note.message}`
        );
      }
      for (const call of report.boundary) {
        this.log(
          `  ${chalk.magenta(call.kind)} line ${call.line}: ${call.text}`
        );
      }
    }
    for (const { file, error } of result.failed) {
      this.log(
        chalk.red(
          `Not written: ${file} (the migrated code did not parse: ${error})`
        )
      );
    }
    this.log('');
    this.log(
      `${dryRun ? 'Would change' : 'Changed'} ${plural(summary.filesChanged, 'file')}: ${plural(summary.functions, 'workflow')}, ${plural(summary.steps, 'step')}, ${plural(summary.hooks, 'hook')}, ${plural(summary.todos, 'TODO')}.`
    );
    if (summary.todos)
      this.log(`Search for ${TODO_TAG} to find what needs a decision.`);
    this.log(
      reportPath
        ? `Report written to ${reportPath}.`
        : 'Pass --report <file> for a Markdown report with suggested replacements for inngest.send() calls.'
    );
  }
}

/** Files among `files` with uncommitted changes, or [] outside a git repo. */
function uncommitted(cwd: string, files: string[]): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', ...files], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}
