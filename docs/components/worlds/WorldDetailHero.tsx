'use client';

import {
  BadgeCheck,
  CheckIcon,
  ChevronRight,
  Code,
  CopyIcon,
  ExternalLink,
  Github,
  HeartHandshake,
  Package,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import type { World } from './types';

interface WorldDetailHeroProps {
  id: string;
  world: World;
}

export function WorldDetailHero({ id, world }: WorldDetailHeroProps) {
  const [copied, setCopied] = useState(false);

  const installCommand = `npm i ${world.package}`;

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to copy text to clipboard';
      toast.error(message);
    }
  };

  const CopyButtonIcon = copied ? CheckIcon : CopyIcon;

  // GitHub source URL for official worlds
  const githubUrl =
    world.repository ||
    (world.type === 'official'
      ? `https://github.com/vercel/workflow/tree/main/packages/world-${id}`
      : null);

  return (
    <section className="space-y-6 pt-8 sm:pt-12 pb-12 border-b">
      {/* Breadcrumbs */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/worlds">Worlds</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>
            <ChevronRight className="h-4 w-4" />
          </BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{world.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
        {/* Left side - Title and description */}
        <div className="space-y-4 min-w-0">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl flex items-center gap-4">
            {world.name}
            {world.type === 'official' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <BadgeCheck className="h-8 w-8 text-blue-900" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Maintained by Vercel</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <HeartHandshake className="h-8 w-8 text-pink-900" />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Maintained by the community</p>
                </TooltipContent>
              </Tooltip>
            )}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            {world.package}
          </p>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {world.description}
          </p>

          {/* Actions - Community worlds only */}
          {world.type === 'community' && (
            <div className="flex items-center gap-3 flex-wrap pt-2">
              <div className="relative bg-background border rounded-md overflow-hidden py-3 pl-4 pr-12 inline-flex">
                <pre className="text-sm">
                  <code>{installCommand}</code>
                </pre>
                <Button
                  onClick={handleCopy}
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                >
                  <CopyButtonIcon className="size-4 text-muted-foreground" />
                </Button>
              </div>
              {world.repository && (
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="h-[44px] text-base"
                >
                  <a
                    href={world.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2"
                  >
                    GitHub
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Right side - Quick links */}
        <div className="space-y-2 text-sm">
          {/* NPM Package */}
          <a
            href={`https://www.npmjs.com/package/${world.package}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Package className="h-4 w-4 shrink-0" />
            <span>npm</span>
          </a>

          {/* GitHub */}
          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="h-4 w-4 shrink-0" />
              <span>Source</span>
            </a>
          )}

          {/* Example */}
          {world.example && (
            <a
              href={world.example}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Code className="h-4 w-4 shrink-0" />
              <span>Example</span>
            </a>
          )}

          {/* Encryption */}
          {world.features.includes('encryption') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/docs/how-it-works/encryption"
                  className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ShieldCheck className="h-4 w-4 shrink-0 text-blue-900" />
                  <span>E2E Encrypted</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                className="max-w-[200px]"
              >
                <p className="text-xs">
                  User data is encrypted end-to-end in the event log
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </section>
  );
}
