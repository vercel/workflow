'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SelectionBarProps {
  /** Number of selected items */
  selectionCount: number;
  /** Callback to clear selection */
  onClearSelection: () => void;
  /** Optional action buttons to render */
  actions?: ReactNode;
  /** Label for what type of items are selected (e.g., "runs", "hooks") */
  itemLabel?: string;
  /** Additional className */
  className?: string;
}

/**
 * A floating bar that appears when items are selected in a table.
 * Shows selection count and provides actions for bulk operations.
 */
export function SelectionBar({
  selectionCount,
  onClearSelection,
  actions,
  itemLabel = 'items',
  className,
}: SelectionBarProps) {
  if (selectionCount === 0) {
    return null;
  }

  const label = selectionCount === 1 ? itemLabel.replace(/s$/, '') : itemLabel;

  return (
    <div
      className={cn(
        'fixed bottom-6 left-1/2 -translate-x-1/2 z-50',
        'flex items-center gap-3 px-4 py-2.5 rounded-lg',
        'bg-primary text-primary-foreground shadow-lg',
        'animate-in fade-in slide-in-from-bottom-4 duration-200',
        className
      )}
    >
      <span className="text-sm font-medium">
        {selectionCount} {label} selected
      </span>

      {actions && (
        <div className="flex items-center gap-2 border-l border-primary-foreground/20 pl-3">
          {actions}
        </div>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
        onClick={onClearSelection}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Clear selection</span>
      </Button>
    </div>
  );
}
