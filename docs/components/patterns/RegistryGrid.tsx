'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { categoryLabels } from '@/lib/patterns/manifest';
import type { RegistryCategory, RegistryItem } from '@/lib/patterns/types';
import { RegistryCard } from './RegistryCard';

type Filter = 'all' | RegistryCategory;

interface RegistryGridProps {
  items: RegistryItem[];
}

function matchesQuery(item: RegistryItem, query: string): boolean {
  const q = query.toLowerCase();
  return (
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    (item.longDescription?.toLowerCase().includes(q) ?? false) ||
    item.tags.some((t) => t.toLowerCase().includes(q)) ||
    item.categories.some((c) => categoryLabels[c].toLowerCase().includes(q)) ||
    item.versions.some((v) => v.toLowerCase() === q)
  );
}

export function RegistryGrid({ items }: RegistryGridProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const presentCategories = Array.from(
    new Set(items.flatMap((item) => item.categories))
  );

  const afterSearch = query.trim()
    ? items.filter((item) => matchesQuery(item, query.trim()))
    : items;

  const filtered =
    filter === 'all'
      ? afterSearch
      : afterSearch.filter((item) => item.categories.includes(filter));

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'Show all', count: afterSearch.length },
    ...presentCategories.map((category) => ({
      id: category as Filter,
      label: categoryLabels[category],
      count: afterSearch.filter((item) => item.categories.includes(category))
        .length,
    })),
  ];

  return (
    <>
      {/* Category filters */}
      <div className="border-y px-4 py-6">
        <div className="flex flex-wrap justify-center gap-3">
          {filters.map(({ id, label, count }) => (
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
              {label} ({count})
            </Badge>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="Search patterns…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFilter('all');
            }}
            className="pl-9"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">
          No patterns match
          {query.trim() ? ` "${query.trim()}"` : ' this filter'}.
        </p>
      ) : (
        <section className="px-4 py-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((item) => (
              <RegistryCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
