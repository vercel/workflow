'use client';

import { CheckIcon, CopyIcon, ExternalLinkIcon, EyeIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type PreviewBadgeProps = {
  deploymentUrl: string;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      toast.error('Clipboard not available');
      return;
    }

    try {
      const writeResult = navigator.clipboard.writeText(text);

      Promise.resolve(writeResult)
        .then(() => {
          setCopied(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {
          toast.error('Failed to copy');
        });
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      onClick={handleCopy}
    >
      {copied ? (
        <CheckIcon className="size-3" />
      ) : (
        <CopyIcon className="size-3" />
      )}
      <span className="sr-only">Copy</span>
    </Button>
  );
}

export function PreviewBadge({ deploymentUrl }: PreviewBadgeProps) {
  const baseUrl = deploymentUrl.replace(/\/$/, '');
  const installCmd = `pnpm i ${baseUrl}/workflow.tgz`;
  const npxCmd = `npx workflow@${baseUrl}/workflow.tgz web`;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="cursor-pointer">
          <Badge
            variant="outline"
            className="gap-1.5 border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors dark:text-amber-400"
          >
            <EyeIcon className="size-3" />
            Preview
          </Badge>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Preview Deployment</DialogTitle>
          <DialogDescription>
            {"You're viewing a preview deployment. Helpful links:"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              Install the workflow package from this commit:
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
              <code className="flex-1 text-xs break-all font-mono">
                {installCmd}
              </code>
              <CopyButton text={installCmd} />
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              Run the web UI in your project:
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
              <code className="flex-1 text-xs break-all font-mono">
                {npxCmd}
              </code>
              <CopyButton text={npxCmd} />
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              SWC Compiler Playground:
            </p>
            <a
              href="https://workflow-swc-playground.labs.vercel.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-xs font-mono hover:bg-muted transition-colors"
            >
              <span className="flex-1">
                workflow-swc-playground.labs.vercel.dev
              </span>
              <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
