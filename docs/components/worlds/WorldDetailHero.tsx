'use client';

import { useState } from 'react';
import {
  ExternalLink,
  ChevronRight,
  CheckIcon,
  CopyIcon,
  BadgeCheck,
  HeartHandshake,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  Timer,
  Package,
  Github,
  Code,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';

import type { World } from './types';

interface WorldDetailHeroProps {
  id: string;
  world: World;
}

const statusConfig = {
  passing: {
    label: 'Passing',
    icon: CheckCircle2,
    className: 'text-green-500',
  },
  partial: {
    label: 'Partial',
    icon: AlertCircle,
    className: 'text-yellow-500',
  },
  failing: {
    label: 'Failing',
    icon: XCircle,
    className: 'text-red-500',
  },
  pending: {
    label: 'Pending',
    icon: Clock,
    className: 'text-muted-foreground',
  },
};

export function WorldDetailHero({ id, world }: WorldDetailHeroProps) {
  const [copied, setCopied] = useState(false);

  const isExternalDocs = world.docs.startsWith('http');
  const installCommand = `npm i ${world.package}`;

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to copy text to clipboard';
      toast.error(message);
    }
  };

  const CopyButtonIcon = copied ? CheckIcon : CopyIcon;

  // E2E test calculations
  const e2e = world.e2e;
  const turbopackData = e2e?.nextjsTurbopack;
  const scoringPassed = turbopackData
    ? turbopackData.passed
    : (e2e?.passed ?? 0);
  const scoringFailed = turbopackData
    ? turbopackData.failed
    : (e2e?.failed ?? 0);
  const testsRan = scoringPassed + scoringFailed;
  const status = e2e?.status ?? 'pending';
  const StatusIcon = statusConfig[status].icon;

  // Benchmark calculations
  const benchmark = world.benchmark;
  const benchmarkCount = benchmark?.metrics
    ? Object.keys(benchmark.metrics).length
    : 0;

  // GitHub source URL for official worlds
  const githubUrl =
    world.repository ||
    (world.type === 'official'
      ? `https://github.com/vercel/workflow/tree/main/packages/world-${id}`
      : null);

  return (
    <section className="space-y-6 px-4 pt-8 sm:pt-12 pb-12 border-b">
      {/* Breadcrumbs */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/worlds">Worlds</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>
            <ChevronRight className="h-4 w-4" />
          </BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{world.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Main content grid */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-8">
        {/* Left side - Title and description */}
        <div className="space-y-4 flex-1">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl flex items-center gap-4">
            {world.name}
            {world.type === 'official' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <BadgeCheck className="h-8 w-8 text-blue-500" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Maintained by Vercel</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <HeartHandshake className="h-8 w-8 text-pink-500" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Maintained by the community</p>
                </TooltipContent>
              </Tooltip>
            )}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            {world.package}
          </p>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {world.description}
          </p>

          {/* Actions - Community worlds only */}
          {world.type === 'community' && (
            <div className="flex items-center gap-3 flex-wrap pt-2">
              <div className="relative bg-background border rounded-md overflow-hidden py-3 pl-4 pr-12 inline-flex">
                <pre className="text-sm">
                  <code>{installCommand}</code>
                </pre>
                <Button
                  onClick={handleCopy}
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                >
                  <CopyButtonIcon className="size-4 text-muted-foreground" />
                </Button>
              </div>
              {world.repository && (
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="h-[44px] text-base"
                >
                  <a
                    href={world.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2"
                  >
                    GitHub
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
              {isExternalDocs && world.docs !== world.repository && (
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="h-[44px] text-base"
                >
                  <a
                    href={world.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2"
                  >
                    Documentation
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Right side - Quick links */}
        <div className="flex-shrink-0 space-y-2 text-sm">
          {/* E2E Tests */}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href="#testing"
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <StatusIcon
                  className={`h-4 w-4 ${statusConfig[status].className}`}
                />
                <span>
                  {e2e ? (
                    <>
                      <span className="text-foreground">
                        {scoringPassed}/{testsRan}
                      </span>{' '}
                      tests passing
                    </>
                  ) : (
                    'Tests pending'
                  )}
                </span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[200px]">
              <p className="text-xs">E2E Test Suite Coverage</p>
            </TooltipContent>
          </Tooltip>

          {/* Benchmarks - show PERF time as summary */}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href="#testing"
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Timer
                  className={`h-4 w-4 ${world.benchmark10SeqMs !== null ? 'text-purple-500' : ''}`}
                />
                <span>
                  {world.benchmark10SeqMs !== null ? (
                    <>
                      PERF:{' '}
                      <span className="text-foreground">
                        {(world.benchmark10SeqMs / 1000).toFixed(2)}s
                      </span>
                    </>
                  ) : benchmarkCount > 0 ? (
                    `${benchmarkCount} benchmarks`
                  ) : (
                    'Benchmarks pending'
                  )}
                </span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[260px]">
              <p className="text-xs">
                Avg time to run a 10 step workflow where each step sleeps 1
                second
              </p>
            </TooltipContent>
          </Tooltip>

          {/* NPM Package */}
          <a
            href={`https://www.npmjs.com/package/${world.package}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Package className="h-4 w-4" />
            <span>npm</span>
          </a>

          {/* GitHub */}
          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="h-4 w-4" />
              <span>Source</span>
            </a>
          )}

          {/* Example */}
          {world.example && (
            <a
              href={world.example}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Code className="h-4 w-4" />
              <span>Example</span>
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
