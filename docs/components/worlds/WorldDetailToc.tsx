'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface TocItem {
  id: string;
  title: ReactNode;
}

interface WorldDetailTocProps {
  items: TocItem[];
}

export function WorldDetailToc({ items }: WorldDetailTocProps) {
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
      {
        rootMargin: '-80px 0px -80% 0px',
        threshold: 0,
      }
    );

    for (const item of items) {
      const element = document.getElementById(item.id);
      if (element) {
        observer.observe(element);
      }
    }

    return () => observer.disconnect();
  }, [items]);

  return (
    <nav className="space-y-1">
      <p className="font-medium text-sm mb-2">On this page</p>
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className={cn(
            'block text-sm py-1 border-l-2 pl-3 transition-colors',
            activeId === item.id
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
          )}
        >
          {item.title}
        </a>
      ))}
    </nav>
  );
}
