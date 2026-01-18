'use client';

import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function DocsLink() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="sm">
          <a
            href="https://useworkflow.dev/docs/observability"
            target="_blank"
            rel="noopener noreferrer"
            className="gap-1"
          >
            <span>Docs</span>
            <ArrowUpRight className="h-4 w-4" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open docs</TooltipContent>
    </Tooltip>
  );
}
