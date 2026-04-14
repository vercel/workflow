'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { World } from './types';
import { WorldCardSimple } from './WorldCardSimple';

type Filter = 'all' | 'vercel' | 'community' | 'compatible' | 'encrypted';

interface WorldsFilteredGridProps {
  worlds: [string, World][];
}

const managedIds = new Set(['vercel']);
const embeddedIds = new Set(['local', 'redis', 'turso']);

const sections = [
  {
    key: 'managed',
    title: 'Managed',
    description:
      'Production grade — zero configuration, high throughput, infinitely-scalable, e2e encrypted, and integrated observability',
    match: (id: string) => managedIds.has(id),
  },
  {
    key: 'self-hosted',
    title: 'Self-Hosted',
    description:
      'Self hosted — control your data and scaling while running workflows inside your own infrastructure',
    match: (id: string) => !managedIds.has(id) && !embeddedIds.has(id),
  },
  {
    key: 'embedded',
    title: 'Embedded',
    description: 'Lightweight solutions for sidecars or local development',
    match: (id: string) => embeddedIds.has(id),
  },
] as const;

export function WorldsFilteredGrid({ worlds }: WorldsFilteredGridProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = worlds.filter(([, world]) => {
    switch (filter) {
      case 'vercel':
        return world.type === 'official';
      case 'community':
        return world.type === 'community';
      case 'compatible':
        return world.e2e?.status === 'passing';
      case 'encrypted':
        return world.features?.includes('encryption');
      default:
        return true;
    }
  });

  const counts = {
    all: worlds.length,
    vercel: worlds.filter(([, w]) => w.type === 'official').length,
    community: worlds.filter(([, w]) => w.type === 'community').length,
    compatible: worlds.filter(([, w]) => w.e2e?.status === 'passing').length,
    encrypted: worlds.filter(([, w]) => w.features.includes('encryption'))
      .length,
  };

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: `Show all (${counts.all})` },
    { id: 'vercel', label: `By Vercel (${counts.vercel})` },
    { id: 'community', label: `By Community (${counts.community})` },
    { id: 'compatible', label: `Fully Compatible (${counts.compatible})` },
    { id: 'encrypted', label: `Encrypted (${counts.encrypted})` },
  ];

  return (
    <>
      <div className="border-y px-4 py-6">
        <div className="flex flex-wrap justify-center gap-3">
          {filters.map(({ id, label }) => (
            <Badge
              key={id}
              variant="outline"
              className={`text-sm font-normal py-1 px-3 cursor-pointer select-none ${
                filter === id
                  ? 'bg-gray-1000 text-background-100 border-transparent'
                  : ''
              }`}
              role="button"
              tabIndex={0}
              onClick={() => setFilter(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setFilter(id);
                }
              }}
            >
              {label}
            </Badge>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">
          No worlds match this filter.
        </p>
      ) : (
        sections.map(({ key, title, description, match }) => {
          const sectionWorlds = filtered.filter(([id]) => match(id));
          if (sectionWorlds.length === 0) return null;

          return (
            <section key={key} className="px-4 py-8">
              <div className="mb-4">
                <h2 className="font-semibold text-xl tracking-tight sm:text-2xl">
                  {title}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {description}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {sectionWorlds.map(([id, world]) => (
                  <WorldCardSimple key={id} id={id} world={world} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
