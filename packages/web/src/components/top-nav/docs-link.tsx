'use client';

import { ArrowUpRight } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function DocsLink() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href="https://useworkflow.dev/docs/observability"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-accent transition-colors"
        >
          <span>Docs</span>
          <ArrowUpRight className="h-4 w-4" />
        </a>
      </TooltipTrigger>
      <TooltipContent>Open docs</TooltipContent>
    </Tooltip>
  );
}
