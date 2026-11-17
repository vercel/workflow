'use client';

import { Search, X } from 'lucide-react';
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
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
 * field has keyboard focus.
 */
export function SearchInput({
  value,
  onValueChange,
  label,
  className,
  id,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: SearchInputProps): ReactNode {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputRef = useRef<HTMLInputElement>(null);

  // Text fields match `:focus-visible` however they were focused, clicks
  // included, so the bar tracks the last input instead and draws its outline
  // only when the field gains focus from the keyboard.
  const lastInputRef = useRef<'keyboard' | 'pointer'>('keyboard');
  const [focusVisible, setFocusVisible] = useState(false);

  useEffect(() => {
    const onPointerDown = () => {
      lastInputRef.current = 'pointer';
    };
    const onDocumentKeyDown = (e: KeyboardEvent) => {
      // Shortcuts such as Cmd+Tab don't move focus within the page.
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      lastInputRef.current = 'keyboard';
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
    };
  }, []);

  const clear = () => {
    onValueChange('');
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn(
        '@container flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100 pr-2',
        focusVisible &&
          '[outline:var(--ds-focus-ring-outline,2px_solid_var(--ds-focus-color))] -outline-offset-2',
        className
      )}
    >
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Search aria-hidden className="size-3.5 shrink-0 text-gray-700" />
      <input
        {...props}
        ref={inputRef}
        id={inputId}
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onFocus={(e) => {
          onFocus?.(e);
          setFocusVisible(lastInputRef.current === 'keyboard');
        }}
        onBlur={(e) => {
          onBlur?.(e);
          setFocusVisible(false);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onValueChange('');
          }
        }}
        className="min-w-0 flex-1 appearance-none bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-700 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
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
