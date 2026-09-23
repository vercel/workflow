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

// Returns the newest deployment of the target, or undefined if Vercel has not
// created one yet. A newer deployment supersedes an older one for the same
// commit, e.g. a redeploy after a canceled build.
function selectDeployment(deployments, target) {
  return deployments
    .filter(
      (deployment) =>
        deployment.source === 'git' &&
        deployment.meta?.githubCommitSha?.toLowerCase() === target.sha &&
        deployment.meta?.githubCommitRef === target.branch &&
        deploymentEnvironment(deployment) === target.environment
    )
    .sort((a, b) => (b.createdAt ?? b.created) - (a.createdAt ?? a.created))
    .at(0);
}

function deploymentState(deployment) {
  return deployment.readyState ?? deployment.state;
}

class FatalError extends Error {}

async function listDeployments({ fetchImpl, token, teamId, projectId, sha }) {
  const url = new URL('https://api.vercel.com/v6/deployments');
  url.searchParams.set('teamId', teamId);
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('sha', sha);
  url.searchParams.set('limit', '100');
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`Vercel API returned ${response.status}`);
  }
  if (!response.ok) {
    throw new FatalError(
      `Vercel API returned ${response.status} listing deployments for ${projectId}`
    );
  }
  const body = await response.json();
  if (!Array.isArray(body.deployments)) {
    throw new Error('Vercel API response has no deployments array');
  }
  return body.deployments;
}

// Returns what the Vercel API currently reports for the target: the newest
// matching deployment and its state, `missing`, or a `transient` failure worth
// retrying. Throws FatalError for failures a retry cannot fix.
async function observe({ fetchImpl, token, teamId, projectId, target }) {
  let deployments;
  try {
    deployments = await listDeployments({
      fetchImpl,
      token,
      teamId,
      projectId,
      sha: target.sha,
    });
  } catch (error) {
    if (error instanceof FatalError) {
      throw error;
    }
    return { state: 'transient', message: error.message };
  }
  const deployment = selectDeployment(deployments, target);
  return deployment
    ? { state: deploymentState(deployment), deployment }
    : { state: 'missing' };
}

function describe(observation) {
  if (observation.state === 'transient') {
    return `Transient error, retrying: ${observation.message}`;
  }
  if (observation.state === 'missing') {
    return 'No matching deployment yet';
  }
  const { uid, inspectorUrl } = observation.deployment;
  return `${uid} is ${observation.state} (${inspectorUrl})`;
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
    if (observation.state === 'READY') {
      return observation.deployment;
    }
    if (observation.state === 'ERROR') {
      const { uid, inspectorUrl } = observation.deployment;
      throw new FatalError(`${uid} failed to build: ${inspectorUrl}`);
    }
    if (now() + intervalMs > deadline) {
      // A canceled build is waited on rather than failed: a redeploy of the
      // same commit replaces it, and a newer commit cancels this run.
      throw new FatalError(
        lastState === 'CANCELED'
          ? `Timed out: the ${subject} was canceled and not redeployed`
          : `Timed out waiting for the ${subject} (last state: ${lastState ?? 'unknown'})`
      );
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
