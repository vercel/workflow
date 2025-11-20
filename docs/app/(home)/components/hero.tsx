'use client';

import { track } from '@vercel/analytics';
import { CheckIcon, CopyIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type HeroProps = {
  title: string;
  description: string;
};

export const Hero = ({ title, description }: HeroProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText('npm install workflow');
      setCopied(true);
      track('Copy installer command');
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

  const Icon = copied ? CheckIcon : CopyIcon;

  return (
    <section className="mt-[var(--fd-nav-height)] space-y-6 px-4 pt-16 sm:pt-24 pb-16 text-center">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <Badge variant="secondary" className="rounded-full">
          <div className="size-2 rounded-full bg-muted-foreground" />
          <p>Workflow DevKit is in beta</p>
        </Badge>
        <h1 className="text-center font-semibold text-4xl leading-[1.1] tracking-tight lg:font-semibold sm:text-5xl! xl:text-6xl! text-balance">
          {title}
        </h1>
        <p className="text-balance max-w-3xl mx-auto text-muted-foreground sm:text-xl leading-relaxed">
          <span className="font-mono text-base bg-accent inline-block px-2 py-0 rounded-sm border border-border">
            use workflow
          </span>{' '}
          brings durability, reliability, and observability to async JavaScript.
          Build apps and AI Agents that can suspend, resume, and maintain state
          with ease.
        </p>
      </div>
      <div className="inline-flex w-fit mx-auto items-center gap-3">
        <Button asChild size="lg" className="h-[44px] text-base">
          <Link href="/docs/getting-started">Get Started</Link>
        </Button>
        <div className="relative bg-background border rounded-md overflow-hidden py-3 pl-4 pr-12 mx-auto inline-flex w-fit">
          <pre className="text-sm">
            <code>npm i workflow</code>
          </pre>
          <Button
            onClick={handleCopy}
            size="icon"
            variant="ghost"
            className="absolute right-1 top-1/2 -translate-y-1/2"
          >
            <Icon className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </section>
  );
};
