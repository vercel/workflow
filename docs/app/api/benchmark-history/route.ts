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

// Fetch and parse a benchmark file from gh-pages
async function fetchBenchmarkFile(
  ghPagesSha: string
): Promise<CIResultsData | null> {
  try {
    const fileRes = await fetch(
      `https://raw.githubusercontent.com/${REPO}/${ghPagesSha}/${FILE_PATH}`,
      { cache: 'force-cache', next: { revalidate: 86400 } }
    );

    if (!fileRes.ok) {
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
 * Slim snapshot stored in the cache — only the worlds/metrics map, no raw
 * CIResultsData metadata. This keeps the serialised size well under the
 * Next.js unstable_cache 2 MB limit.
 */
interface SnapshotEntry {
  mainCommitSha: string;
  timestamp: string;
  worlds: CIResultsData['worlds'];
}

/**
 * Build a map of main commit SHA -> benchmark snapshot data by reading
 * the full gh-pages history. Returns a plain object (for cache serialization).
 *
 * Only the `worlds` map (metric numbers per world) is retained in each entry
 * so the total payload stays small enough for unstable_cache.
 */
async function _buildSnapshotMap(): Promise<
  Record<string, SnapshotEntry>
> {
  const snapshots: Record<string, SnapshotEntry> = {};

  // Paginate through gh-pages commits that modified the benchmark file.
  // We only need ~MAX_ITEMS matches, so cap the fetch to avoid hundreds of
  // unnecessary requests on repos with long histories.
  const MAX_SNAPSHOTS = MAX_ITEMS * 3;
  let ghPagesCommits: GitHubCommit[] = [];
  let url: string | null =
    `${GITHUB_API}/repos/${REPO}/commits?sha=gh-pages&path=${FILE_PATH}&per_page=100`;

  while (url && ghPagesCommits.length < MAX_SNAPSHOTS) {
    const res = await fetch(url, {
      headers: githubHeaders(),
      cache: 'force-cache',
      next: { revalidate: 3600 },
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

  if (ghPagesCommits.length >= MAX_SNAPSHOTS) {
    console.warn(`Benchmark history: hit pagination cap at ${MAX_SNAPSHOTS} gh-pages commits — older snapshots may be missing`);
  }

  // Fetch benchmark data for each gh-pages commit in batches
  const BATCH_SIZE = 30;
  for (let i = 0; i < ghPagesCommits.length; i += BATCH_SIZE) {
    const batch = ghPagesCommits.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (ghCommit) => {
        const data = await fetchBenchmarkFile(ghCommit.sha);
        if (!data || !data.commit) return null;
        return {
          mainCommitSha: data.commit,
          timestamp: data.lastUpdated,
          worlds: data.worlds,
        };
      })
    );

    for (const result of results) {
      if (result && !snapshots[result.mainCommitSha]) {
        snapshots[result.mainCommitSha] = result;
      }
    }
  }

  return snapshots;
}

/**
 * In-memory cache for the snapshot map. Individual fetch() calls inside
 * _buildSnapshotMap already use Next.js fetch caching, so we only need to
 * avoid re-assembling the map on every request. An in-memory cache has no
 * serialization size limit (unlike unstable_cache's 2 MB cap).
 */
let _snapshotMapCache: {
  data: Record<string, SnapshotEntry>;
  expiry: number;
} | null = null;

async function buildSnapshotMap(): Promise<Record<string, SnapshotEntry>> {
  if (_snapshotMapCache && Date.now() < _snapshotMapCache.expiry) {
    return _snapshotMapCache.data;
  }
  const data = await _buildSnapshotMap();
  _snapshotMapCache = { data, expiry: Date.now() + 3600 * 1000 };
  return data;
}

/**
 * Fetch all workflow@ tags from GitHub (paginated).
 */
async function _fetchWorkflowTags(): Promise<GitHubTag[]> {
  let workflowTags: GitHubTag[] = [];
  let tagsUrl: string | null = `${GITHUB_API}/repos/${REPO}/tags?per_page=100`;

  while (tagsUrl) {
    const tagsRes = await fetch(tagsUrl, {
      headers: githubHeaders(),
      cache: 'force-cache',
      next: { revalidate: 3600 },
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

  return workflowTags;
}

let _tagsCache: { data: GitHubTag[]; expiry: number } | null = null;

async function fetchWorkflowTags(): Promise<GitHubTag[]> {
  if (_tagsCache && Date.now() < _tagsCache.expiry) {
    return _tagsCache.data;
  }
  const data = await _fetchWorkflowTags();
  _tagsCache = { data, expiry: Date.now() + 3600 * 1000 };
  return data;
}

async function fetchCommitsHistory(
  worldId: string,
  metricName: string
): Promise<BenchmarkHistoryPoint[]> {
  const snapshots = await buildSnapshotMap();

  if (Object.keys(snapshots).length === 0) {
    return [];
  }

  // Paginate through main branch commits until we have enough data points.
  const historyPoints: BenchmarkHistoryPoint[] = [];
  let mainUrl: string | null =
    `${GITHUB_API}/repos/${REPO}/commits?sha=main&per_page=100`;

  while (mainUrl && historyPoints.length < MAX_ITEMS) {
    const mainCommitsRes = await fetch(mainUrl, {
      headers: githubHeaders(),
      cache: 'force-cache',
      next: { revalidate: 3600 },
    });

    if (!mainCommitsRes.ok) {
      console.error(`Failed to fetch main commits: ${mainCommitsRes.status}`);
      break;
    }

    const mainCommits = (await mainCommitsRes.json()) as GitHubCommit[];

    for (const mainCommit of mainCommits) {
      if (historyPoints.length >= MAX_ITEMS) break;

      const snapshot = snapshots[mainCommit.sha];
      if (!snapshot) continue;

      const worldData = snapshot.worlds[worldId];
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
  const [snapshots, workflowTags] = await Promise.all([
    buildSnapshotMap(),
    fetchWorkflowTags(),
  ]);

  if (Object.keys(snapshots).length === 0 || workflowTags.length === 0) {
    return [];
  }

  // Use the snapshot's existing timestamp (data.lastUpdated = when CI ran)
  // instead of fetching commitData.commit.committer.date (when tag was committed)
  // per tag. These can differ by minutes but are functionally equivalent for
  // chart display. This eliminates up to MAX_ITEMS serial API requests.
  const historyPoints: BenchmarkHistoryPoint[] = [];

  for (const tag of workflowTags) {
    if (historyPoints.length >= MAX_ITEMS) break;

    const snapshot = snapshots[tag.commit.sha];
    if (!snapshot) continue;

    const worldData = snapshot.worlds[worldId];
    const metric = findMetric(worldData, metricName);
    if (!metric) continue;

    const version = tag.name.replace('workflow@', '');

    historyPoints.push({
      label: version,
      commit: tag.commit.sha.slice(0, 7),
      timestamp: snapshot.timestamp,
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
        // CDN: cache 1 hour, serve stale up to 24h while revalidating
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
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
