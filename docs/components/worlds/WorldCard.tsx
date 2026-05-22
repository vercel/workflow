'use client';

import { ExternalLinkIcon } from 'lucide-react';
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

interface WorldCardProps {
  id: string;
  world: World;
}

const typeEmoji = {
  official: '',
  community: '',
};

export function WorldCard({ world }: WorldCardProps) {
  const isExternal = world.docs.startsWith('http');

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
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground line-clamp-2">
          {world.description}
        </p>

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
