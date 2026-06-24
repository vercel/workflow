'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useContext,
  useState,
} from 'react';
import { cn } from '../../lib/cn';

type CollapsibleVariant = 'section' | 'card';

type CollapsibleContextValue = {
  variant: CollapsibleVariant;
  disabled: boolean;
};

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext(part: string): CollapsibleContextValue {
  const context = useContext(CollapsibleContext);
  if (!context) {
    throw new Error(
      `<Collapsible${part}> must be rendered inside <CollapsibleRoot>`
    );
  }
  return context;
}

type CollapsibleRootProps = {
  children: ReactNode;
  variant?: CollapsibleVariant;
  disabled?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/**
 * Low-level collapsible container. Use this together with `CollapsibleTrigger`
 * and `CollapsibleContent` when you need to override the styling of individual
 * parts. For the common case, prefer the all-in-one `Collapsible`.
 */
export function CollapsibleRoot({
  children,
  variant = 'section',
  disabled = false,
  defaultOpen = false,
  onOpenChange,
  className,
}: CollapsibleRootProps) {
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    // React bubbles the `toggle` event even though the native one doesn't, so
    // a nested <details> (e.g. an event card inside the Events section)
    // collapsing would otherwise flip this card. Only react to direct toggles.
    if (event.target !== event.currentTarget) return;
    const next = event.currentTarget.open;
    setOpen(next);
    onOpenChange?.(next);
  };

  const details = (
    <details
      data-slot="collapsible"
      data-state={open ? 'open' : 'closed'}
      open={open}
      onToggle={disabled ? undefined : handleToggle}
      className={cn(
        variant === 'card'
          ? 'group/card border-gray-alpha-400 last:border-b'
          : 'group',
        className
      )}
    >
      <CollapsibleContext.Provider value={{ variant, disabled }}>
        {children}
      </CollapsibleContext.Provider>
    </details>
  );

  if (variant === 'card') {
    return details;
  }

  return (
    <section className="-mx-4 border-t border-gray-alpha-400 px-4 py-2">
      {details}
    </section>
  );
}

type CollapsibleTriggerProps = {
  children: ReactNode;
  className?: string;
};

/** The clickable header of a `CollapsibleRoot`. */
export function CollapsibleTrigger({
  children,
  className,
}: CollapsibleTriggerProps) {
  const { variant, disabled } = useCollapsibleContext('Trigger');

  if (variant === 'card') {
    return (
      <summary
        data-slot="collapsible-trigger"
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 border-t border-gray-alpha-400 bg-background-200 px-3 py-4 hover:bg-gray-100 [&::-webkit-details-marker]:hidden',
          className
        )}
      >
        <ChevronRight
          size={14}
          className="shrink-0 text-gray-700 group-hover/card:text-gray-1000 group-open/card:rotate-90"
        />
        {children}
      </summary>
    );
  }

  // Shared row metrics keep every header the same height regardless of variant.
  const row =
    'flex h-9 items-center gap-2 -mx-2 px-2 text-heading-14 font-medium list-none [&::-webkit-details-marker]:hidden';

  if (disabled) {
    return (
      <summary
        data-slot="collapsible-trigger"
        className={cn(row, 'pointer-events-none text-gray-700', className)}
      >
        <span className="min-w-0 flex-1">{children}</span>
      </summary>
    );
  }

  return (
    <summary
      data-slot="collapsible-trigger"
      className={cn(
        row,
        'group/trigger cursor-pointer rounded hover:bg-gray-alpha-100',
        className
      )}
    >
      <span className="relative isolate h-3.5 w-3.5 shrink-0 text-gray-700 group-hover/trigger:text-gray-1000">
        <ChevronRight
          size={14}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-100 group-open:opacity-0"
        />
        <ChevronDown
          size={14}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-open:opacity-100"
        />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </summary>
  );
}

type CollapsibleContentProps = {
  children: ReactNode;
  className?: string;
};

/** The collapsible body of a `CollapsibleRoot`. */
export function CollapsibleContent({
  children,
  className,
}: CollapsibleContentProps) {
  const { variant } = useCollapsibleContext('Content');
  return (
    <div
      data-slot="collapsible-content"
      className={cn(variant === 'section' && 'mt-2 mb-3', className)}
    >
      {children}
    </div>
  );
}

type CollapsibleProps = {
  /** Header content shown in the trigger row. */
  label: ReactNode;
  /** Body content. Omit for a header-only (e.g. disabled or skeleton) row. */
  children?: ReactNode;
  disabled?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * All-in-one collapsible section: a labeled header plus body content. This is
 * the component to reach for in most cases. When you need to override the
 * styling of a specific part, compose `CollapsibleRoot`, `CollapsibleTrigger`,
 * and `CollapsibleContent` directly instead.
 */
export function Collapsible({
  label,
  children,
  disabled,
  defaultOpen,
  onOpenChange,
}: CollapsibleProps) {
  return (
    <CollapsibleRoot
      disabled={disabled}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <CollapsibleTrigger>{label}</CollapsibleTrigger>
      {children != null && <CollapsibleContent>{children}</CollapsibleContent>}
    </CollapsibleRoot>
  );
}
