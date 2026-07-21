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
  /**
   * All run IDs found in the failure output. Tests that assert over a
   * batch of runs (e.g. the multi-region all-regions case) aggregate
   * several failures — each with its own `Run ID:` marker — into one
   * error message; the runtime-log capture wants every one of them.
   */
  runIds?: string[];
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
  private failedTests: FailedTestInfo[] = [];

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    for (const module of testModules) {
      this.collectFailures(module);
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

  private collectFailures(module: TestModule) {
    for (const test of module.children.allTests()) {
      const result = test.result();
      if (result.state !== 'failed') continue;

      const errors = result.errors || [];
      const errorMessage = errors
        .map((e) => e.message || e.stack || 'Unknown error')
        .join('\n');

      // Try to extract run diagnostics from error output.
      // The onTestFailed hook in utils.ts writes diagnostics with specific
      // markers, and assertion messages may embed the same `Run ID:` form.
      // Extract from the FULL message (before truncation below) so batch
      // failures spanning many runs keep every ID.
      const runIds = [
        ...new Set(
          [...errorMessage.matchAll(/Run ID:\s+(wrun_\S+)/g)].map((m) => m[1])
        ),
      ];
      const dashboardMatch = errorMessage.match(/Dashboard:\s+(https:\/\/\S+)/);
      const statusMatch = errorMessage.match(/Status:\s+(\S+)/);

      this.failedTests.push({
        testName: test.name,
        fullName: test.fullName,
        file: module.moduleId,
        errorMessage: errorMessage.slice(0, 500),
        runId: runIds[0],
        runIds: runIds.length > 0 ? runIds : undefined,
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
        test.runIds ??= [diag.runId];
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
      // 300 chars keeps region-mismatch messages (run ID + x-vercel-id
      // proxy request ID) intact in the annotation.
      const parts = [test.errorMessage.split('\n')[0].slice(0, 300)];
      const runIds = test.runIds ?? (test.runId ? [test.runId] : []);
      if (runIds.length === 1) {
        parts.push(`Run: ${runIds[0]}`);
      } else if (runIds.length > 1) {
        const shown = runIds.slice(0, 3).join(', ');
        const more = runIds.length - 3;
        parts.push(`Runs: ${shown}${more > 0 ? ` (+${more} more)` : ''}`);
      }
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
}
