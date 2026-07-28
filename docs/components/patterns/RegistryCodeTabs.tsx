'use client';

import { Button } from '@vercel/geistdocs/components/button';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface CodeBlock {
  label: string;
  caption?: string;
  /** Optional prose shown between the caption and the code block. */
  description?: string;
  /** Raw source — used by the copy button. */
  code: string;
  /** Pre-rendered shiki HTML — generated on the server. */
  html: string;
}

interface RegistryCodeTabsProps {
  blocks: CodeBlock[];
}

const COPY_TIMEOUT = 2000;
// Roughly 18 lines at 1.5rem line-height before we collapse.
const COLLAPSED_MAX_H = '18rem';

export function RegistryCodeTabs({ blocks }: RegistryCodeTabsProps) {
  // Lifted so "View code" persists when switching tabs.
  const [expanded, setExpanded] = useState(false);

  if (blocks.length === 0) return null;

  return (
    <Tabs defaultValue={blocks[0].label} className="w-full">
      <TabsList className="h-10 gap-1 p-1">
        {blocks.map((b) => (
          <TabsTrigger
            key={b.label}
            value={b.label}
            className="flex-none px-3.5 py-1.5"
          >
            {b.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {blocks.map((b) => (
        <TabsContent key={b.label} value={b.label} className="space-y-2">
          {b.caption && (
            <p className="font-mono text-xs text-muted-foreground">
              {b.caption}
            </p>
          )}
          {b.description && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {b.description}
            </p>
          )}
          <BlockCode
            block={b}
            expanded={expanded}
            onExpand={() => setExpanded(true)}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function BlockCode({
  block,
  expanded,
  onExpand,
}: {
  block: CodeBlock;
  expanded: boolean;
  onExpand: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(block.code);
    toast.success('Copied to clipboard');
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_TIMEOUT);
  };

  return (
    <div className="relative overflow-hidden rounded-md border bg-background">
      {/* Copy button — always visible in the top-right corner */}
      <Button
        onClick={handleCopy}
        size="icon"
        variant="ghost"
        aria-label="Copy code"
        className="absolute right-2 top-2 z-20 size-7 text-muted-foreground hover:text-foreground"
      >
        {copied ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>

      {/* Code — capped height when collapsed */}
      <div
        style={expanded ? undefined : { maxHeight: COLLAPSED_MAX_H }}
        className="overflow-hidden text-sm [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-4"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki produces safe HTML
        dangerouslySetInnerHTML={{ __html: block.html }}
      />

      {/* Gradient + "View code" button when collapsed */}
      {!expanded && (
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-3 pt-16">
          <Button
            variant="outline"
            size="sm"
            onClick={onExpand}
            className="rounded-lg bg-background text-foreground shadow-sm hover:bg-muted border-border"
          >
            View code
          </Button>
        </div>
      )}
    </div>
  );
}
