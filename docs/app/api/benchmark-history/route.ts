import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const GITHUB_API = 'https://api.github.com';
const REPO = 'vercel/workflow';
const FILE_PATH = 'ci/benchmark-results.json';
const MAX_ITEMS = 30;

/**
 * Look up a metric in a world's data, trying the current name first,
 * then falling back to legacy names.
 *
 * Before beta.53, concurrent step benchmarks used a "stress test: " prefix
 * (e.g. "stress test: Promise.all with 100 concurrent steps"). This helper
 * transparently resolves the old name so history charts stay continuous.
 */
function findMetric(
  worldData: CIResultsData['worlds'][string] | undefined,
  metricName: string
) {
  const metric = worldData?.metrics?.[metricName];
  if (metric) return metric;

  // Try legacy "stress test: " prefix for concurrent step benchmarks
  const legacyName = `stress test: ${metricName}`;
  const legacyMetric = worldData?.metrics?.[legacyName];
  if (legacyMetric) return legacyMetric;

  return undefined;
}

interface BenchmarkHistoryPoint {
  label: string; // commit sha or version number
  commit: string;
  timestamp: string;
  mean: number;
  min: number;
  max: number;
  samples?: number;
  workflowTime?: number;
  workflowMin?: number;
  workflowMax?: number;
  ttfb?: number;
  slurp?: number;
}

interface CIResultsData {
  lastUpdated: string;
  commit: string | null;
  branch: string | null;
  type: string;
  worlds: Record<
    string,
    {
      status: string;
      metrics?: Record<
        string,
        {
          mean: number;
          min: number;
          max: number;
          samples?: number;
          workflowTime?: number;
          workflowMin?: number;
          workflowMax?: number;
          ttfb?: number;
          slurp?: number;
        }
      >;
    }
  >;
}

interface GitHubTag {
  name: string;
  commit: {
    sha: string;
  };
}

interface GitHubCommit {
  sha: string;
  commit: {
    committer: {
      date: string;
    };
    message: string;
  };
}

interface BenchmarkSnapshot {
  ghPagesSha: string;
  mainCommitSha: string;
  timestamp: string;
  data: CIResultsData;
}

// Fetch and parse a benchmark file from gh-pages
async function fetchBenchmarkFile(
  ghPagesSha: string
): Promise<CIResultsData | null> {
  try {
    const fileRes = await fetch(
      `https://raw.githubusercontent.com/${REPO}/${ghPagesSha}/${FILE_PATH}`,
      { next: { revalidate: 3600 } }
    );

    if (!fileRes.ok) {
      // 404 is expected for commits without benchmark data
      if (fileRes.status !== 404) {
        console.error(
          `Failed to fetch benchmark file for ${ghPagesSha}: ${fileRes.status}`
        );
      }
      return null;
    }

    return (await fileRes.json()) as CIResultsData;
  } catch (error) {
    console.error(
      `Error fetching/parsing benchmark file for ${ghPagesSha}:`,
      error
    );
    return null;
  }
}

/**
 * Parse GitHub's Link header to extract the "next" page URL.
 */
function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

const githubHeaders = () => ({
  Accept: 'application/vnd.github.v3+json',
  ...(process.env.GITHUB_TOKEN && {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
  }),
});

// Build a map of main commit SHA -> benchmark data by reading gh-pages history
async function buildBenchmarkSnapshotMap(): Promise<
  Map<string, BenchmarkSnapshot>
> {
  const snapshotMap = new Map<string, BenchmarkSnapshot>();

  // Paginate through all gh-pages commits that modified the benchmark file
  let ghPagesCommits: GitHubCommit[] = [];
  let url: string | null =
    `${GITHUB_API}/repos/${REPO}/commits?sha=gh-pages&path=${FILE_PATH}&per_page=100`;

  while (url) {
    const res = await fetch(url, {
      headers: githubHeaders(),
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      console.error(`Failed to fetch gh-pages commits: ${res.status}`);
      break;
    }

    try {
      const page = (await res.json()) as GitHubCommit[];
      ghPagesCommits = ghPagesCommits.concat(page);
    } catch (error) {
      console.error('Failed to parse gh-pages commits JSON:', error);
      break;
    }

    url = getNextPageUrl(res.headers.get('Link'));
  }

  // Fetch benchmark data for each gh-pages commit in batches
  const BATCH_SIZE = 10;
  for (let i = 0; i < ghPagesCommits.length; i += BATCH_SIZE) {
    const batch = ghPagesCommits.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (ghCommit) => {
        const data = await fetchBenchmarkFile(ghCommit.sha);
        if (!data || !data.commit) return null;

        return {
          ghPagesSha: ghCommit.sha,
          mainCommitSha: data.commit,
          timestamp: data.lastUpdated,
          data,
        };
      })
    );

    for (const result of results) {
      if (result && !snapshotMap.has(result.mainCommitSha)) {
        // Only keep the first (most recent) benchmark for each main commit
        snapshotMap.set(result.mainCommitSha, result);
      }
    }
  }

  return snapshotMap;
}

async function fetchCommitsHistory(
  worldId: string,
  metricName: string
): Promise<BenchmarkHistoryPoint[]> {
  // Build the snapshot map (main commit SHA -> benchmark data)
  const snapshotMap = await buildBenchmarkSnapshotMap();

  if (snapshotMap.size === 0) {
    return [];
  }

  // Paginate through main branch commits until we have enough data points.
  // Not every commit has benchmark data, so we need to look further back.
  const historyPoints: BenchmarkHistoryPoint[] = [];
  let mainUrl: string | null =
    `${GITHUB_API}/repos/${REPO}/commits?sha=main&per_page=100`;

  while (mainUrl && historyPoints.length < MAX_ITEMS) {
    const mainCommitsRes = await fetch(mainUrl, {
      headers: githubHeaders(),
      next: { revalidate: 300 },
    });

    if (!mainCommitsRes.ok) {
      console.error(`Failed to fetch main commits: ${mainCommitsRes.status}`);
      break;
    }

    const mainCommits = (await mainCommitsRes.json()) as GitHubCommit[];

    for (const mainCommit of mainCommits) {
      if (historyPoints.length >= MAX_ITEMS) break;

      const snapshot = snapshotMap.get(mainCommit.sha);
      if (!snapshot) continue;

      const worldData = snapshot.data.worlds[worldId];
      const metric = findMetric(worldData, metricName);
      if (!metric) continue;

      historyPoints.push({
        label: mainCommit.sha.slice(0, 7),
        commit: mainCommit.sha.slice(0, 7),
        timestamp: mainCommit.commit.committer.date,
        mean: metric.mean,
        min: metric.min,
        max: metric.max,
        samples: metric.samples,
        workflowTime: metric.workflowTime,
        workflowMin: metric.workflowMin,
        workflowMax: metric.workflowMax,
        ttfb: metric.ttfb,
        slurp: metric.slurp,
      });
    }

    mainUrl = getNextPageUrl(mainCommitsRes.headers.get('Link'));
  }

  return historyPoints;
}

async function fetchReleasesHistory(
  worldId: string,
  metricName: string
): Promise<BenchmarkHistoryPoint[]> {
  // Build the snapshot map (main commit SHA -> benchmark data)
  const snapshotMap = await buildBenchmarkSnapshotMap();

  if (snapshotMap.size === 0) {
    return [];
  }

  // Paginate through all tags to find workflow@ releases
  let workflowTags: GitHubTag[] = [];
  let tagsUrl: string | null = `${GITHUB_API}/repos/${REPO}/tags?per_page=100`;

  while (tagsUrl) {
    const tagsRes = await fetch(tagsUrl, {
      headers: githubHeaders(),
      next: { revalidate: 300 },
    });

    if (!tagsRes.ok) {
      console.error(`Failed to fetch tags: ${tagsRes.status}`);
      break;
    }

    const pageTags = (await tagsRes.json()) as GitHubTag[];
    workflowTags = workflowTags.concat(
      pageTags.filter((tag) => tag.name.startsWith('workflow@'))
    );

    tagsUrl = getNextPageUrl(tagsRes.headers.get('Link'));
  }

  if (workflowTags.length === 0) {
    return [];
  }

  // Get commit details for tags to get timestamps
  const historyPoints: BenchmarkHistoryPoint[] = [];

  for (const tag of workflowTags) {
    if (historyPoints.length >= MAX_ITEMS) break;

    // Check if we have benchmark data for this tag's commit
    const snapshot = snapshotMap.get(tag.commit.sha);
    if (!snapshot) continue;

    const worldData = snapshot.data.worlds[worldId];
    const metric = findMetric(worldData, metricName);
    if (!metric) continue;

    // Get timestamp for the tag
    try {
      const commitRes = await fetch(
        `${GITHUB_API}/repos/${REPO}/commits/${tag.commit.sha}`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN && {
              Authorization: `token ${process.env.GITHUB_TOKEN}`,
            }),
          },
          next: { revalidate: 3600 },
        }
      );

      if (!commitRes.ok) continue;

      const commitData = (await commitRes.json()) as GitHubCommit;
      const version = tag.name.replace('workflow@', '');

      historyPoints.push({
        label: version,
        commit: tag.commit.sha.slice(0, 7),
        timestamp: commitData.commit.committer.date,
        mean: metric.mean,
        min: metric.min,
        max: metric.max,
        samples: metric.samples,
        workflowTime: metric.workflowTime,
        workflowMin: metric.workflowMin,
        workflowMax: metric.workflowMax,
        ttfb: metric.ttfb,
        slurp: metric.slurp,
      });
    } catch {
      continue;
    }
  }

  return historyPoints;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const worldId = searchParams.get('worldId');
  const metricName = searchParams.get('metricName');
  const mode = searchParams.get('mode') || 'releases'; // 'commits' or 'releases'

  if (!worldId || !metricName) {
    return NextResponse.json(
      { error: 'Missing worldId or metricName parameter' },
      { status: 400 }
    );
  }

  try {
    const historyPoints =
      mode === 'commits'
        ? await fetchCommitsHistory(worldId, metricName)
        : await fetchReleasesHistory(worldId, metricName);

    // Sort by timestamp (oldest first for chart display)
    const sorted = historyPoints.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return NextResponse.json(sorted, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('Error fetching benchmark history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch benchmark history' },
      { status: 500 }
    );
  }
}
