'use client';

import { SiGithub } from '@icons-pack/react-simple-icons';
import { Separator } from '@vercel/geistdocs/components/separator';
import { AskAIButton } from '@vercel/geistdocs/controls';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import {
  ArrowUpCircleIcon,
  CheckIcon,
  CopyIcon,
  MessageCircleIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export interface RegistryTocItem {
  id: string;
  title: string;
  depth?: number;
}

interface RegistryDetailTocProps {
  items: RegistryTocItem[];
  pageText: string;
  href: string;
  githubPath?: string;
}

// Shared styling for the plain-text actions beneath the outline.
const ACTION_CLASS =
  'flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground';

function ScrollTop() {
  const handleScrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <button className={ACTION_CLASS} onClick={handleScrollToTop} type="button">
      <ArrowUpCircleIcon className="size-3.5" />
      <span>Scroll to top</span>
    </button>
  );
}

function CopyPage({ text }: { text: string }) {
  const [checked, handleCopy] = useCopyButton(async () => {
    await navigator.clipboard.writeText(text);
  });

  const Icon = checked ? CheckIcon : CopyIcon;

  return (
    <button className={ACTION_CLASS} onClick={handleCopy} type="button">
      <Icon className="size-3.5" />
      <span>Copy page</span>
    </button>
  );
}

export function RegistryDetailToc({
  items,
  pageText,
  href,
  githubPath,
}: RegistryDetailTocProps) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? '');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -80% 0px', threshold: 0 }
    );

    for (const item of items) {
      const element = document.getElementById(item.id);
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  const githubEditUrl = githubPath
    ? `https://github.com/vercel/workflow/edit/main/docs/lib/patterns/${githubPath}`
    : undefined;

  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const pageUrl = new URL(
    href,
    `${protocol}://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`
  ).toString();

  return (
    <div>
      <p className="font-medium text-sm mb-3">On this page</p>
      <nav className="space-y-0.5">
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={cn(
              'block text-sm py-1 border-l-2 transition-colors',
              item.depth === 3 ? 'pl-7' : 'pl-3',
              activeId === item.id
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            )}
          >
            {item.title}
          </a>
        ))}
      </nav>

      <div className="mt-6 space-y-3">
        <Separator />
        {githubEditUrl && (
          <a
            className={ACTION_CLASS}
            href={githubEditUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <SiGithub className="size-3.5" />
            <span>Edit this page on GitHub</span>
          </a>
        )}
        <ScrollTop />
        <CopyPage text={pageText} />
        <AskAIButton
          className={cn(ACTION_CLASS, 'h-auto p-0 shadow-none')}
          prompt={`Read this page, I want to ask questions about it. ${pageUrl}`}
          variant="link"
        >
          <MessageCircleIcon className="size-3.5" />
          <span>Ask AI about this page</span>
        </AskAIButton>
      </div>
    </div>
  );
}
