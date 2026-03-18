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
  runId?: string;
  dashboardUrl?: string;
  status?: string;
}

interface DiagnosticsEntry {
  testName: string;
  runId: string;
  dashboardUrl?: string;
  timestamp: string;
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
      // Enrich failures with diagnostics sidecar data (run IDs, dashboard URLs)
      this.enrichFromDiagnosticsSidecar();
      this.writeFailuresSidecar();

      // Emit GitHub Actions annotations — this runs after vitest's own
      // output is done, so ::error commands won't be mangled by ANSI codes.
      if (process.env.CI) {
        this.emitAnnotations();
      }
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

      // Try to extract run diagnostics from error output.
      // The onTestFailed hook in utils.ts writes diagnostics with specific markers.
      const diagnosticsMatch = errorMessage.match(/Run ID:\s+(wrun_\S+)/);
      const dashboardMatch = errorMessage.match(/Dashboard:\s+(https:\/\/\S+)/);
      const statusMatch = errorMessage.match(/Status:\s+(\S+)/);

      this.failedTests.push({
        testName: task.name,
        fullName: this.getFullName(task),
        file: filepath,
        errorMessage: errorMessage.slice(0, 500),
        runId: diagnosticsMatch?.[1],
        dashboardUrl: dashboardMatch?.[1],
        status: statusMatch?.[1],
      });
    }
  }

  /**
   * Try to read the diagnostics sidecar file written by writeDiagnosticsSidecar()
   * in the test's afterAll hook. This has run ID → test name mappings with
   * dashboard URLs that we can use to enrich failure info.
   */
  private enrichFromDiagnosticsSidecar() {
    const appName = process.env.APP_NAME || 'unknown';
    const isVercel = !!process.env.WORKFLOW_VERCEL_ENV;
    const backend = isVercel ? 'vercel' : 'local';
    const sidecarPath = path.resolve(
      process.cwd(),
      `e2e-diagnostics-${appName}-${backend}.json`
    );

    let entries: DiagnosticsEntry[];
    try {
      entries = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    } catch {
      return; // Sidecar not written yet or unreadable
    }

    const byTestName = new Map(entries.map((e) => [e.testName, e]));

    for (const test of this.failedTests) {
      if (test.runId && test.dashboardUrl) continue; // Already have data from error output
      const diag = byTestName.get(test.testName);
      if (diag) {
        test.runId ??= diag.runId;
        test.dashboardUrl ??= diag.dashboardUrl ?? undefined;
      }
    }
  }

  /**
   * Emit ::error workflow commands that GitHub Actions renders as annotations
   * on the PR "Files changed" tab and in the job summary.
   *
   * We link annotations to the e2e test file (which exists in the repo)
   * rather than the workflow source file (which may be a symlink).
   */
  private emitAnnotations() {
    for (const test of this.failedTests) {
      const parts = [test.errorMessage.split('\n')[0].slice(0, 150)];
      if (test.runId) parts.push(`Run: ${test.runId}`);
      if (test.status) parts.push(`Status: ${test.status}`);
      if (test.dashboardUrl) parts.push(test.dashboardUrl);
      const body = parts.join(' | ');

      const title = `E2E: ${test.testName}`;
      // Use relative path to the test file so GitHub can link the annotation
      // to the correct file in the "Files changed" tab.
      const relFile = path.relative(process.cwd(), test.file);
      process.stdout.write(
        `\n::error file=${relFile},title=${title}::${body}\n`
      );
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
