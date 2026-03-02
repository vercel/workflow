export interface FrameworkE2EData {
  total: number;
  passed: number;
  failed: number;
}

export interface WorldE2E {
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
  lastRun: string | null;
  note?: string;
  // Per-framework breakdown for detailed analysis
  frameworks?: Record<string, FrameworkE2EData>;
  // Next.js Turbopack specific data used for scoring
  // This is the canonical source for pass/fail status displayed in the UI
  nextjsTurbopack?: FrameworkE2EData;
}

export interface BenchmarkMetric {
  mean: number;
  min: number;
  max: number;
  samples?: number;
  // Workflow time metrics (actual execution time, not wall time)
  workflowTime?: number;
  workflowMin?: number;
  workflowMax?: number;
  // Stream benchmark metrics
  ttfb?: number; // Time to first byte
  slurp?: number; // Time from first byte to stream completion
}

export interface WorldBenchmark {
  status: 'measured' | 'pending';
  metrics: Record<string, BenchmarkMetric> | null;
  lastRun: string | null;
}

export interface World {
  type: 'official' | 'community';
  name: string;
  package: string;
  description: string;
  docs: string;
  repository?: string;
  example?: string;
  e2e: WorldE2E | null;
  benchmark: WorldBenchmark | null;
  /**
   * Time to run "workflow with 10 sequential steps" benchmark in milliseconds.
   * This is a key performance indicator for the world. null if not available.
   */
  benchmark10SeqMs: number | null;
}

export interface WorldsStatus {
  $schema: string;
  lastUpdated: string;
  commit: string | null;
  branch: string | null;
  worlds: Record<string, World>;
}

/**
 * Format a time value in milliseconds.
 * If >= 1000ms, displays as seconds with 2 decimal places.
 * Otherwise displays as milliseconds with no decimals.
 */
export function formatTime(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms.toFixed(0)}ms`;
}
