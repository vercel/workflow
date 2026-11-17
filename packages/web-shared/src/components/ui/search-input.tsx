'use client';

import { AlertCircle, Info, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { Kbd } from './kbd';

/** How long typing has to pause before the hint shows. */
const HINT_DELAY_MS = 500;

/**
 * The search bar at the top of a list: an input that Esc clears. A `hint`
 * shows under it once typing pauses; an `error` shows at once, with Try again.
 */
export function SearchInput({
  value,
  onChange,
  name,
  placeholder,
  'aria-label': ariaLabel,
  hint = null,
  error = null,
  onRetry,
  insetClassName = 'pl-4',
}: {
  value: string;
  onChange: (value: string) => void;
  name: string;
  placeholder: string;
  'aria-label': string;
  hint?: string | null;
  error?: string | null;
  onRetry?: () => void;
  /** Left inset of the bar and the hint, so the icons line up. */
  insetClassName?: string;
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
  }, [hint, value]);

  return (
    <div className="shrink-0">
      <div
        className={cn(
          'flex h-10 min-h-10 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100 pr-2',
          insetClassName
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-gray-800" />
        <input
          type="text"
          name={name}
          aria-label={ariaLabel}
          aria-describedby={hintId}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault();
              e.stopPropagation();
              onChange('');
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-800"
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange('')}
            className="-mr-2 hidden h-full max-w-full shrink-0 cursor-pointer items-center rounded-r-md border-0 bg-transparent px-2.5 font-inherit text-label-16 text-gray-900 no-underline transition-colors duration-150 ease-in hover:text-gray-1000 focus-visible:-outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ds-focus-color)] min-[961px]:flex"
          >
            <Kbd variant="outline" size="search">
              Esc
            </Kbd>
          </button>
        ) : null}
      </div>
      <div id={hintId} aria-live="polite">
        {error ? (
          <div
            className={cn(
              'flex h-8 items-center gap-1.5 bg-red-100 pr-2 text-label-13 text-red-900',
              insetClassName
            )}
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{error}</span>
            {onRetry ? (
              <Button
                variant="tertiary"
                size="tiny"
                className="ml-auto"
                onClick={onRetry}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : shownHint ? (
          <div
            className={cn(
              'flex h-8 items-center gap-1.5 bg-gray-100 pr-2 text-label-13 text-gray-1000',
              insetClassName
            )}
          >
            <Info className="h-3.5 w-3.5 shrink-0 text-gray-900" />
            <span className="min-w-0 truncate">{shownHint}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
