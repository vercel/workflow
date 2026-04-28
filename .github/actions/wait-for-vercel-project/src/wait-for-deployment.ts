import * as fs from 'node:fs';
import * as core from '@actions/core';

interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  task: string;
  created_at: string;
  updated_at: string;
}

interface GitHubDeploymentStatus {
  state:
    | 'error'
    | 'failure'
    | 'inactive'
    | 'in_progress'
    | 'queued'
    | 'pending'
    | 'success';
  environment: string;
  environment_url?: string;
  target_url?: string;
  log_url?: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface GitHubCombinedStatus {
  state: string;
  statuses: Array<{
    context: string;
    state: string;
    target_url?: string | null;
    description?: string | null;
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ghHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'wait-for-vercel-project',
  };
}

async function ghFetch<T>(
  url: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...ghHeaders(token), ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for ${url}${body ? `\n${body}` : ''}`
    );
  }
  return (await res.json()) as T;
}

function getRepo(): { owner: string; repo: string } {
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull) throw new Error('GITHUB_REPOSITORY env var is not set');
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);
  }
  return { owner, repo };
}

function resolveTargetSha(): string {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const fallbackSha = process.env.GITHUB_SHA;

  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      if (eventName === 'pull_request' && event.pull_request?.head?.sha) {
        return event.pull_request.head.sha as string;
      }
      if (eventName === 'push' && typeof event.after === 'string') {
        return event.after;
      }
    } catch (err) {
      core.warning(
        `Could not read GitHub event payload: ${(err as Error).message}`
      );
    }
  }

  if (!fallbackSha) {
    throw new Error('Could not resolve target commit SHA from event context');
  }
  return fallbackSha;
}

/**
 * Look up the Vercel deployment ID (`dpl_...`) from the commit's combined
 * status. Vercel posts a commit status per project with a context like
 * `Vercel – <project-slug>` and a `target_url` of the form
 * `https://vercel.com/<team>/<project>/<inspectorId>`. The `inspectorId`
 * is the deployment ID without the `dpl_` prefix.
 */
async function resolveDeploymentId(
  owner: string,
  repo: string,
  sha: string,
  projectSlug: string,
  token: string
): Promise<string | null> {
  const status = await ghFetch<GitHubCombinedStatus>(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status?per_page=100`,
    token
  );
  const expectedContext = `Vercel – ${projectSlug}`;
  const match = status.statuses.find((s) => s.context === expectedContext);
  if (!match || !match.target_url) return null;
  // Take the last non-empty path segment.
  let pathname: string;
  try {
    pathname = new URL(match.target_url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter(Boolean);
  const inspectorId = segments[segments.length - 1];
  if (!inspectorId) return null;
  return `dpl_${inspectorId}`;
}

async function run(): Promise<void> {
  try {
    const projectSlug = core.getInput('project-slug', { required: true });
    const environment = (
      core.getInput('environment') || 'preview'
    ).toLowerCase();
    if (environment !== 'production' && environment !== 'preview') {
      throw new Error(
        `environment must be "production" or "preview" (got "${environment}")`
      );
    }
    const timeoutInput = parseInt(core.getInput('timeout') || '600', 10);
    const timeout =
      Number.isFinite(timeoutInput) && timeoutInput > 0 ? timeoutInput : 600;
    const checkIntervalInput = parseInt(
      core.getInput('check-interval') || '10',
      10
    );
    const checkInterval =
      Number.isFinite(checkIntervalInput) && checkIntervalInput > 0
        ? checkIntervalInput
        : 10;
    const githubToken =
      core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    if (!githubToken) {
      throw new Error('github-token input or GITHUB_TOKEN env var is required');
    }

    const { owner, repo } = getRepo();
    const sha = resolveTargetSha();
    const ghEnvName = `${environment === 'production' ? 'Production' : 'Preview'} – ${projectSlug}`;

    core.info(`Repo: ${owner}/${repo}`);
    core.info(`Target SHA: ${sha}`);
    core.info(`Looking for GitHub deployment with environment: "${ghEnvName}"`);
    core.info(`Timeout: ${timeout}s, Check interval: ${checkInterval}s`);

    const deadline = Date.now() + timeout * 1000;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      core.info(`Attempt ${attempt}`);

      // 1. Find the GitHub Deployment for (sha, environment).
      const deploymentsUrl = `https://api.github.com/repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(ghEnvName)}&per_page=1`;
      let deployments: GitHubDeployment[];
      try {
        deployments = await ghFetch<GitHubDeployment[]>(
          deploymentsUrl,
          githubToken
        );
      } catch (err) {
        core.warning(`Failed to list deployments: ${(err as Error).message}`);
        await sleep(checkInterval * 1000);
        continue;
      }
      const deployment = deployments[0];
      if (!deployment) {
        core.info(
          `⏳ No GitHub Deployment yet for SHA ${sha} env "${ghEnvName}"`
        );
        await sleep(checkInterval * 1000);
        continue;
      }

      // 2. Get its latest status.
      let statuses: GitHubDeploymentStatus[];
      try {
        statuses = await ghFetch<GitHubDeploymentStatus[]>(
          `https://api.github.com/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=10`,
          githubToken
        );
      } catch (err) {
        core.warning(
          `Failed to list deployment statuses: ${(err as Error).message}`
        );
        await sleep(checkInterval * 1000);
        continue;
      }
      const latest = statuses[0];
      if (!latest) {
        core.info(
          `⏳ Deployment ${deployment.id} found but has no statuses yet`
        );
        await sleep(checkInterval * 1000);
        continue;
      }
      core.info(
        `Deployment ${deployment.id} state: ${latest.state}${latest.description ? ` (${latest.description})` : ''}`
      );

      if (latest.state === 'failure' || latest.state === 'error') {
        throw new Error(
          `Deployment failed (state=${latest.state})${latest.description ? `: ${latest.description}` : ''}`
        );
      }

      // Treat both `success` and `inactive` as terminal-OK. Vercel emits
      // `inactive` immediately when it skips a build ("Skipped - Not affected"),
      // and the `environment_url` in that status points to the still-live
      // previously-deployed URL.
      const isReady = latest.state === 'success' || latest.state === 'inactive';
      if (!isReady) {
        await sleep(checkInterval * 1000);
        continue;
      }

      const deploymentUrl = latest.environment_url || latest.target_url;
      if (!deploymentUrl) {
        core.warning(
          `Deployment status was "success" but had no environment_url; retrying`
        );
        await sleep(checkInterval * 1000);
        continue;
      }

      // 3. Resolve the Vercel deployment ID from commit statuses.
      // Fail loudly if we can't extract the dpl_xxx ID. Consumers wire
      // this output into VERCEL_DEPLOYMENT_ID, which world-target uses to
      // decide between the Vercel and local worlds (see
      // packages/utils/src/world-target.ts) — an empty value would
      // silently flip execution mode.
      const deploymentId = await resolveDeploymentId(
        owner,
        repo,
        sha,
        projectSlug,
        githubToken
      );
      if (!deploymentId) {
        throw new Error(
          `Deployment became ready at ${deploymentUrl}, but the Vercel deployment ID could not be resolved from the "Vercel – ${projectSlug}" commit status`
        );
      }

      core.info(`✅ Deployment ready: ${deploymentUrl}`);
      core.info(`Deployment ID: ${deploymentId}`);
      core.setOutput('deployment-url', deploymentUrl);
      core.setOutput('deployment-id', deploymentId);
      return;
    }

    throw new Error(
      `Timeout reached after ${timeout}s waiting for deployment to be ready`
    );
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
