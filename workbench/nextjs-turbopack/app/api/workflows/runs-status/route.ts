import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
// Access the underlying world directly for fields that Run doesn't surface.
import { getWorldLazy } from '@workflow/core/runtime/get-world-lazy';

export const maxDuration = 300;

interface Body {
  runIds: string[];
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Body;
  const world = await getWorldLazy();
  // Optional: when ?events=1 is set, also return the list of events for
  // each run so we can diff branch events for failures.
  const url = new URL(request.url);
  const includeEvents = url.searchParams.get('events') === '1';
  const results = await Promise.allSettled(
    body.runIds.map(async (runId) => {
      const run = await world.runs.get(runId);
      const base = {
        runId,
        status: run.status,
        errorCode: (run as { errorCode?: string }).errorCode,
      };
      if (!includeEvents) return base;
      const eventsList = await world.events.list({ runId });
      return {
        ...base,
        events: eventsList.data.map((e) => ({
          eventId: e.eventId,
          eventType: e.eventType,
          correlationId: e.correlationId,
        })),
      };
    })
  );

  const grouped: Record<string, number> = {};
  const failures: Array<{
    runId: string;
    status: string;
    errorCode?: string;
    events?: Array<{
      eventId: string;
      eventType: string;
      correlationId?: string;
    }>;
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
