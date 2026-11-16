import type { FileReport } from './report-types.js';

export interface ReportSummary {
  filesChanged: number;
  functions: number;
  steps: number;
  hooks: number;
  todos: number;
}

export function summarize(reports: FileReport[]): ReportSummary {
  const summary: ReportSummary = {
    filesChanged: 0,
    functions: 0,
    steps: 0,
    hooks: 0,
    todos: 0,
  };
  for (const report of reports) {
    if (report.changed) summary.filesChanged++;
    summary.functions += report.functions.length;
    summary.steps += report.steps?.length ?? 0;
    summary.todos += report.notes.filter((n) => n.severity === 'todo').length;
    for (const fn of report.functions) {
      summary.steps += fn.steps.length;
      summary.hooks += fn.hooks.length;
      summary.todos += fn.notes.filter((n) => n.severity === 'todo').length;
    }
  }
  return summary;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
