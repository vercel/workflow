'use client';

import { Info, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Kbd } from '../ui/kbd';

/** How long typing has to pause before the hint shows. */
const HINT_DELAY_MS = 500;

/** The events search box. */
export function EventListToolbar({
  query,
  hint,
  onQueryChange,
}: {
  query: string;
  hint: string | null;
  onQueryChange: (query: string) => void;
}) {
  const hintId = useId();
  const [shownHint, setShownHint] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each keystroke restarts the wait
  useEffect(() => {
    if (!hint) {
      setShownHint(null);
      return;
    }
    const timer = setTimeout(() => setShownHint(hint), HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hint, query]);
  return (
    <div className="shrink-0">
      <div className="flex h-10 min-h-10 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100 pl-[34px] pr-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-gray-800" />
        <input
          type="text"
          name="event-list-search"
          aria-label="Search events"
          aria-describedby={hintId}
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
          className="min-w-0 flex-1 bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-800"
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
      <div id={hintId} aria-live="polite">
        {shownHint ? (
          <div className="flex h-8 items-center gap-1.5 bg-gray-100 pl-[34px] pr-2 text-label-13 text-gray-1000">
            <Info className="h-3.5 w-3.5 shrink-0 text-gray-900" />
            <span className="min-w-0 truncate">{shownHint}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
