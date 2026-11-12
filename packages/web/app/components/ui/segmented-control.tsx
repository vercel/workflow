import type * as React from 'react';
import { cn } from '~/lib/utils';

interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; icon: React.ReactNode; label?: string }>;
  className?: string;
}

export function SegmentedControl({
  value,
  onValueChange,
  options,
  className,
}: SegmentedControlProps) {
  return (
    <div
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onValueChange(option.value)}
          className={cn(
            'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:text-gray-700',
            value === option.value
              ? 'bg-background text-foreground shadow'
              : 'hover:bg-gray-alpha-200'
          )}
        >
          {option.icon}
          {option.label && <span className="ml-2">{option.label}</span>}
        </button>
      ))}
    </div>
  );
}
