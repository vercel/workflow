import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getRun } from 'workflow/api';

export const maxDuration = 300;

interface Body {
  runIds: string[];
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Body;
  const results = await Promise.allSettled(
    body.runIds.map(async (runId) => {
      const run = await getRun(runId);
      return {
        runId,
        status: run.status,
        errorCode: run.error?.code,
        errorMessage: run.error?.message,
      };
    })
  );

  const grouped: Record<string, number> = {};
  const failures: Array<{
    runId: string;
    status: string;
    errorCode?: string;
    errorMessage?: string;
  }> = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const key = `${r.value.status}${r.value.errorCode ? `:${r.value.errorCode}` : ''}`;
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
    failures: failures.slice(0, 20),
  });
}
