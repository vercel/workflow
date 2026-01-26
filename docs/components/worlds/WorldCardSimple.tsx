'use client';

import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  BadgeCheck,
  HeartHandshake,
  Timer,
} from 'lucide-react';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { World } from './types';

interface WorldCardSimpleProps {
  id: string;
  world: World;
}

const statusConfig = {
  passing: {
    label: 'Passing',
    icon: CheckCircle2,
    className: 'bg-green-500/10 text-green-600 border-green-500/20',
  },
  partial: {
    label: 'Partial',
    icon: AlertCircle,
    className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  },
  failing: {
    label: 'Failing',
    icon: XCircle,
    className: 'bg-red-500/10 text-red-600 border-red-500/20',
  },
  pending: {
    label: 'Pending',
    icon: Clock,
    className: 'bg-muted text-muted-foreground',
  },
};

export function WorldCardSimple({ id, world }: WorldCardSimpleProps) {
  const e2eStatus = world.e2e?.status || 'pending';
  const config = statusConfig[e2eStatus];
  const StatusIcon = config.icon;

  // Use nextjs-turbopack data for scoring if available, otherwise fall back to total
  const turbopackData = world.e2e?.nextjsTurbopack;

  // Calculate E2E progress based on nextjs-turbopack data (canonical scoring)
  // For framework data: passed + failed = tests that ran (excludes skipped)
  // If failed === 0, that's 100% passing
  const effectiveFailed = turbopackData
    ? turbopackData.failed
    : (world.e2e?.failed ?? 0);
  const effectivePassed = turbopackData
    ? turbopackData.passed
    : (world.e2e?.passed ?? 0);
  const effectiveTotal = effectivePassed + effectiveFailed;
  const displayProgress =
    effectiveTotal > 0
      ? Math.round((effectivePassed / effectiveTotal) * 100)
      : 0;

  // E2E color based on pass rate (muted)
  const e2eColorClass = !world.e2e
    ? 'text-muted-foreground'
    : displayProgress === 100
      ? 'text-green-600/70'
      : displayProgress >= 75
        ? 'text-yellow-600/70'
        : 'text-red-600/70';

  return (
    <Link href={`/worlds/${id}`} className="block group">
      <Card className="h-full transition-colors hover:border-foreground/20 cursor-pointer overflow-hidden flex flex-col !py-0 !gap-0">
        <CardHeader className="pt-6 pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <CardTitle className="text-lg flex items-center gap-1.5 flex-wrap">
                <span className="truncate">{world.name}</span>
                {world.type === 'official' ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <BadgeCheck className="h-5 w-5 text-blue-500 shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p className="text-xs">Maintained by Vercel</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HeartHandshake className="h-5 w-5 text-pink-500 shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p className="text-xs">Maintained by the community</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </CardTitle>
              <CardDescription className="text-xs font-mono truncate">
                {world.package}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 pt-4 pb-4">
          <p className="text-sm text-muted-foreground line-clamp-2">
            {world.description}
          </p>
        </CardContent>
        {/* Stats footer band */}
        <div className="grid grid-cols-2 border-t border-border/50 bg-muted/30">
          {/* E2E - left */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 px-4 py-2.5 text-sm border-r border-border/50">
                <StatusIcon className={cn('h-3.5 w-3.5', e2eColorClass)} />
                <span className="text-muted-foreground">E2E</span>
                <span className={cn('font-mono', e2eColorClass)}>
                  {world.e2e ? `${displayProgress}%` : '—'}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[200px]">
              <p className="text-xs">E2E Test Suite Coverage</p>
            </TooltipContent>
          </Tooltip>
          {/* PERF - right */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 px-4 py-2.5 text-sm">
                <Timer className="h-3.5 w-3.5 text-purple-500" />
                <span className="text-muted-foreground">PERF</span>
                <span className="font-mono text-foreground">
                  {world.benchmark10SeqMs !== null
                    ? `${(world.benchmark10SeqMs / 1000).toFixed(2)}s`
                    : '—'}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px]">
              <p className="text-xs">
                Avg time to run a 10 step workflow where each step sleeps 1
                second
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </Card>
    </Link>
  );
}
