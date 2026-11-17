'use client';

import { Info } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { SearchInput } from '../ui/search-input';

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
      <SearchInput
        name="event-list-search"
        label="Search events"
        placeholder="Search by step ID, wait ID, hook ID, or event ID…"
        aria-describedby={hintId}
        value={query}
        onValueChange={onQueryChange}
        className="pl-[34px]"
      />
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
