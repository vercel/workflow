/**
 * Server-side data fetching for the Worlds dashboard
 * Fetches CI test results and benchmarks from GitHub Pages
 */

import { unstable_cache } from 'next/cache';
import type { World, WorldsStatus } from '@/components/worlds/types';

// Import manifest data at build time
import worldsManifest from '../../worlds-manifest.json';

// GitHub Pages URLs for CI results
const CI_DATA_BASE_URL = 'https://vercel.github.io/workflow/ci';
const E2E_RESULTS_URL = `${CI_DATA_BASE_URL}/e2e-results.json`;
const BENCHMARK_RESULTS_URL = `${CI_DATA_BASE_URL}/benchmark-results.json`;

interface CIResultsData {
  lastUpdated: string;
  commit: string | null;
  branch: string | null;
  type: 'e2e' | 'benchmarks';
  worlds: Record<string, E2EWorldData | BenchmarkWorldData>;
}

interface E2EWorldData {
  status: 'passing' | 'partial' | 'failing' | 'pending';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  progress?: number;
  frameworks?: Record<
    string,
    { total: number; passed: number; failed: number }
  >;
}

interface BenchmarkWorldData {
  status: 'measured' | 'pending';
  metrics: Record<
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
  frameworks?: Record<string, Record<string, unknown>>;
}

/**
 * Fetch JSON from URL with error handling
 */
async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      next: { revalidate: 300 }, // Cache for 5 minutes
    });

    if (!res.ok) {
      console.error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      return null;
    }

    return res.json();
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
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
      repository: (world as { repository?: string }).repository,
      example: (world as { example?: string }).example,
      e2e: null,
      benchmark: null,
      benchmark10SeqMs: null,
    };
  }

  return worlds;
}

/**
 * Get worlds data with CI results from GitHub Pages
 * Cached for 5 minutes
 */
export const getWorldsData = unstable_cache(
  async (): Promise<WorldsStatus> => {
    const worlds = buildInitialWorldsStatus();
    let lastUpdated = new Date().toISOString();
    let commit: string | null = null;
    let branch: string | null = null;

    try {
      // Fetch E2E and benchmark results in parallel
      const [e2eData, benchmarkData] = await Promise.all([
        fetchJSON<CIResultsData>(E2E_RESULTS_URL),
        fetchJSON<CIResultsData>(BENCHMARK_RESULTS_URL),
      ]);

      // Use the most recent data's metadata
      if (e2eData) {
        lastUpdated = e2eData.lastUpdated;
        commit = e2eData.commit;
        branch = e2eData.branch;
      } else if (benchmarkData) {
        lastUpdated = benchmarkData.lastUpdated;
        commit = benchmarkData.commit;
        branch = benchmarkData.branch;
      }

      // Process E2E results
      if (e2eData?.worlds) {
        for (const [worldId, data] of Object.entries(e2eData.worlds)) {
          if (worlds[worldId]) {
            const e2eWorld = data as E2EWorldData;
            const nextjsTurbopack = e2eWorld.frameworks?.['nextjs-turbopack'];

            // Calculate status based on nextjs-turbopack results if available
            // This is the canonical source for scoring in the UI
            let status = e2eWorld.status;
            if (nextjsTurbopack) {
              if (nextjsTurbopack.failed > 0) {
                status = nextjsTurbopack.passed > 0 ? 'partial' : 'failing';
              } else if (nextjsTurbopack.total > 0) {
                status = 'passing';
              }
            }

            worlds[worldId].e2e = {
              status,
              total: e2eWorld.total,
              passed: e2eWorld.passed,
              failed: e2eWorld.failed,
              skipped: e2eWorld.skipped,
              progress: e2eWorld.progress ?? 0,
              lastRun: e2eData.lastUpdated,
              frameworks: e2eWorld.frameworks,
              nextjsTurbopack: nextjsTurbopack ?? undefined,
            };
          }
        }
      }

      // Process benchmark results
      if (benchmarkData?.worlds) {
        for (const [worldId, data] of Object.entries(benchmarkData.worlds)) {
          if (worlds[worldId]) {
            const benchWorld = data as BenchmarkWorldData;
            worlds[worldId].benchmark = {
              status: benchWorld.status,
              metrics: benchWorld.metrics,
              lastRun: benchmarkData.lastUpdated,
            };
          }
        }

        // Extract "10 sequential steps" benchmark time for each world
        const BENCHMARK_10_SEQ = 'workflow with 10 sequential steps';
        for (const worldId of Object.keys(worlds)) {
          const metric =
            worlds[worldId]?.benchmark?.metrics?.[BENCHMARK_10_SEQ];
          worlds[worldId].benchmark10SeqMs = metric?.workflowTime ?? null;
        }
      }
    } catch (error) {
      console.error('Error fetching worlds data:', error);
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
 * Alias for backwards compatibility
 */
export const getWorldsDataWithArtifacts = getWorldsData;

/**
 * Get data for a single world by ID
 */
export async function getWorldData(id: string): Promise<{
  world: World;
  meta: { lastUpdated: string; commit: string | null; branch: string | null };
} | null> {
  const data = await getWorldsData();
  const world = data.worlds[id];
  if (!world) return null;
  return {
    world,
    meta: {
      lastUpdated: data.lastUpdated,
      commit: data.commit,
      branch: data.branch,
    },
  };
}

/**
 * Get all world IDs for static generation
 */
export function getWorldIds(): string[] {
  return worldsManifest.worlds.map((w) => w.id);
}
