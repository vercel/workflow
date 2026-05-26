import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getRun } from 'workflow/api';

export const maxDuration = 300;

interface Body {
  runIds: string[];
}

interface RunRow {
  runId: string;
  status: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Body;
  const results = await Promise.allSettled<RunRow>(
    body.runIds.map(async (runId) => {
      const run = await getRun(runId);
      const status = await run.status;
      return { runId, status };
    })
  );

  const grouped: Record<string, number> = {};
  const failures: RunRow[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const key = r.value.status;
      grouped[key] = (grouped[key] ?? 0) + 1;
      if (r.value.status === 'failed') {
        failures.push(r.value);
      }
    } else {
      grouped['lookup-error'] = (grouped['lookup-error'] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    total: body.runIds.length,
    grouped,
    failures: failures.slice(0, 50),
  });
}
