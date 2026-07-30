'use client';

import { Button } from '@vercel/geistdocs/components/button';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface RegistryInstallTabsProps {
  /** Bare registry slug, e.g. `@workflow-sdk/resend`. */
  slug: string;
}

const COMMANDS: {
  id: string;
  label: string;
  command: (slug: string) => string;
}[] = [
  {
    id: 'pnpm',
    label: 'pnpm',
    command: (s) => `pnpm dlx shadcn@latest add ${s}`,
  },
  { id: 'npm', label: 'npm', command: (s) => `npx shadcn@latest add ${s}` },
  {
    id: 'yarn',
    label: 'yarn',
    command: (s) => `yarn dlx shadcn@latest add ${s}`,
  },
  { id: 'bun', label: 'bun', command: (s) => `bunx shadcn@latest add ${s}` },
];

const COPY_TIMEOUT = 2000;

export function RegistryInstallTabs({ slug }: RegistryInstallTabsProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (id: string, command: string) => {
    navigator.clipboard.writeText(command);
    toast.success('Copied to clipboard');
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), COPY_TIMEOUT);
  };

  return (
    <Tabs defaultValue="pnpm" className="w-full">
      <TabsList className="h-10 p-1">
        {COMMANDS.map(({ id, label }) => (
          <TabsTrigger key={id} value={id} className="px-3.5 py-1.5">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {COMMANDS.map(({ id, command }) => {
        const cmd = command(slug);
        const Icon = copiedId === id ? CheckIcon : CopyIcon;
        return (
          <TabsContent key={id} value={id}>
            <div className="relative bg-background border rounded-md overflow-hidden">
              <pre className="text-sm font-mono py-3 pl-4 pr-12 overflow-x-auto">
                <code>
                  <span className="text-muted-foreground select-none">$ </span>
                  {cmd}
                </code>
              </pre>
              <Button
                onClick={() => handleCopy(id, cmd)}
                size="icon"
                variant="ghost"
                aria-label="Copy command"
                className="absolute right-1 top-1/2 -translate-y-1/2"
              >
                <Icon className="size-4 text-muted-foreground" />
              </Button>
            </div>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
