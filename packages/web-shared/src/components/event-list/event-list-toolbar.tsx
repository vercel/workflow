'use client';

import { SearchInput } from '../ui/search-input';

/** The events search box. */
export function EventListToolbar({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return (
    <SearchInput
      name="event-list-search"
      label="Search events"
      placeholder="Search by step ID, wait ID, hook ID, or event ID…"
      value={query}
      onValueChange={onQueryChange}
      className="pl-[34px]"
    />
  );
}
