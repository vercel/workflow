'use client';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { Search } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { type ButtonProps, buttonVariants } from './ui/button';

interface SearchToggleProps
  extends Omit<ComponentProps<'button'>, 'color'>,
    ButtonProps {
  hideIfDisabled?: boolean;
}

export function SearchToggle({
  hideIfDisabled,
  size = 'icon-sm',
  color = 'ghost',
  ...props
}: SearchToggleProps) {
  const { setOpenSearch, enabled } = useSearchContext();
  if (hideIfDisabled && !enabled) return null;

  return (
    <button
      aria-label="Open Search"
      className={cn(
        buttonVariants({
          size,
          color,
        }),
        props.className
      )}
      data-search=""
      onClick={() => {
        setOpenSearch(true);
      }}
      type="button"
    >
      <Search className="size-4" />
    </button>
  );
}

export function LargeSearchToggle({
  hideIfDisabled,
  ...props
}: ComponentProps<'button'> & {
  hideIfDisabled?: boolean;
}) {
  const { enabled, hotKey, setOpenSearch } = useSearchContext();
  const { text } = useI18n();
  if (hideIfDisabled && !enabled) return null;

  return (
    <button
      data-search-full=""
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border p-1.5 ps-2 text-fd-muted-foreground text-sm transition-colors hover:text-fd-accent-foreground',
        props.className
      )}
      onClick={() => {
        setOpenSearch(true);
      }}
    >
      {text.search}...
      <div className="ms-auto inline-flex rounded-md border bg-background px-1">
        {hotKey.map((k, i) => (
          <kbd className="px-0.5" key={i}>
            {k.display}
          </kbd>
        ))}
      </div>
    </button>
  );
}
