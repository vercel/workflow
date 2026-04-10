'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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

type ActiveFilter = Exclude<Filter, 'all'>;

const matchers: Record<ActiveFilter, (w: World) => boolean> = {
  vercel: (w) => w.type === 'official',
  community: (w) => w.type === 'community',
  compatible: (w) => w.e2e?.status === 'passing',
  encrypted: (w) => w.features.includes('encryption'),
};

export function WorldsFilteredGrid({ worlds }: WorldsFilteredGridProps) {
  const [active, setActive] = useState<Set<ActiveFilter>>(new Set());

  const toggle = (id: Filter) => {
    if (id === 'all') {
      setActive(new Set());
      return;
    }
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filtered = worlds.filter(([, world]) => {
    if (active.size === 0) return true;
    return [...active].every((f) => matchers[f](world));
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
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-3">
          {filters.map(({ id, label }) => {
            const checked =
              id === 'all' ? active.size === 0 : active.has(id as ActiveFilter);
            return (
              <button
                key={id}
                type="button"
                className="flex items-center gap-2 cursor-pointer"
                onClick={() => toggle(id)}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(id)}
                  id={`filter-${id}`}
                />
                <Label
                  htmlFor={`filter-${id}`}
                  className="text-sm cursor-pointer select-none font-normal"
                >
                  {label}
                </Label>
              </button>
            );
          })}
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
