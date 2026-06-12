/**
 * /r/[name] — shadcn-compatible registry item endpoint.
 *
 * Returns a single registry item in the shadcn registry-item.json schema so
 * the shadcn CLI can install it:
 *
 *   pnpm dlx shadcn@latest add https://workflow-sdk.dev/r/durable-agent
 *
 * Only workflow source files (captions starting with "workflows/") are
 * included in the response. For those files, `installCode` is preferred over
 * `code` when present — `installCode` carries the richly-commented version
 * with agent-friendly PATTERN / USEFUL WHEN / TO ADAPT sections, while
 * `code` is the clean UI display version.
 *
 * Content negotiation:
 *   - `Accept: application/json` or `User-Agent: *shadcn*` → JSON response
 *   - Otherwise → redirect to the human-readable /patterns/[name] page
 */

import { NextResponse } from 'next/server';
import { registryItems } from '@/lib/patterns/manifest';

const WORKFLOW_PATH_PREFIX = 'workflows/';

export const dynamic = 'force-dynamic';

function wantsBrowserRedirect(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  // shadcn CLI sends Accept: application/json; browsers send text/html first.
  if (accept.includes('application/json')) return false;
  if (/shadcn/i.test(userAgent)) return false;
  if (accept.includes('text/html')) return true;
  return false;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const item = registryItems.find((r) => r.id === name);
  if (!item) {
    // For browser requests, redirect to the patterns index.
    if (wantsBrowserRedirect(request)) {
      return NextResponse.redirect(new URL('/patterns', request.url), 302);
    }
    return NextResponse.json(
      { error: `Pattern "${name}" not found` },
      { status: 404 }
    );
  }

  // Browsers visiting /r/durable-agent get the pretty detail page instead.
  if (wantsBrowserRedirect(request)) {
    return NextResponse.redirect(
      new URL(`/patterns/${name}`, request.url),
      302
    );
  }

  // Educational/concept patterns are not installable — their code is all
  // placeholder. Point the CLI user at the readable page instead.
  if (item.installable === false) {
    return NextResponse.json(
      {
        error: `Pattern "${name}" is a concept guide, not an installable item. Read it at https://workflow-sdk.dev/patterns/${name}`,
      },
      { status: 404 }
    );
  }

  // Collect workflow files from snippets (installCode > code fallback).
  const workflowSnippets = item.snippets.filter((s) =>
    s.caption?.startsWith(WORKFLOW_PATH_PREFIX)
  );

  // Deduplicate by caption path — multiple tabs may point to the same file.
  const seenPaths = new Set<string>();
  const files: Array<{
    path: string;
    content: string;
    type: 'registry:file';
    target: string;
  }> = [];

  for (const snippet of workflowSnippets) {
    const filePath = snippet.caption!;
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);

    files.push({
      path: filePath,
      content: snippet.installCode ?? snippet.code,
      // registry:file tells the shadcn CLI to write the inline `content` field
      // directly to `target` without trying to resolve `path` as a URL.
      type: 'registry:file',
      // Workflow files live under app/workflows/ in a Next.js app-router project.
      target: `app/${filePath}`,
    });
  }

  // If no workflow snippets found, also check conceptSnippets.
  if (files.length === 0 && item.conceptSnippets) {
    for (const snippet of item.conceptSnippets) {
      if (!snippet.caption?.startsWith(WORKFLOW_PATH_PREFIX)) continue;
      const filePath = snippet.caption!;
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);
      files.push({
        path: filePath,
        content: snippet.installCode ?? snippet.code,
        type: 'registry:file',
        target: `app/${filePath}`,
      });
    }
  }

  const registryItem = {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name: item.id,
    type: 'registry:file' as const,
    title: item.name,
    description: item.description,
    files,
  };

  return NextResponse.json(registryItem, {
    headers: {
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
