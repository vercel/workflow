'use client';

import { TooltipProvider } from '@radix-ui/react-tooltip';
import type { PublicServerConfig } from '@workflow/web-shared/server';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ThemeProvider, useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { ConnectionStatus } from '@/components/display-utils/connection-status';
import { ThemePicker } from '@/components/theme-dropdown';
import { DocsLink } from '@/components/top-nav/docs-link';
import { Toaster } from '@/components/ui/sonner';
import { ServerConfigProvider } from '@/lib/world-config-context';
import { Logo } from '../icons/logo';

interface LayoutClientProps {
  children: React.ReactNode;
  serverConfig: PublicServerConfig;
}

function computeDirectRunUrl(params: {
  runId: string;
  stepId: string | null;
  hookId: string | null;
}): string {
  const { runId, stepId, hookId } = params;
  if (stepId) {
    return `/run/${runId}?sidebar=step&stepId=${stepId}`;
  }
  if (hookId) {
    return `/run/${runId}?sidebar=hook&hookId=${hookId}`;
  }
  return `/run/${runId}`;
}

function computeResourceUrl(params: {
  resource: string;
  id: string;
  runId: string | null;
}): string | null {
  const { resource, id, runId } = params;
  switch (resource) {
    case 'run':
      return `/run/${id}`;
    case 'step':
      return runId ? `/run/${runId}?sidebar=step&stepId=${id}` : null;
    case 'stream':
      return runId ? `/run/${runId}?sidebar=stream&streamId=${id}` : null;
    case 'event':
      return runId ? `/run/${runId}?sidebar=event&eventId=${id}` : null;
    case 'hook':
      return runId
        ? `/run/${runId}?sidebar=hook&hookId=${id}`
        : `/?sidebar=hook&hookId=${id}`;
    default:
      return null;
  }
}

function getInitialNavigationUrl(params: {
  pathname: string;
  hasNavigated: boolean;
  resource: string | null;
  id: string | null;
  runId: string | null;
  stepId: string | null;
  hookId: string | null;
}): { url: string | null; markNavigated: boolean; warn?: string } {
  const { pathname, hasNavigated, resource, id, runId, stepId, hookId } =
    params;

  if (pathname.startsWith('/run/')) {
    return { url: null, markNavigated: true };
  }

  if (pathname !== '/' && hasNavigated) {
    return { url: null, markNavigated: false };
  }

  if (resource) {
    if (!id) return { url: null, markNavigated: false };
    const url = computeResourceUrl({ resource, id, runId });
    return url
      ? { url, markNavigated: true }
      : {
          url: null,
          markNavigated: false,
          warn: `Can't deep-link to ${resource} ${id}.`,
        };
  }

  if (runId) {
    return {
      url: computeDirectRunUrl({ runId, stepId, hookId }),
      markNavigated: true,
    };
  }

  return { url: null, markNavigated: false };
}

function LayoutContent({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { setTheme } = useTheme();

  const id = searchParams.get('id');
  const runId = searchParams.get('runId');
  const stepId = searchParams.get('stepId');
  const hookId = searchParams.get('hookId');
  const resource = searchParams.get('resource');
  const themeParam = searchParams.get('theme');

  // Track if we've already handled the initial navigation
  const hasNavigatedRef = useRef(false);

  // Sync theme from URL param to next-themes (one-time or when explicitly changed)
  useEffect(() => {
    if (
      themeParam &&
      (themeParam === 'light' ||
        themeParam === 'dark' ||
        themeParam === 'system')
    ) {
      setTheme(themeParam);
    }
  }, [themeParam, setTheme]);

  // If initialized with a resource/id or direct ID params, we navigate to the appropriate page
  // Only run this logic once on mount or when we're on the root path with special params
  useEffect(() => {
    const result = getInitialNavigationUrl({
      pathname,
      hasNavigated: hasNavigatedRef.current,
      resource,
      id,
      runId,
      stepId,
      hookId,
    });

    if (result.warn) {
      console.warn(result.warn);
    }

    if (result.markNavigated) {
      hasNavigatedRef.current = true;
    }

    if (!result.url) return;

    router.push(result.url);
  }, [resource, id, runId, stepId, hookId, router, pathname]);

  return (
    <div className="min-h-screen flex flex-col">
      <TooltipProvider delayDuration={0}>
        {/* Sticky Header */}
        <div className="sticky top-0 z-50 bg-background border-b px-6 py-4">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-4">
              <Link href="/">
                <h1
                  className="flex items-center gap-2"
                  title="Workflow Observability"
                >
                  <Logo />
                </h1>
              </Link>
              <div className="h-6 w-px bg-border" aria-hidden="true" />
              <ConnectionStatus />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ThemePicker />
              <DocsLink />
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 px-6 pt-6">{children}</div>
      </TooltipProvider>
      <Toaster />
    </div>
  );
}

export function LayoutClient({ children, serverConfig }: LayoutClientProps) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="workflow-theme"
    >
      <ServerConfigProvider serverConfig={serverConfig}>
        <LayoutContent>{children}</LayoutContent>
      </ServerConfigProvider>
    </ThemeProvider>
  );
}
