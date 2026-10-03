'use client';

import { Tooltip } from '@vercel/geistdocs/components/tooltip';
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
import type { World } from './types';

interface WorldCardSimpleProps {
  id: string;
  world: World;
}

export function WorldCardSimple({ id, world }: WorldCardSimpleProps) {
  return (
    <Link href={`/worlds/${id}`} className="block group">
      <Card className="h-full transition-colors cursor-pointer overflow-hidden py-0! gap-2">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <CardTitle className="text-lg flex items-center gap-1.5 flex-wrap">
                <span className="truncate">{world.name}</span>
                {world.type === 'official' && (
                  <Tooltip
                    text="Maintained by Vercel"
                    position="top"
                    tabIndex={null}
                  >
                    <BadgeCheck
                      aria-hidden
                      className="size-4 text-gray-900 shrink-0"
                    />
                    <span className="sr-only">Maintained by Vercel</span>
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
        <div className="flex min-h-8 items-center justify-end px-4 pb-4 pt-2">
          {world.features.includes('encryption') && (
            <Tooltip
              text="End-to-end user data encryption"
              position="bottom"
              tabIndex={null}
            >
              <Badge className="bg-blue-300 text-blue-700 border-transparent">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Encrypted</span>
              </Badge>
            </Tooltip>
          )}
        </div>
      </Card>
    </Link>
  );
}
