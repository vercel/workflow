import { TooltipProvider } from '@radix-ui/react-tooltip';
import { ThemeProvider, useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import {
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { ConnectionStatus } from '~/components/display-utils/connection-status';
import { HealthCheckButton } from '~/components/display-utils/health-check-button';
import { ThemePicker } from '~/components/theme-dropdown';
import { DocsLink } from '~/components/top-nav/docs-link';
import { Toaster } from '~/components/ui/sonner';
import { Logo } from '~/icons/logo';
import { ServerConfigProvider } from '~/lib/world-config-context';
import { getPublicServerConfig } from '~/server/workflow-server-actions.server';

import type { Route } from './+types/root';
import './globals.css';

// Server-side loader: provides config data on initial render and navigation
export async function loader() {
  const serverConfig = await getPublicServerConfig();
  return { serverConfig };
}

// Catch-all action: handles stray POST requests (e.g. from Radix UI dialogs
// that render internal <form method="dialog"> elements).
export async function action({ request }: { request: Request }) {
  const url = new URL(request.url);
  const contentType = request.headers.get('content-type') || '(none)';
  const body = await request.text().catch(() => '(unreadable)');
  console.warn(
    `[root action] Unexpected POST to ${url.pathname}`,
    `\n  Content-Type: ${contentType}`,
    `\n  Referer: ${request.headers.get('referer') || '(none)'}`,
    `\n  Body: ${body.slice(0, 500) || '(empty)'}`
  );
  return null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
        <title>Workflow Observability UI</title>
        <meta
          name="description"
          content="Web interface for inspecting flow runs, steps, streams, and events"
        />
        <Meta />
        <Links />
      </head>
      <body className="antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// --- Deep-link navigation helpers (migrated from layout-client.tsx) ---

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

function LayoutContent({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setTheme } = useTheme();

  const id = searchParams.get('id');
  const runId = searchParams.get('runId');
  const stepId = searchParams.get('stepId');
  const hookId = searchParams.get('hookId');
  const resource = searchParams.get('resource');
  const themeParam = searchParams.get('theme');

  const hasNavigatedRef = useRef(false);

  // Sync theme from URL param to next-themes
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

  // Deep-link navigation on mount
  useEffect(() => {
    const pathname = window.location.pathname;

    if (pathname.startsWith('/run/')) {
      hasNavigatedRef.current = true;
      return;
    }

    if (pathname !== '/' && hasNavigatedRef.current) {
      return;
    }

    if (resource) {
      if (!id) return;
      const url = computeResourceUrl({ resource, id, runId });
      if (url) {
        hasNavigatedRef.current = true;
        navigate(url);
      } else {
        console.warn(`Can't deep-link to ${resource} ${id}.`);
      }
      return;
    }

    if (runId) {
      hasNavigatedRef.current = true;
      navigate(computeDirectRunUrl({ runId, stepId, hookId }));
      return;
    }
  }, [resource, id, runId, stepId, hookId, navigate]);

  return (
    <div className="min-h-screen flex flex-col">
      <TooltipProvider delayDuration={0}>
        {/* Sticky Header */}
        <div className="sticky top-0 z-50 bg-background border-b px-6 py-4">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-4">
              <Link to="/">
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
              <HealthCheckButton />
              <div className="h-6 w-px bg-border" aria-hidden="true" />
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

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="workflow-theme"
    >
      <ServerConfigProvider serverConfig={loaderData.serverConfig}>
        <LayoutContent>
          <Outlet />
        </LayoutContent>
      </ServerConfigProvider>
    </ThemeProvider>
  );
}
