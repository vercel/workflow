// Resolves the Vercel deployment for the commit under test by polling the
// Vercel API. Deployments are matched on project, commit SHA, branch, target
// environment, and `source: git`; the branch filter matters because the same
// SHA can be deployed from several branches, and the `source` filter excludes
// CLI deployments that CI itself creates from a checkout of the same commit.

const fs = require('node:fs');

const PRODUCTION_BRANCH = 'main';
const RELEASE_BRANCH_PREFIX = 'changeset-release/';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function environmentForBranch(branch) {
  return branch === PRODUCTION_BRANCH ? 'production' : 'preview';
}

// Derives which deployment a GitHub event tests.
//
// `changeset-release/*` PRs have no deployment of their own: the branch is
// force-pushed and can point at main's HEAD SHA, so every project's
// vercel.json disables deployments for it. Their content is main plus a
// version bump, so they test the production deployment of their base commit.
function resolveTarget({ eventName, event, githubSha, githubRefName }) {
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pr = event.pull_request;
    if (!pr) {
      throw new Error(`${eventName} event has no pull_request payload`);
    }
    const headRef = requiredString(pr.head?.ref, 'pull_request.head.ref');
    if (headRef.startsWith(RELEASE_BRANCH_PREFIX)) {
      return {
        sha: requiredString(pr.base?.sha, 'pull_request.base.sha'),
        branch: requiredString(pr.base?.ref, 'pull_request.base.ref'),
        environment: 'production',
      };
    }
    return {
      sha: requiredString(pr.head?.sha, 'pull_request.head.sha'),
      branch: headRef,
      environment: 'preview',
    };
  }
  const branch = requiredString(githubRefName, 'GITHUB_REF_NAME');
  return {
    sha: requiredString(githubSha, 'GITHUB_SHA'),
    branch,
    environment: environmentForBranch(branch),
  };
}

function applyOverrides(target, { sha, branch, environment }) {
  const resolved = {
    sha: optionalString(sha) ?? target.sha,
    branch: optionalString(branch) ?? target.branch,
    environment: optionalString(environment) ?? target.environment,
  };
  resolved.sha = resolved.sha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(resolved.sha)) {
    throw new Error(`sha must be a full commit SHA, got "${resolved.sha}"`);
  }
  if (!['production', 'preview'].includes(resolved.environment)) {
    throw new Error(
      `environment must be "production" or "preview", got "${resolved.environment}"`
    );
  }
  return resolved;
}

function deploymentEnvironment(deployment) {
  return deployment.target === 'production' ? 'production' : 'preview';
}

// Redeploys of a Git deployment keep its commit metadata. CLI deployments,
// including the ones CI creates from a checkout of the same commit, are
// excluded: their branch is recorded as `HEAD`.
const DEPLOYMENT_SOURCES = new Set(['git', 'redeploy']);

function createdAt(deployment) {
  return deployment.createdAt ?? deployment.created;
}

function matchesBranch(deployment, target) {
  return (
    DEPLOYMENT_SOURCES.has(deployment.source) &&
    deployment.meta?.githubCommitRef === target.branch &&
    deploymentEnvironment(deployment) === target.environment
  );
}

function newest(deployments) {
  return deployments.sort((a, b) => createdAt(b) - createdAt(a)).at(0);
}

// Returns the newest deployment of the target, or undefined if Vercel has not
// created one yet. A newer deployment supersedes an older one for the same
// commit, e.g. a redeploy after a canceled build.
function selectDeployment(deployments, target) {
  return newest(
    deployments.filter(
      (deployment) =>
        matchesBranch(deployment, target) &&
        deployment.meta?.githubCommitSha?.toLowerCase() === target.sha
    )
  );
}

function deploymentState(deployment) {
  return deployment.readyState ?? deployment.state;
}

// Vercel records a build it chose not to run as a CANCELED deployment: an
// Ignored Build Step sets `buildSkipped`, and skipping an unaffected monorepo
// project links the docs section that explains it.
function isSkipped(details) {
  return (
    details.buildSkipped === true ||
    String(details.errorLink ?? '').includes('#skipping-unaffected-projects')
  );
}

class FatalError extends Error {}

async function vercelGet({ fetchImpl, token, teamId }, path, params = {}) {
  const url = new URL(path, 'https://api.vercel.com');
  url.searchParams.set('teamId', teamId);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`Vercel API returned ${response.status}`);
  }
  if (!response.ok) {
    throw new FatalError(`Vercel API returned ${response.status} for ${path}`);
  }
  return response.json();
}

async function listDeployments(context, params) {
  const body = await vercelGet(context, '/v6/deployments', {
    projectId: context.projectId,
    limit: '100',
    ...params,
  });
  if (!Array.isArray(body.deployments)) {
    throw new Error('Vercel API response has no deployments array');
  }
  return body.deployments;
}

// A skipped build leaves the branch served by its previous deployment, which
// is what the skipped commit would have deployed.
async function findServingDeployment(context, skipped) {
  const { target } = context;
  const deployments = await listDeployments(context, {
    branch: target.branch,
    state: 'READY',
    ...(target.environment === 'production' ? { target: 'production' } : {}),
  });
  return newest(
    deployments.filter(
      (deployment) =>
        matchesBranch(deployment, target) &&
        deploymentState(deployment) === 'READY' &&
        createdAt(deployment) < createdAt(skipped)
    )
  );
}

async function observeDeployment(context) {
  const { target } = context;
  const deployment = selectDeployment(
    await listDeployments(context, { sha: target.sha }),
    target
  );
  if (!deployment) {
    return { state: 'missing' };
  }
  const state = deploymentState(deployment);
  if (state !== 'CANCELED') {
    return { state, deployment };
  }
  const details = await vercelGet(
    context,
    `/v13/deployments/${encodeURIComponent(deployment.uid)}`
  );
  if (!isSkipped(details)) {
    return { state, deployment };
  }
  const serving = await findServingDeployment(context, deployment);
  if (!serving) {
    throw new FatalError(
      `${deployment.uid} was skipped (${details.readyStateReason}) and ${target.branch} has no earlier ready deployment to test`
    );
  }
  return { state: 'SKIPPED', deployment: serving, skipped: deployment };
}

// Returns what the Vercel API currently reports for the target: the newest
// matching deployment and its state, `missing`, or a `transient` failure worth
// retrying. Throws FatalError for failures a retry cannot fix.
async function observe(context) {
  try {
    return await observeDeployment(context);
  } catch (error) {
    if (error instanceof FatalError) {
      throw error;
    }
    return { state: 'transient', message: error.message };
  }
}

function describe(observation) {
  if (observation.state === 'transient') {
    return `Transient error, retrying: ${observation.message}`;
  }
  if (observation.state === 'missing') {
    return 'No matching deployment yet';
  }
  if (observation.state === 'SKIPPED') {
    const { skipped, deployment } = observation;
    return `${skipped.uid} was skipped; testing ${deployment.uid}, the branch's latest ready deployment (${deployment.inspectorUrl})`;
  }
  const { uid, inspectorUrl } = observation.deployment;
  return `${uid} is ${observation.state} (${inspectorUrl})`;
}

function timeoutError(subject, lastState) {
  // A canceled build is waited on rather than failed: a redeploy of the same
  // commit replaces it, and a newer commit cancels this run.
  return new FatalError(
    lastState === 'CANCELED'
      ? `Timed out: the ${subject} was canceled and not redeployed`
      : `Timed out waiting for the ${subject} (last state: ${lastState ?? 'unknown'})`
  );
}

async function waitForDeployment({
  timeoutMs,
  intervalMs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
  fetchImpl = fetch,
  ...context
}) {
  const { target, projectId } = context;
  const deadline = now() + timeoutMs;
  const subject = `${target.environment} deployment of ${target.sha} on ${target.branch} for ${projectId}`;
  log(`Waiting for the ${subject}`);
  let lastState;
  for (;;) {
    const observation = await observe({ ...context, fetchImpl });
    if (observation.state === 'transient' || observation.state !== lastState) {
      log(describe(observation));
    }
    if (observation.state !== 'transient') {
      lastState = observation.state;
    }
    if (observation.state === 'READY' || observation.state === 'SKIPPED') {
      return observation.deployment;
    }
    if (observation.state === 'ERROR') {
      const { uid, inspectorUrl } = observation.deployment;
      throw new FatalError(`${uid} failed to build: ${inspectorUrl}`);
    }
    if (now() + intervalMs > deadline) {
      throw timeoutError(subject, lastState);
    }
    await sleep(intervalMs);
  }
}

function toOutputs(deployment, target) {
  return {
    'deployment-id': deployment.uid,
    'deployment-url': `https://${deployment.url}`,
    'inspector-url': deployment.inspectorUrl ?? '',
    environment: target.environment,
    sha: target.sha,
    branch: target.branch,
  };
}

function positiveSeconds(value, name) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds`);
  }
  return seconds * 1000;
}

async function main(env = process.env, options = {}) {
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const target = applyOverrides(
    resolveTarget({
      eventName: env.GITHUB_EVENT_NAME,
      event,
      githubSha: env.GITHUB_SHA,
      githubRefName: env.GITHUB_REF_NAME,
    }),
    {
      sha: env.INPUT_SHA,
      branch: env.INPUT_BRANCH,
      environment: env.INPUT_ENVIRONMENT,
    }
  );
  const deployment = await waitForDeployment({
    projectId: requiredString(env.INPUT_PROJECT_ID, 'project-id'),
    teamId: requiredString(env.INPUT_TEAM_ID, 'team-id'),
    token: requiredString(env.INPUT_TOKEN, 'token'),
    target,
    timeoutMs: positiveSeconds(env.INPUT_TIMEOUT_SECONDS, 'timeout-seconds'),
    intervalMs: positiveSeconds(env.INPUT_INTERVAL_SECONDS, 'interval-seconds'),
    ...options,
  });
  const outputs = toOutputs(deployment, target);
  const lines = Object.entries(outputs).map(
    ([key, value]) => `${key}=${value}`
  );
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  console.log(lines.join('\n'));
  return outputs;
}

if (require.main === module) {
  main().catch((error) => {
    console.log(
      `::error title=Vercel deployment not resolved::${error.message}`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  FatalError,
  applyOverrides,
  main,
  resolveTarget,
  selectDeployment,
  waitForDeployment,
};
