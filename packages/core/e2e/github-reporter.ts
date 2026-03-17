/**
 * Custom vitest reporter that emits GitHub Actions annotations for failed tests.
 *
 * When running in CI, failed e2e tests produce `::error` workflow commands that
 * surface as annotations in the GitHub Actions UI and on PR file diffs.
 *
 * Also writes an enriched JSON sidecar file (`e2e-failures-*.json`) with
 * per-test failure details including run IDs and dashboard links, which the
 * aggregation script uses to enrich the PR comment.
 *
 * Usage:
 *   vitest run --reporter=./packages/core/e2e/github-reporter.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import type { File, Reporter, TaskResultPack, Vitest } from 'vitest';

interface FailedTestInfo {
  testName: string;
  fullName: string;
  file: string;
  errorMessage: string;
  // Extracted from console output if diagnostics were dumped
  runId?: string;
  dashboardUrl?: string;
  status?: string;
}

export default class GithubAnnotationReporter implements Reporter {
  private ctx!: Vitest;
  private failedTests: FailedTestInfo[] = [];

  onInit(ctx: Vitest) {
    this.ctx = ctx;
  }

  onTaskUpdate(_packs: TaskResultPack[]) {
    // No-op: we process results in onFinished
  }

  onFinished(files?: File[]) {
    if (!files) return;

    for (const file of files) {
      this.collectFailures(file.tasks, file.filepath);
    }

    if (this.failedTests.length > 0) {
      this.writeFailuresSidecar();
    }
  }

  private collectFailures(tasks: File['tasks'], filepath: string) {
    for (const task of tasks) {
      if (task.type === 'suite' && 'tasks' in task) {
        this.collectFailures(task.tasks, filepath);
        continue;
      }

      if (task.result?.state !== 'fail') continue;

      const errors = task.result.errors || [];
      const errorMessage = errors.map((e) => e.message).join('\n');

      // Try to extract run diagnostics from the test's stderr/stdout
      // The onTestFailed hook in utils.ts writes diagnostics with specific markers
      const diagnosticsMatch = errorMessage.match(/Run ID:\s+(wrun_\S+)/);
      const dashboardMatch = errorMessage.match(/Dashboard:\s+(https:\/\/\S+)/);
      const statusMatch = errorMessage.match(/Status:\s+(\S+)/);

      const info: FailedTestInfo = {
        testName: task.name,
        fullName: this.getFullName(task),
        file: filepath,
        errorMessage: errorMessage.slice(0, 500),
        runId: diagnosticsMatch?.[1],
        dashboardUrl: dashboardMatch?.[1],
        status: statusMatch?.[1],
      };

      this.failedTests.push(info);
    }
  }

  private getFullName(task: any): string {
    const parts: string[] = [task.name];
    let current = task.suite;
    while (current) {
      if (current.name) parts.unshift(current.name);
      current = current.suite;
    }
    return parts.join(' > ');
  }

  private writeFailuresSidecar() {
    const appName = process.env.APP_NAME || 'unknown';
    const isVercel = !!process.env.WORKFLOW_VERCEL_ENV;
    const backend = isVercel ? 'vercel' : 'local';
    const filePath = path.resolve(
      process.cwd(),
      `e2e-failures-${appName}-${backend}.json`
    );

    fs.writeFileSync(filePath, JSON.stringify(this.failedTests, null, 2));
  }
}
