'use client';

import { Input } from '@vercel/geistdocs/components/input';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { categoryLabels, patternTypeLabels } from '@/lib/patterns/manifest';
import type {
  RegistryCategory,
  RegistryItem,
  RegistryPatternType,
} from '@/lib/patterns/types';
import { RegistryCard } from './RegistryCard';

type Filter = 'all' | RegistryCategory;
type TypeFilter = 'all' | RegistryPatternType;

const PATTERN_TYPES: RegistryPatternType[] = [
  'component',
  'template',
  'example',
];

// Plural display labels for the type filter row.
const typeFilterLabels: Record<RegistryPatternType, string> = {
  component: 'Components',
  template: 'Templates',
  example: 'Examples',
};

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
    patternTypeLabels[item.patternType].toLowerCase().includes(q) ||
    item.versions.some((v) => v.toLowerCase() === q)
  );
}

interface FilterBadgeProps {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}

function FilterBadge({ label, count, active, onSelect }: FilterBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={`text-sm font-normal py-1 px-3 cursor-pointer select-none ${
        active ? 'bg-gray-1000 text-background-100 border-transparent' : ''
      }`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {label} ({count})
    </Badge>
  );
}

export function RegistryGrid({ items }: RegistryGridProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');

  const presentCategories = Array.from(
    new Set(items.flatMap((item) => item.categories))
  );

  const afterSearch = query.trim()
    ? items.filter((item) => matchesQuery(item, query.trim()))
    : items;

  const afterType =
    typeFilter === 'all'
      ? afterSearch
      : afterSearch.filter((item) => item.patternType === typeFilter);

  const filtered =
    filter === 'all'
      ? afterType
      : afterType.filter((item) => item.categories.includes(filter));

  const typeFilters: { id: TypeFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All types', count: afterSearch.length },
    ...PATTERN_TYPES.map((type) => ({
      id: type as TypeFilter,
      label: typeFilterLabels[type],
      count: afterSearch.filter((item) => item.patternType === type).length,
    })),
  ];

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'Show all', count: afterType.length },
    ...presentCategories.map((category) => ({
      id: category as Filter,
      label: categoryLabels[category],
      count: afterType.filter((item) => item.categories.includes(category))
        .length,
    })),
  ];

  return (
    <>
      {/* Type + category filters */}
      <div className="border-y px-4 py-6 space-y-4">
        <div className="flex flex-wrap justify-center gap-3">
          {typeFilters.map(({ id, label, count }) => (
            <FilterBadge
              key={id}
              label={label}
              count={count}
              active={typeFilter === id}
              onSelect={() => setTypeFilter(id)}
            />
          ))}
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {filters.map(({ id, label, count }) => (
            <FilterBadge
              key={id}
              label={label}
              count={count}
              active={filter === id}
              onSelect={() => setFilter(id)}
            />
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
              setTypeFilter('all');
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
