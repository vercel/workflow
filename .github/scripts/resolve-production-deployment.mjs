#!/usr/bin/env node
/**
 * Resolves the READY production deployment of a Vercel project for one exact
 * commit SHA, and writes `deployment-url` / `deployment-id` /
 * `deployment-state` to $GITHUB_OUTPUT so the caller can consume them exactly
 * like `vercel/wait-for-deployment-action`'s outputs.
 *
 * Why this exists: `changeset-release/*` PRs have no deployments of their own
 * (every project's vercel.json sets `git.deploymentEnabled` false for that
 * branch — see the PR that added this script), so those PRs cannot wait for a
 * deployment of their own head SHA. Their content is the base branch plus a
 * version-bump commit, so the e2e lanes instead test the production
 * deployment that the base commit already produced.
 *
 * The lookup is deliberately keyed on the commit SHA rather than "whatever is
 * currently aliased to production": matching by SHA is what makes the result
 * correct rather than merely recent. It waits out a production deploy that is
 * still building, and it refuses to silently fall back to an older deployment
 * built from different code.
 *
 * Required env: VERCEL_TOKEN, VERCEL_TEAM_ID, PROJECT_SLUG, EXPECTED_SHA
 * Optional env: TIMEOUT_SECONDS (default 1000, matching the wait action's
 *               timeout in tests.yml), POLL_INTERVAL_SECONDS (default 15)
 */

import fs from 'node:fs';

const {
  VERCEL_TOKEN: token,
  VERCEL_TEAM_ID: teamId,
  PROJECT_SLUG: projectSlug,
  EXPECTED_SHA: expectedSha,
  TIMEOUT_SECONDS: timeoutSeconds = '1000',
  POLL_INTERVAL_SECONDS: pollIntervalSeconds = '15',
} = process.env;

// One production deployment is created per push to the release branch, so the
// API's maximum page size covers roughly a week of history — deep enough that
// neither pushes landing after the PR event was delivered nor a re-run of an
// older workflow run can bury the deployment we are looking for.
const PAGE_SIZE = 100;
// States a deployment can never leave. Reaching one of these for the expected
// SHA means the production build failed; there is nothing to wait for.
const TERMINAL_FAILURE_STATES = new Set(['ERROR', 'CANCELED', 'DELETED']);

for (const [name, value] of Object.entries({
  VERCEL_TOKEN: token,
  VERCEL_TEAM_ID: teamId,
  PROJECT_SLUG: projectSlug,
  EXPECTED_SHA: expectedSha,
})) {
  if (!value) {
    console.error(`[resolve-prod-deployment] Missing required env ${name}.`);
    process.exit(1);
  }
}

const timeoutMs = Number(timeoutSeconds) * 1000;
const pollIntervalMs = Number(pollIntervalSeconds) * 1000;
const deadline = Date.now() + timeoutMs;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns {string} A deployment's ready state, normalized. */
function stateOf(deployment) {
  return String(deployment.state ?? deployment.readyState ?? '').toUpperCase();
}

/**
 * Lists the most recent production deployments of the project.
 *
 * @returns {Promise<Array<object>>}
 */
async function listProductionDeployments() {
  const url = new URL('https://api.vercel.com/v6/deployments');
  url.searchParams.set('app', projectSlug);
  url.searchParams.set('target', 'production');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('teamId', teamId);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Vercel API returned ${response.status} ${response.statusText}: ${await response
        .text()
        .catch(() => '<no body>')}`
    );
  }
  const body = await response.json();
  return body.deployments ?? [];
}

function writeOutputs(outputs) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const rendered = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  if (outputFile) fs.appendFileSync(outputFile, `${rendered}\n`);
  console.log(`[resolve-prod-deployment] outputs:\n${rendered}`);
}

/** Prints recent deployments so a failure is diagnosable from the log alone. */
function describe(deployments) {
  if (deployments.length === 0) return '  (no production deployments found)';
  return deployments
    .slice(0, 10)
    .map((deployment) => {
      const sha = deployment.meta?.githubCommitSha ?? '<no sha>';
      const created = new Date(deployment.created).toISOString();
      return `  ${stateOf(deployment).padEnd(12)} ${sha}  ${created}  ${deployment.url}`;
    })
    .join('\n');
}

console.log(
  `[resolve-prod-deployment] Looking for a READY production deployment of ` +
    `${projectSlug} built from ${expectedSha}.`
);

let latest = [];
let attempt = 0;
while (true) {
  attempt += 1;
  try {
    latest = await listProductionDeployments();
  } catch (error) {
    // A transient API error should not fail the job while there is still
    // time on the clock; the next poll will retry.
    if (Date.now() >= deadline) {
      console.error(
        `[resolve-prod-deployment] Timed out after ${timeoutSeconds}s; last ` +
          `error from the Vercel API was: ${error.message}`
      );
      process.exit(1);
    }
    console.log(
      `[resolve-prod-deployment] attempt ${attempt}: ${error.message}; ` +
        `retrying in ${pollIntervalSeconds}s.`
    );
    await sleep(pollIntervalMs);
    continue;
  }

  const matching = latest.filter(
    (deployment) => deployment.meta?.githubCommitSha === expectedSha
  );
  const ready = matching.find((deployment) => stateOf(deployment) === 'READY');

  if (ready) {
    console.log(
      `[resolve-prod-deployment] Found ${ready.uid} (${ready.url}) after ${attempt} attempt(s).`
    );
    writeOutputs({
      'deployment-url': `https://${ready.url}`,
      'deployment-id': ready.uid ?? ready.id,
      'deployment-state': 'success',
    });
    break;
  }

  if (
    matching.length > 0 &&
    matching.every((deployment) =>
      TERMINAL_FAILURE_STATES.has(stateOf(deployment))
    )
  ) {
    console.error(
      `[resolve-prod-deployment] The production deployment of ${projectSlug} ` +
        `for ${expectedSha} did not build:\n${describe(matching)}`
    );
    process.exit(1);
  }

  if (Date.now() >= deadline) {
    console.error(
      `[resolve-prod-deployment] Timed out after ${timeoutSeconds}s waiting ` +
        `for a READY production deployment of ${projectSlug} built from ` +
        `${expectedSha}. Most recent production deployments:\n${describe(latest)}`
    );
    process.exit(1);
  }

  const waiting =
    matching.length > 0 ? stateOf(matching[0]) : 'not created yet';
  console.log(
    `[resolve-prod-deployment] attempt ${attempt}: deployment is ${waiting}; ` +
      `polling again in ${pollIntervalSeconds}s.`
  );
  await sleep(pollIntervalMs);
}
