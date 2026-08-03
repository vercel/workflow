#!/usr/bin/env node
/**
 * Fetches Vercel runtime request logs relevant to a failed e2e lane and
 * writes them to a JSON sidecar that CI uploads as an artifact. Intended to
 * run only when the e2e test step failed.
 *
 * Runtime logs are the missing piece when triaging e2e flakes: the test
 * harness captures workflow run state and event timelines, but not what the
 * deployed functions actually logged (cold starts, crashes, stderr). This
 * uses the same request-logs API as `vercel logs` (one entry per request,
 * with log messages, status code, and — for workflow routes — the
 * workflowRunId attached), so failed tests can be correlated to server-side
 * behavior directly from the artifact.
 *
 * The deployment is shared with concurrent CI runs and a test window can
 * span tens of thousands of request rows, so instead of a bulk dump this
 * makes targeted queries:
 *   1. all rows with error/fatal-level log lines in the test window, and
 *   2. all rows belonging to each failed test's workflow run ID (from the
 *      github-reporter failures sidecar).
 *
 * Required env: WORKFLOW_VERCEL_AUTH_TOKEN, WORKFLOW_VERCEL_TEAM,
 *               WORKFLOW_VERCEL_PROJECT, VERCEL_DEPLOYMENT_ID, APP_NAME
 * Optional env: E2E_START_MS (window start; defaults to 90 minutes ago),
 *               E2E_END_MS (window end; defaults to now — useful for
 *               re-fetching a historical window when triaging locally),
 *               WORKFLOW_VERCEL_ENV (production | preview)
 */

import fs from 'node:fs';
import path from 'node:path';

const API_URL = 'https://vercel.com/api/logs/request-logs';
// Each page returns up to 50 rows; rows come newest-first, so hitting a cap
// drops the oldest rows. Caps bound artifact size and API load.
const MAX_PAGES_PER_QUERY = 40;
// Cap per-row console output; the full data is in the JSON artifact.
const MAX_PRINTED_ROWS = 60;

const {
  WORKFLOW_VERCEL_AUTH_TOKEN: token,
  WORKFLOW_VERCEL_TEAM: teamId,
  WORKFLOW_VERCEL_PROJECT: projectId,
  VERCEL_DEPLOYMENT_ID: deploymentId,
  WORKFLOW_VERCEL_ENV: environment,
  APP_NAME: appName,
  E2E_START_MS: e2eStartMs,
  E2E_END_MS: e2eEndMs,
} = process.env;

if (!token || !teamId || !projectId || !deploymentId || !appName) {
  console.log(
    '[runtime-logs] Missing required env (token/team/project/deployment/app); skipping capture.'
  );
  process.exit(0);
}

// Small buffer before the recorded start so requests already in flight when
// the test step began are included.
const startDate = e2eStartMs
  ? Number(e2eStartMs) - 2 * 60 * 1000
  : Date.now() - 90 * 60 * 1000;
const endDate = e2eEndMs ? Number(e2eEndMs) : Date.now() + 60 * 1000;

/** Read failed-test run IDs from the github-reporter failures sidecar, if present. */
function readFailedRunIds() {
  const failedRunIds = new Map(); // runId -> testName
  const failuresPath = path.resolve(
    process.cwd(),
    `e2e-failures-${appName}-vercel.json`
  );
  try {
    const failures = JSON.parse(fs.readFileSync(failuresPath, 'utf-8'));
    for (const failure of failures) {
      if (failure.runId) failedRunIds.set(failure.runId, failure.testName);
    }
  } catch {
    // Sidecar absent (no failures, or reporter didn't run) — fine.
  }
  return failedRunIds;
}

async function fetchPage(extraParams, page) {
  const url = new URL(API_URL);
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('ownerId', teamId);
  url.searchParams.set('deploymentId', deploymentId);
  url.searchParams.set('startDate', String(startDate));
  url.searchParams.set('endDate', String(endDate));
  url.searchParams.set('page', String(page));
  if (environment) url.searchParams.set('environment', environment);
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `request-logs API returned ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }
  return response.json();
}

async function fetchAllPages(label, extraParams) {
  const rows = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
    let data;
    try {
      data = await fetchPage(extraParams, page);
    } catch (error) {
      console.log(
        `[runtime-logs] ${label}: fetch failed on page ${page}: ${error}`
      );
      break;
    }
    rows.push(...(data.rows || []));
    if (!data.hasMoreRows) break;
    if (page === MAX_PAGES_PER_QUERY - 1) truncated = true;
  }
  if (truncated) {
    console.log(
      `[runtime-logs] WARNING: ${label} hit the ${MAX_PAGES_PER_QUERY}-page cap; older rows were dropped.`
    );
  }
  return rows;
}

async function main() {
  console.log(
    `[runtime-logs] Capturing logs for ${deploymentId} (${new Date(startDate).toISOString()} → ${new Date(endDate).toISOString()})`
  );

  const failedRunIds = readFailedRunIds();
  const rowsByRequestId = new Map();
  const addRows = (rows) => {
    for (const row of rows) {
      rowsByRequestId.set(
        row.requestId ?? `${row.timestamp}-${rowsByRequestId.size}`,
        row
      );
    }
  };

  // 1. Everything that logged at error/fatal level in the window — catches
  //    crashes and failures not attributable to a tracked workflow run.
  addRows(await fetchAllPages('error sweep', { level: 'error,fatal' }));

  // 2. Every request belonging to a failed test's workflow run.
  for (const [runId, testName] of failedRunIds) {
    const rows = await fetchAllPages(`run ${runId}`, { search: runId });
    console.log(
      `[runtime-logs] ${runId} (${testName}): ${rows.length} request(s)`
    );
    addRows(rows);
  }

  const rows = [...rowsByRequestId.values()].sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp))
  );

  const outPath = path.resolve(
    process.cwd(),
    `e2e-runtime-logs-${appName}-vercel.json`
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        deploymentId,
        projectId,
        environment,
        window: {
          start: new Date(startDate).toISOString(),
          end: new Date(endDate).toISOString(),
        },
        failedRunIds: Object.fromEntries(failedRunIds),
        rows,
      },
      null,
      2
    )
  );
  console.log(`[runtime-logs] Wrote ${rows.length} rows to ${outPath}`);

  // Console summary so the most important signals are visible in the job log
  // without downloading the artifact.
  let printed = 0;
  let suppressed = 0;
  for (const row of rows) {
    if (printed >= MAX_PRINTED_ROWS) {
      suppressed++;
      continue;
    }
    printed++;

    const isFailedRun =
      row.workflowRunId && failedRunIds.has(row.workflowRunId);
    const marker = isFailedRun
      ? `failed-test run ${row.workflowRunId} (${failedRunIds.get(row.workflowRunId)})`
      : row.workflowRunId || 'no run id';
    console.log(
      `[runtime-logs] ${row.timestamp} ${row.requestMethod} ${row.requestPath} → ${row.statusCode} [${marker}]`
    );
    for (const log of row.logs || []) {
      console.log(
        `    [${log.level}] ${(log.message || '').split('\n')[0].slice(0, 300)}`
      );
    }
  }
  if (suppressed > 0) {
    console.log(
      `[runtime-logs] ...and ${suppressed} more rows — see the e2e-runtime-logs artifact.`
    );
  }
}

main().catch((error) => {
  // Diagnostics capture must never turn a red job into a different red job.
  console.log(`[runtime-logs] Capture failed: ${error}`);
  process.exit(0);
});
