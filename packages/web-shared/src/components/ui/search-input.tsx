'use client';

import { Search, X } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useRef } from 'react';
import { cn } from '../../lib/cn';
import { Kbd } from './kbd';

export type SearchInputProps = Omit<
  ComponentProps<'input'>,
  'value' | 'onChange' | 'type' | 'size' | 'className' | 'aria-label'
> & {
  /** The current query. */
  value: string;
  /** Called with the new query, and with `''` when the search is cleared. */
  onValueChange: (value: string) => void;
  /** Accessible name of the field, rendered as a visually hidden label. */
  label: string;
  /** Classes for the bar, such as its left padding. */
  className?: string;
};

/**
 * The search bar at the top of a list or trace pane: a search icon, the
 * field, and a clear button that shows while there is a query. Escape clears
 * a non-empty query. The whole bar shows Geist's focus outline while the
 * field has focus.
 */
export function SearchInput({
  value,
  onValueChange,
  label,
  className,
  id,
  onKeyDown,
  ...props
}: SearchInputProps): ReactNode {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputRef = useRef<HTMLInputElement>(null);

  const clear = () => {
    onValueChange('');
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn(
        '@container flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100 pr-2',
        // Geist's focus outline token; the fallback is its value, for hosts
        // that only define `--ds-focus-color`.
        'has-[input:focus-visible]:[outline:var(--ds-focus-ring-outline,2px_solid_var(--ds-focus-color))] has-[input:focus-visible]:-outline-offset-2',
        className
      )}
    >
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Search aria-hidden className="size-3.5 shrink-0 text-gray-800" />
      <input
        {...props}
        ref={inputRef}
        id={inputId}
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onValueChange('');
          }
        }}
        className="min-w-0 flex-1 appearance-none bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-800 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className={cn(
            '-mr-2 flex h-full shrink-0 cursor-pointer items-center rounded-r-md border-0 bg-transparent px-2.5 text-gray-900 transition-colors duration-150 ease-in hover:text-gray-1000',
            'focus-visible:[outline:var(--ds-focus-ring-outline,2px_solid_var(--ds-focus-color))] focus-visible:-outline-offset-2'
          )}
        >
          {/* A narrow bar shows a compact icon instead of the Esc hint. */}
          <X aria-hidden className="size-3.5 @min-[320px]:hidden" />
          <Kbd
            aria-hidden
            variant="outline"
            size="search"
            className="hidden @min-[320px]:inline-flex"
          >
            Esc
          </Kbd>
        </button>
      ) : null}
    </div>
  );
}
