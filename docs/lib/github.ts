/**
 * GitHub API utilities for fetching CI workflow results
 */

const GITHUB_API = 'https://api.github.com';
const OWNER = 'vercel';
const REPO = 'workflow';

// Artifact names we're looking for
const E2E_ARTIFACT_PATTERNS = [
  'e2e-results-local',
  'e2e-results-postgres',
  'e2e-results-vercel',
  'e2e-results-starter',
  'e2e-results-turso',
  'e2e-results-mongodb',
  'e2e-results-redis',
];

const BENCH_ARTIFACT_PATTERNS = [
  'bench-results-nextjs-turbopack-local',
  'bench-results-nextjs-turbopack-postgres',
  'bench-results-nextjs-turbopack-vercel',
  'bench-results-nextjs-turbopack-starter',
  'bench-results-nextjs-turbopack-turso',
  'bench-results-nextjs-turbopack-mongodb',
  'bench-results-nextjs-turbopack-redis',
];

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
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: GitHubWorkflowRun[];
}

interface ArtifactsResponse {
  total_count: number;
  artifacts: GitHubArtifact[];
}

interface E2ETestResult {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    assertionResults: Array<{
      fullName: string;
      status: 'passed' | 'failed' | 'skipped';
      duration?: number;
    }>;
  }>;
}

interface BenchmarkResult {
  files: Array<{
    groups: Array<{
      benchmarks: Array<{
        name: string;
        mean: number;
        min: number;
        max: number;
        sampleCount: number;
      }>;
    }>;
  }>;
}

async function fetchGitHub<T>(
  path: string,
  options?: RequestInit
): Promise<T | null> {
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
    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
      next: { revalidate: 300 }, // Cache for 5 minutes
    });

    if (!res.ok) {
      console.error(`GitHub API error: ${res.status} ${res.statusText}`);
      return null;
    }

    return res.json();
  } catch (error) {
    console.error('Failed to fetch from GitHub:', error);
    return null;
  }
}

/**
 * Get the latest successful workflow run for a specific workflow on main branch
 */
export async function getLatestWorkflowRun(
  workflowFileName: string
): Promise<GitHubWorkflowRun | null> {
  const params = new URLSearchParams({
    branch: 'main',
    status: 'completed',
    per_page: '1',
  });

  const data = await fetchGitHub<WorkflowRunsResponse>(
    `/repos/${OWNER}/${REPO}/actions/workflows/${workflowFileName}/runs?${params}`
  );

  return data?.workflow_runs?.[0] ?? null;
}

/**
 * Get artifacts from a workflow run
 */
export async function getWorkflowArtifacts(
  runId: number
): Promise<GitHubArtifact[]> {
  const data = await fetchGitHub<ArtifactsResponse>(
    `/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts?per_page=100`
  );

  return data?.artifacts ?? [];
}

/**
 * Download and parse an artifact's JSON content
 * Note: This requires authentication for private repos
 */
export async function downloadArtifact<T>(
  artifactId: number
): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set, cannot download artifacts');
    return null;
  }

  try {
    // Get the download URL (this redirects to a blob storage URL)
    const res = await fetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/artifacts/${artifactId}/zip`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        redirect: 'follow',
      }
    );

    if (!res.ok) {
      console.error(`Failed to download artifact: ${res.status}`);
      return null;
    }

    // The response is a ZIP file - we need to extract the JSON
    const JSZip = (await import('jszip')).default;
    const arrayBuffer = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Find and parse the JSON file
    const files = Object.keys(zip.files);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    if (!jsonFile) {
      console.error('No JSON file found in artifact');
      return null;
    }

    const content = await zip.files[jsonFile].async('string');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to download/parse artifact:', error);
    return null;
  }
}

/**
 * Parse E2E results into the WorldE2E format
 */
export function parseE2EResults(results: E2ETestResult | null): {
  status: 'passing' | 'partial' | 'failing' | 'pending';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  progress: number;
  tests?: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration?: number;
  }>;
} | null {
  if (!results) return null;

  const total = results.numTotalTests;
  const passed = results.numPassedTests;
  const failed = results.numFailedTests;
  const skipped = results.numPendingTests;
  const progress = total > 0 ? (passed / total) * 100 : 0;

  let status: 'passing' | 'partial' | 'failing' | 'pending';
  if (passed === total) {
    status = 'passing';
  } else if (passed > 0) {
    status = 'partial';
  } else if (failed > 0) {
    status = 'failing';
  } else {
    status = 'pending';
  }

  // Extract individual test results
  const tests: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration?: number;
  }> = [];
  for (const testFile of results.testResults) {
    for (const assertion of testFile.assertionResults) {
      tests.push({
        name: assertion.fullName,
        status:
          assertion.status === 'pending'
            ? 'skipped'
            : (assertion.status as 'passed' | 'failed'),
        duration: assertion.duration,
      });
    }
  }

  return { status, total, passed, failed, skipped, progress, tests };
}

/**
 * Parse benchmark results into the WorldBenchmark format
 */
export function parseBenchmarkResults(results: BenchmarkResult | null): {
  status: 'measured' | 'pending';
  metrics: Record<
    string,
    { mean: number; min: number; max: number; samples?: number }
  > | null;
} | null {
  if (!results?.files?.[0]?.groups?.[0]?.benchmarks) return null;

  const metrics: Record<
    string,
    { mean: number; min: number; max: number; samples?: number }
  > = {};

  for (const bench of results.files[0].groups[0].benchmarks) {
    metrics[bench.name] = {
      mean: bench.mean,
      min: bench.min,
      max: bench.max,
      samples: bench.sampleCount,
    };
  }

  return {
    status: Object.keys(metrics).length > 0 ? 'measured' : 'pending',
    metrics: Object.keys(metrics).length > 0 ? metrics : null,
  };
}

/**
 * Map artifact name to world ID
 */
export function artifactToWorldId(artifactName: string): string | null {
  // E2E results
  if (artifactName.startsWith('e2e-results-')) {
    return artifactName.replace('e2e-results-', '');
  }
  if (artifactName.startsWith('e2e-dev-results-')) {
    return artifactName.replace('e2e-dev-results-', '');
  }
  // Benchmark results
  if (artifactName.startsWith('bench-results-nextjs-turbopack-')) {
    return artifactName.replace('bench-results-nextjs-turbopack-', '');
  }
  return null;
}

export {
  type GitHubWorkflowRun,
  type GitHubArtifact,
  type E2ETestResult,
  type BenchmarkResult,
  E2E_ARTIFACT_PATTERNS,
  BENCH_ARTIFACT_PATTERNS,
};
