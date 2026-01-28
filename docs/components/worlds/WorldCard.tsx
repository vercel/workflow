'use client';

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLinkIcon,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { World } from './types';

interface WorldCardProps {
  id: string;
  world: World;
}

const statusConfig = {
  passing: {
    label: 'Passing',
    icon: CheckCircle2,
    variant: 'default' as const,
    className: 'bg-green-500/10 text-green-600 border-green-500/20',
  },
  partial: {
    label: 'Partial',
    icon: AlertCircle,
    variant: 'secondary' as const,
    className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  },
  failing: {
    label: 'Failing',
    icon: XCircle,
    variant: 'destructive' as const,
    className: 'bg-red-500/10 text-red-600 border-red-500/20',
  },
  pending: {
    label: 'Pending',
    icon: Clock,
    variant: 'outline' as const,
    className: 'bg-muted text-muted-foreground',
  },
};

const typeEmoji = {
  official: '',
  community: '',
};

export function WorldCard({ id, world }: WorldCardProps) {
  const e2eStatus = world.e2e?.status || 'pending';
  const config = statusConfig[e2eStatus];
  const StatusIcon = config.icon;

  const isExternal = world.docs.startsWith('http');

  // Calculate E2E progress excluding skipped tests from denominator
  // so pass rate reflects actual test results (not artificially lowered by skips)
  const effectiveTotal = world.e2e ? world.e2e.total - world.e2e.skipped : 0;
  const displayProgress =
    effectiveTotal > 0 && world.e2e
      ? Math.round((world.e2e.passed / effectiveTotal) * 100)
      : 0;

  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <span>
                {typeEmoji[world.type]}
                {world.name}
              </span>
              {world.type === 'official' && (
                <Badge variant="outline" className="text-xs font-normal">
                  Official
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs font-mono">
              {world.package}
            </CardDescription>
          </div>
          <Badge className={cn('gap-1', config.className)}>
            <StatusIcon className="h-3 w-3" />
            {config.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground line-clamp-2">
          {world.description}
        </p>

        {/* E2E Progress */}
        {world.e2e && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">E2E Tests</span>
              <span className="font-medium">
                {world.e2e.passed}/{effectiveTotal} ({displayProgress}%)
              </span>
            </div>
            <Progress
              value={displayProgress}
              className={cn(
                'h-2',
                displayProgress === 100
                  ? '[&>div]:bg-green-500'
                  : displayProgress >= 75
                    ? '[&>div]:bg-yellow-500'
                    : '[&>div]:bg-red-500'
              )}
            />
            {world.e2e.failed > 0 && (
              <p className="text-xs text-muted-foreground">
                {world.e2e.failed} failing, {world.e2e.skipped} skipped
              </p>
            )}
          </div>
        )}

        {/* Links */}
        <div className="flex items-center gap-2 pt-2">
          <Link
            href={world.docs}
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noopener noreferrer' : undefined}
            className="text-sm text-primary hover:underline inline-flex items-center gap-1"
          >
            Documentation
            {isExternal && <ExternalLinkIcon className="h-3 w-3" />}
          </Link>
          {world.repository && (
            <>
              <span className="text-muted-foreground">·</span>
              <Link
                href={world.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline inline-flex items-center gap-1"
              >
                Repository
                <ExternalLinkIcon className="h-3 w-3" />
              </Link>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
