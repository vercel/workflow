'use client';

import { Search } from 'lucide-react';
import { Kbd } from '../ui/kbd';

export interface DecryptControl {
  onDecrypt: () => void;
  /** Whether the encryption key is currently being fetched. */
  isDecrypting: boolean;
  isDecryptDisabled: boolean;
  decryptDisabledReason?: string;
}

/** The events search box. */
export function EventListToolbar({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return (
    <div className="flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100 pl-[34px] pr-2">
      <Search className="h-3.5 w-3.5 shrink-0 text-gray-800" />
      <input
        type="text"
        name="event-list-search"
        aria-label="Search events"
        placeholder="Search by step ID, wait ID, hook ID, or event ID…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.preventDefault();
            e.stopPropagation();
            onQueryChange('');
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-800 disabled:cursor-not-allowed disabled:placeholder:text-gray-700"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onQueryChange('')}
          className="flex h-full shrink-0 cursor-pointer items-center border-0 bg-transparent px-1 text-gray-900 hover:text-gray-1000"
        >
          <Kbd variant="outline" size="search">
            Esc
          </Kbd>
        </button>
      ) : null}
    </div>
  );
}
