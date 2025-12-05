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
}

export interface BenchmarkMetric {
  mean: number;
  min: number;
  max: number;
  samples?: number;
  ttfb?: {
    mean: number;
    min: number;
    max: number;
  };
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
  e2e: WorldE2E | null;
  benchmark: WorldBenchmark | null;
}

export interface WorldsStatus {
  $schema: string;
  lastUpdated: string;
  commit: string | null;
  branch: string | null;
  worlds: Record<string, World>;
}
