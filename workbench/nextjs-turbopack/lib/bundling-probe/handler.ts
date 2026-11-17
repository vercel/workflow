import { after } from 'next/server';
import { bootId, moduleStartedAt, uptimeAtModuleStartMs } from './clock';

interface ProbeRoute {
  name: string;
  /** When the route module finished evaluating. */
  moduleEvaluatedAt: number;
  start?: (startCalledAt: number) => Promise<{ runId: string }>;
  extra?: () => Record<string, unknown>;
}

let invocations = 0;

/**
 * A probe route's POST handler. Body: `{ queued?: boolean }`. `?exit=1`
 * answers, then ends this process so the next request gets a fresh one.
 * `?hop=<url>` times a fetch to another route (the cost of an extra in-region
 * invocation).
 */
export function probeHandler(route: ProbeRoute) {
  return async (req: Request) => {
    const requestAt = Date.now();
    const uptimeAtRequestMs = Math.round(process.uptime() * 1000);
    invocations += 1;
    const invocation = invocations;
    const url = new URL(req.url);
    const base = {
      route: route.name,
      bootId: bootId(),
      invocation,
      uptimeAtModuleStartMs,
      moduleLoadMs: route.moduleEvaluatedAt - moduleStartedAt,
      uptimeAtRequestMs,
      requestAt,
      region: process.env.VERCEL_REGION ?? null,
      ...route.extra?.(),
    };
    if (url.searchParams.get('exit') === '1') {
      after(async () => {
        await new Promise((r) => setTimeout(r, 250));
        process.exit(0);
      });
      return Response.json({ ...base, exiting: true });
    }
    const hop = url.searchParams.get('hop');
    if (hop) {
      const target = new URL(hop, url);
      const headers: Record<string, string> = {};
      const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      if (bypass) headers['x-vercel-protection-bypass'] = bypass;
      const samples: number[] = [];
      let status = 0;
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const res = await fetch(target, {
          method: 'POST',
          headers,
          body: '{}',
        });
        status = res.status;
        await res.arrayBuffer();
        samples.push(Math.round((performance.now() - t) * 10) / 10);
      }
      return Response.json({
        ...base,
        hop: { target: target.pathname, status, samples },
      });
    }
    if (!route.start) return Response.json(base);
    const body = (await req.json().catch(() => ({}))) as { queued?: boolean };
    const previous = process.env.WORKFLOW_INLINE_DELIVERY;
    if (body.queued) process.env.WORKFLOW_INLINE_DELIVERY = '0';
    const startCalledAt = Date.now();
    let runId: string;
    try {
      ({ runId } = await route.start(startCalledAt));
    } finally {
      if (body.queued) {
        if (previous === undefined) delete process.env.WORKFLOW_INLINE_DELIVERY;
        else process.env.WORKFLOW_INLINE_DELIVERY = previous;
      }
    }
    const startReturnedAt = Date.now();
    return Response.json({
      ...base,
      queued: body.queued === true,
      runId,
      startCalledAt,
      startReturnedAt,
      startMs: startReturnedAt - startCalledAt,
    });
  };
}
