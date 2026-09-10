/**
 * Custom vitest reporter that emits GitHub Actions annotations for failed tests.
 *
 * When running in CI, failed e2e tests produce `::error` workflow commands that
 * surface as annotations in the GitHub Actions UI and on PR file diffs. Tests
 * that only passed after a retry (see `retry` in vitest.config.ts) produce
 * `::warning` annotations and a `e2e-flaky-*.json` sidecar, so the retry that
 * keeps a racy test from failing the job does not also hide the race.
 *
 * Also writes an enriched JSON sidecar file (`e2e-failures-*.json`) with
 * per-test failure details including run IDs and dashboard links, which the
 * aggregation script uses to enrich the PR comment.
 *
 * The sidecar carries the actual error message (`error.message`), which is
 * important for test timeouts: vitest's built-in JSON reporter serializes only
 * error stacks, and for timeouts the stack is the task-collection stack
 * (`Error: STACK_TRACE_ERROR ...`) that contains no failure information.
 *
 * Usage:
 *   vitest run --reporter=./packages/core/e2e/github-reporter.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';

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

interface FlakyTestInfo {
  testName: string;
  fullName: string;
  file: string;
  retryCount: number;
}

export default class GithubAnnotationReporter implements Reporter {
  private failedTests: FailedTestInfo[] = [];
  private flakyTests: FlakyTestInfo[] = [];

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    for (const module of testModules) {
      this.collectFailures(module);
    }

    if (this.failedTests.length > 0) {
      // Enrich failures with diagnostics sidecar data (run IDs, dashboard URLs)
      this.enrichFromDiagnosticsSidecar();
      this.writeFailuresSidecar();
    }

    if (this.flakyTests.length > 0) {
      this.writeFlakySidecar();
    }

    // Emit GitHub Actions annotations — this runs after vitest's own
    // output is done, so ::error commands won't be mangled by ANSI codes.
    if (process.env.CI) {
      this.emitAnnotations();
    }
  }

  private collectFailures(module: TestModule) {
    for (const test of module.children.allTests()) {
      const result = test.result();

      if (result.state === 'passed') {
        const retryCount = test.diagnostic()?.retryCount ?? 0;
        if (retryCount > 0) {
          this.flakyTests.push({
            testName: test.name,
            fullName: test.fullName,
            file: module.moduleId,
            retryCount,
          });
        }
        continue;
      }

      if (result.state !== 'failed') continue;

      const errors = result.errors || [];
      const errorMessage = errors
        .map((e) => e.message || e.stack || 'Unknown error')
        .join('\n');

      // Try to extract run diagnostics from error output.
      // The onTestFailed hook in utils.ts writes diagnostics with specific markers.
      const diagnosticsMatch = errorMessage.match(/Run ID:\s+(wrun_\S+)/);
      const dashboardMatch = errorMessage.match(/Dashboard:\s+(https:\/\/\S+)/);
      const statusMatch = errorMessage.match(/Status:\s+(\S+)/);

      this.failedTests.push({
        testName: test.name,
        fullName: test.fullName,
        file: module.moduleId,
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
    for (const test of this.flakyTests) {
      const title = `E2E flaky: ${test.testName}`;
      const body = `Passed only after ${test.retryCount} retr${
        test.retryCount === 1 ? 'y' : 'ies'
      } — this test lost a race on its first attempt.`;
      const relFile = path.relative(process.cwd(), test.file);
      process.stdout.write(
        `\n::warning file=${relFile},title=${title}::${body}\n`
      );
    }

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

  private writeFlakySidecar() {
    const appName = process.env.APP_NAME || 'unknown';
    const isVercel = !!process.env.WORKFLOW_VERCEL_ENV;
    const backend = isVercel ? 'vercel' : 'local';
    const filePath = path.resolve(
      process.cwd(),
      `e2e-flaky-${appName}-${backend}.json`
    );

    fs.writeFileSync(filePath, JSON.stringify(this.flakyTests, null, 2));
  }
}
