/**
 * Server-side data fetching for the Worlds dashboard
 * Fetches CI test results and benchmarks directly from GitHub API
 */

import { unstable_cache } from 'next/cache';
import type {
  WorldsStatus,
  World,
  WorldE2E,
  WorldBenchmark,
} from '@/components/worlds/types';

// Import manifest data at build time
import worldsManifest from '../../worlds-manifest.json';

const GITHUB_API = 'https://api.github.com';
const OWNER = 'vercel';
const REPO = 'workflow';

interface GitHubWorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string;
  created_at: string;
  updated_at: string;
}

interface GitHubArtifact {
  id: number;
  name: string;
  archive_download_url: string;
  size_in_bytes: number;
  created_at: string;
  expired: boolean;
}

async function fetchGitHub<T>(path: string): Promise<T | null> {
  const url = `${GITHUB_API}${path}`;
  const headers: HeadersInit = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Use GITHUB_TOKEN if available (for higher rate limits)
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, { headers });

    if (!res.ok) {
      console.error(
        `GitHub API error: ${res.status} ${res.statusText} for ${path}`
      );
      return null;
    }

    return res.json();
  } catch (error) {
    console.error('Failed to fetch from GitHub:', error);
    return null;
  }
}

/**
 * Get the latest successful workflow run for Tests workflow on main branch
 */
async function getLatestTestsRun(): Promise<GitHubWorkflowRun | null> {
  const data = await fetchGitHub<{ workflow_runs: GitHubWorkflowRun[] }>(
    `/repos/${OWNER}/${REPO}/actions/workflows/tests.yml/runs?branch=main&status=completed&per_page=1`
  );
  return data?.workflow_runs?.[0] ?? null;
}

/**
 * Get the latest successful workflow run for Benchmarks workflow on main branch
 */
async function getLatestBenchmarksRun(): Promise<GitHubWorkflowRun | null> {
  const data = await fetchGitHub<{ workflow_runs: GitHubWorkflowRun[] }>(
    `/repos/${OWNER}/${REPO}/actions/workflows/benchmarks.yml/runs?branch=main&status=completed&per_page=1`
  );
  return data?.workflow_runs?.[0] ?? null;
}

/**
 * Get artifacts from a workflow run
 */
async function getWorkflowArtifacts(runId: number): Promise<GitHubArtifact[]> {
  const data = await fetchGitHub<{ artifacts: GitHubArtifact[] }>(
    `/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts?per_page=100`
  );
  return data?.artifacts?.filter((a) => !a.expired) ?? [];
}

/**
 * Extract world ID from artifact name
 * Artifact naming conventions:
 * - E2E: e2e-results-{category}-{app} where category maps to world
 *   - vercel-prod → vercel
 *   - local-dev, local-prod → local
 *   - local-postgres → postgres
 *   - community-{world} → {world}
 *   - windows → local (windows tests use local world)
 * - Benchmarks: bench-results-{app}-{world}
 */
function extractWorldId(artifactName: string): string | null {
  // E2E results for community worlds: e2e-results-community-{world}
  if (artifactName.startsWith('e2e-results-community-')) {
    return artifactName.replace('e2e-results-community-', '');
  }

  // E2E results: e2e-results-{category}-{app}
  // Map category to world ID
  if (artifactName.startsWith('e2e-results-')) {
    const rest = artifactName.replace('e2e-results-', '');
    // vercel-prod-{app} → vercel
    if (rest.startsWith('vercel-prod-')) {
      return 'vercel';
    }
    // local-dev-{app} or local-prod-{app} → local
    if (rest.startsWith('local-dev-') || rest.startsWith('local-prod-')) {
      return 'local';
    }
    // local-postgres-{app} → postgres
    if (rest.startsWith('local-postgres-')) {
      return 'postgres';
    }
    // windows-{app} → local (windows tests use local world)
    if (rest.startsWith('windows-')) {
      return 'local';
    }
    return null;
  }

  // Benchmark results: bench-results-{app}-{world}
  if (artifactName.startsWith('bench-results-')) {
    const parts = artifactName.replace('bench-results-', '').split('-');
    return parts[parts.length - 1]; // Last part is the world
  }
  return null;
}

/**
 * Build initial worlds status from manifest (no CI data yet)
 */
function buildInitialWorldsStatus(): Record<string, World> {
  const worlds: Record<string, World> = {};

  for (const world of worldsManifest.worlds) {
    worlds[world.id] = {
      type: world.type as 'official' | 'community',
      name: world.name,
      package: world.package,
      description: world.description,
      docs: world.docs,
      repository: (world as any).repository,
      e2e: null,
      benchmark: null,
    };
  }

  return worlds;
}

/**
 * Get worlds data with CI results
 * Cached for 5 minutes to avoid hitting GitHub rate limits
 */
export const getWorldsData = unstable_cache(
  async (): Promise<WorldsStatus> => {
    const worlds = buildInitialWorldsStatus();
    let lastUpdated = new Date().toISOString();
    let commit: string | null = null;
    let branch: string | null = null;

    try {
      // Get latest test and benchmark runs in parallel
      const [testsRun, benchmarksRun] = await Promise.all([
        getLatestTestsRun(),
        getLatestBenchmarksRun(),
      ]);

      // Use the most recent run's metadata
      const latestRun = testsRun || benchmarksRun;
      if (latestRun) {
        lastUpdated = latestRun.updated_at;
        commit = latestRun.head_sha;
        branch = latestRun.head_branch;
      }

      // Get artifacts from both runs in parallel
      const [testsArtifacts, benchmarksArtifacts] = await Promise.all([
        testsRun ? getWorkflowArtifacts(testsRun.id) : Promise.resolve([]),
        benchmarksRun
          ? getWorkflowArtifacts(benchmarksRun.id)
          : Promise.resolve([]),
      ]);

      // Determine E2E status based on workflow conclusion
      // If workflow succeeded, tests passed. If failed, show partial (we can't tell which world failed)
      const e2eStatus: 'passing' | 'partial' | 'pending' =
        testsRun?.conclusion === 'success'
          ? 'passing'
          : testsRun?.conclusion === 'failure'
            ? 'partial'
            : 'pending';

      // Process E2E test artifacts
      // We can't download the artifact contents without auth, but we can tell
      // which worlds have artifacts (meaning their tests ran)
      for (const artifact of testsArtifacts) {
        const worldId = extractWorldId(artifact.name);
        if (worldId && worlds[worldId]) {
          // Mark as having E2E data available
          // Use workflow conclusion to infer status since we can't parse artifacts
          if (!worlds[worldId].e2e) {
            worlds[worldId].e2e = {
              status: e2eStatus,
              total: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              progress: e2eStatus === 'passing' ? 100 : 0,
              lastRun: artifact.created_at,
            };
          }
        }
      }

      // Determine benchmark status based on workflow conclusion
      const benchStatus: 'measured' | 'pending' =
        benchmarksRun?.conclusion === 'success' ? 'measured' : 'pending';

      // Process benchmark artifacts similarly
      for (const artifact of benchmarksArtifacts) {
        const worldId = extractWorldId(artifact.name);
        if (worldId && worlds[worldId]) {
          if (!worlds[worldId].benchmark) {
            worlds[worldId].benchmark = {
              status: benchStatus,
              metrics: null,
              lastRun: artifact.created_at,
            };
          }
        }
      }
    } catch (error) {
      console.error('Error fetching worlds data from GitHub:', error);
    }

    return {
      $schema: './worlds-status.schema.json',
      lastUpdated,
      commit,
      branch,
      worlds,
    };
  },
  ['worlds-data'],
  { revalidate: 300 } // Cache for 5 minutes
);

/**
 * Get worlds data with full artifact download and parsing
 * This requires GITHUB_TOKEN to be set
 */
export const getWorldsDataWithArtifacts = unstable_cache(
  async (): Promise<WorldsStatus> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.warn(
        'GITHUB_TOKEN not set, returning data without artifact parsing'
      );
      return getWorldsData();
    }

    // For now, return the basic data
    // Full artifact parsing would require JSZip and more complex logic
    return getWorldsData();
  },
  ['worlds-data-full'],
  { revalidate: 300 }
);
