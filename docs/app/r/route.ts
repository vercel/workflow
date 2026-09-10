/**
 * /r — shadcn-compatible registry index endpoint.
 *
 * Returns the full registry in the shadcn registry.json schema so the CLI
 * can discover all available patterns:
 *
 *   pnpm dlx shadcn@latest add https://workflow-sdk.dev/r
 *
 * Each item in the index links to /r/[name] for the full file payload.
 */

import { NextResponse } from 'next/server';
import { registryItems } from '@/lib/patterns/manifest';

export const dynamic = 'force-dynamic';

function wantsBrowserRedirect(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  if (accept.includes('application/json')) return false;
  if (/shadcn/i.test(userAgent)) return false;
  if (accept.includes('text/html')) return true;
  return false;
}

export async function GET(request: Request) {
  if (wantsBrowserRedirect(request)) {
    return NextResponse.redirect(new URL('/patterns', request.url), 302);
  }
  const items = registryItems.map((item) => ({
    name: item.id,
    type: 'registry:lib' as const,
    title: item.name,
    description: item.description,
    registryDependencies: [],
    tags: item.tags,
    categories: item.categories,
  }));

  const registryIndex = {
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: 'workflow-sdk',
    homepage: 'https://workflow-sdk.dev',
    items,
  };

  return NextResponse.json(registryIndex, {
    headers: {
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
