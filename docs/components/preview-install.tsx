'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

export function PreviewInstall({ deploymentUrl }: { deploymentUrl: string }) {
  const baseUrl = deploymentUrl.replace(/\/$/, '');
  const installCmd = `pnpm i ${baseUrl}/workflow.tgz`;
  const npxCmd = `npx workflow@${baseUrl}/workflow.tgz web`;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          Install the workflow package from this preview:
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
          <code className="flex-1 text-xs break-all font-mono">{npxCmd}</code>
          <CopyButton text={npxCmd} />
        </div>
      </div>
    </div>
  );
}
