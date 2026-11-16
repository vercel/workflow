import type * as TS from 'typescript';
import type { FileReport } from './report-types.js';

export interface FrameworkTransformOptions<Context> {
  ts: typeof TS;
  sourceFile: TS.SourceFile;
  checker: TS.TypeChecker;
  /** File name for the report (usually relative to the project root). */
  reportName: string;
  /** What `prepare()` collected across the project. */
  context: Context;
}

/**
 * One source framework the `workflow migrate` command can migrate from.
 * The shared engine in `project.ts` finds the files, runs `transform()` on
 * each against the project's own TypeScript program, then types and
 * validates the generated annotations and refuses output that does not parse.
 */
export interface MigrationFramework<Context = unknown> {
  /** The `workflow migrate <id>` argument. */
  id: string;
  /** Display name, e.g. "Inngest". */
  label: string;
  /** Quick text filter: only files that can contain this framework's code. */
  mightUse(text: string): boolean;
  /** Collect project-wide facts (e.g. client names) before any transform. */
  prepare?(ts: typeof TS, program: TS.Program, files: string[]): Context;
  transform(options: FrameworkTransformOptions<Context>): {
    code: string;
    report: FileReport;
  };
  /** Markdown report for `--report`. */
  renderMarkdown(
    reports: FileReport[],
    failed: Array<{ file: string; error: string }>
  ): string;
  /** One line telling the user what to replace at the app boundary. */
  boundaryHint: string;
}
