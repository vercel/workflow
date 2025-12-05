'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CopyableTextProps {
  text: string;
  children: React.ReactNode;
  className?: string;
  /** If true, the copy button overlaps the text on the right */
  overlay?: boolean;
}

export function CopyableText({
  text,
  children,
  className,
  overlay,
}: CopyableTextProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  if (overlay) {
    return (
      <span className={cn('relative group/copy inline-block', className)}>
        {children}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCopy}
              className="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/copy:opacity-100 transition-opacity bg-background/80 backdrop-blur-sm p-1 rounded"
              aria-label="Copy to clipboard"
            >
              {copied ? (
                <Check className="h-3 w-3 text-muted-foreground" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{copied ? 'Copied!' : 'Copy to clipboard'}</p>
          </TooltipContent>
        </Tooltip>
      </span>
    );
  }

  return (
    <div className={cn('flex items-center gap-2 group', className)}>
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Copy to clipboard"
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-600" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{copied ? 'Copied!' : 'Copy to clipboard'}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
