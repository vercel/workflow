'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useContext,
  useState,
} from 'react';
import { cn } from '../../lib/utils';

type DetailCardVariant = 'section' | 'card';

type DetailCardContextValue = {
  variant: DetailCardVariant;
  disabled: boolean;
};

const DetailCardContext = createContext<DetailCardContextValue | null>(null);

function useDetailCardContext(part: string): DetailCardContextValue {
  const context = useContext(DetailCardContext);
  if (!context) {
    throw new Error(
      `<DetailCard.${part}> must be rendered inside <DetailCard>`
    );
  }
  return context;
}

type DetailCardProps = {
  children: ReactNode;
  variant?: DetailCardVariant;
  disabled?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/**
 * Collapsible section used throughout the run detail panel. Compose it with
 * `DetailCard.Trigger` (the header) and `DetailCard.Content` (the body):
 *
 * ```tsx
 * <DetailCard defaultOpen>
 *   <DetailCard.Trigger>Metadata</DetailCard.Trigger>
 *   <DetailCard.Content>...</DetailCard.Content>
 * </DetailCard>
 * ```
 */
function DetailCard({
  children,
  variant = 'section',
  disabled = false,
  defaultOpen = false,
  onOpenChange,
  className,
}: DetailCardProps) {
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
      data-slot="detail-card"
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
      <DetailCardContext.Provider value={{ variant, disabled }}>
        {children}
      </DetailCardContext.Provider>
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

type DetailCardTriggerProps = {
  children: ReactNode;
  className?: string;
};

function DetailCardTrigger({ children, className }: DetailCardTriggerProps) {
  const { variant, disabled } = useDetailCardContext('Trigger');

  if (variant === 'card') {
    return (
      <summary
        data-slot="detail-card-trigger"
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
        data-slot="detail-card-trigger"
        className={cn(row, 'pointer-events-none text-gray-700', className)}
      >
        <span className="min-w-0 flex-1">{children}</span>
      </summary>
    );
  }

  return (
    <summary
      data-slot="detail-card-trigger"
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

type DetailCardContentProps = {
  children: ReactNode;
  className?: string;
};

function DetailCardContent({ children, className }: DetailCardContentProps) {
  const { variant } = useDetailCardContext('Content');
  return (
    <div
      data-slot="detail-card-content"
      className={cn(variant === 'section' && 'mt-2 mb-3', className)}
    >
      {children}
    </div>
  );
}

const DetailCardNamespace = Object.assign(DetailCard, {
  Trigger: DetailCardTrigger,
  Content: DetailCardContent,
});

export { DetailCardNamespace as DetailCard };
