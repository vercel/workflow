'use client';

import {
  AlertCircle,
  BadgeCheck,
  Check,
  CheckCircle2,
  Clock,
  HeartHandshake,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Gauge } from '@/components/ui/gauge';
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
    className: 'bg-green-300 text-green-900',
  },
  partial: {
    label: 'Partial',
    icon: AlertCircle,
    className: 'bg-amber-300 text-amber-900',
  },
  failing: {
    label: 'Failing',
    icon: XCircle,
    className: 'bg-red-300 text-red-900',
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

  return (
    <Link href={`/worlds/${id}`} className="block group">
      <Card className="h-full transition-colors cursor-pointer overflow-hidden py-0! gap-2">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <CardTitle className="text-lg flex items-center gap-1.5 flex-wrap">
                <span className="truncate">{world.name}</span>
                {world.type === 'official' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <BadgeCheck className="size-4 text-gray-900 shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <span className="text-xs">Maintained by Vercel</span>
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
        <CardContent className="flex-1 px-4 pb-2">
          <p className="text-sm text-muted-foreground line-clamp-2">
            {world.description}
          </p>
        </CardContent>
        {/* Stats footer */}
        <div className="flex items-center justify-between px-4 pb-4 pt-2">
          {/* E2E with gauge */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 text-sm">
                <Gauge
                  value={world.e2e ? displayProgress : 0}
                  size="tiny"
                  colors={
                    !world.e2e
                      ? { primary: 'var(--ds-gray-alpha-400)' }
                      : displayProgress >= 75
                        ? { primary: 'var(--ds-green-700)' }
                        : displayProgress >= 50
                          ? { primary: 'var(--ds-amber-700)' }
                          : { primary: 'var(--ds-red-700)' }
                  }
                />
                <span className="font-normal text-gray-1000">
                  E2E:{` `}
                  <span className="font-mono font-normal">
                    {world.e2e ? `${displayProgress}%` : '—'}
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[200px]">
              <p className="text-xs">E2E Test Suite Coverage</p>
            </TooltipContent>
          </Tooltip>
          {/* Encryption badge */}
          {world.features.includes('encryption') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className="bg-blue-700 text-white border-transparent">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>Encrypted</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px]">
                <p className="text-xs">End-to-end user data encryption</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </Card>
    </Link>
  );
}
