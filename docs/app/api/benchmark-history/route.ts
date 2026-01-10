import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const GITHUB_API = 'https://api.github.com';
const REPO = 'vercel/workflow';
const FILE_PATH = 'ci/benchmark-results.json';
const MAX_ITEMS = 30;

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

    if (!fileRes.ok) return null;

    return (await fileRes.json()) as CIResultsData;
  } catch {
    return null;
  }
}

// Build a map of main commit SHA -> benchmark data by reading gh-pages history
async function buildBenchmarkSnapshotMap(): Promise<
  Map<string, BenchmarkSnapshot>
> {
  const snapshotMap = new Map<string, BenchmarkSnapshot>();

  // Get gh-pages commits that modified the benchmark file
  const ghPagesCommitsRes = await fetch(
    `${GITHUB_API}/repos/${REPO}/commits?sha=gh-pages&path=${FILE_PATH}&per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN && {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        }),
      },
      next: { revalidate: 300 },
    }
  );

  if (!ghPagesCommitsRes.ok) {
    console.error(
      `Failed to fetch gh-pages commits: ${ghPagesCommitsRes.status}`
    );
    return snapshotMap;
  }

  const ghPagesCommits = (await ghPagesCommitsRes.json()) as GitHubCommit[];

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

  // Get commits from main branch
  const mainCommitsRes = await fetch(
    `${GITHUB_API}/repos/${REPO}/commits?sha=main&per_page=${MAX_ITEMS * 2}`,
    {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN && {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        }),
      },
      next: { revalidate: 300 },
    }
  );

  if (!mainCommitsRes.ok) {
    console.error(`Failed to fetch main commits: ${mainCommitsRes.status}`);
    return [];
  }

  const mainCommits = (await mainCommitsRes.json()) as GitHubCommit[];

  // Match main commits to their benchmark snapshots
  const historyPoints: BenchmarkHistoryPoint[] = [];

  for (const mainCommit of mainCommits) {
    if (historyPoints.length >= MAX_ITEMS) break;

    const snapshot = snapshotMap.get(mainCommit.sha);
    if (!snapshot) continue;

    const worldData = snapshot.data.worlds[worldId];
    const metric = worldData?.metrics?.[metricName];
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

  // Get all tags for the workflow package
  const tagsRes = await fetch(`${GITHUB_API}/repos/${REPO}/tags?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN && {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      }),
    },
    next: { revalidate: 300 },
  });

  if (!tagsRes.ok) {
    console.error(`Failed to fetch tags: ${tagsRes.status}`);
    return [];
  }

  const allTags = (await tagsRes.json()) as GitHubTag[];

  // Filter for workflow@ tags only
  const workflowTags = allTags.filter((tag) =>
    tag.name.startsWith('workflow@')
  );

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
    const metric = worldData?.metrics?.[metricName];
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
