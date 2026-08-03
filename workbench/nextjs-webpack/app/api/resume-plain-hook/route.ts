import { NextResponse } from 'next/server';
import { plainModuleDoneHook } from '@/workflows/_plain_module_hooks';

/**
 * Mirrors vercel/o2flow's `app/api/internal/sandbox-complete/route.ts`: a
 * plain API route (no workflow directives anywhere in its module graph) that
 * resumes a workflow hook defined via `defineHook()` in a shared module.
 *
 * This exercises the host-bundle `hook.resume()` path through the
 * framework's own bundler, which is not covered by the e2e tests that call
 * `resumeHook()` from the (unbundled) test process.
 */
export async function POST(req: Request) {
  const { token, ok, note } = (await req.json()) as {
    token: string;
    ok: boolean;
    note?: string;
  };

  try {
    await plainModuleDoneHook.resume(token, { ok, note });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
