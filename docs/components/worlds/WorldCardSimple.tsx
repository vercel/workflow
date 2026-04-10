'use client';

import { BadgeCheck, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Gauge } from '@/components/ui/gauge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { World } from './types';

interface WorldCardSimpleProps {
  id: string;
  world: World;
}

export function WorldCardSimple({ id, world }: WorldCardSimpleProps) {
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
                <Badge className="bg-blue-300 text-blue-700 border-transparent">
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
