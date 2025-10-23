'use client';

import { cva } from 'class-variance-authority';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

const itemVariants = cva('', {
  variants: {
    active: {
      true: 'bg-background text-foreground ring-1 ring-border',
      false: 'text-muted-foreground',
    },
  },
});

const full = [
  ['system', Monitor] as const,
  ['light', Sun] as const,
  ['dark', Moon] as const,
];

export function ThemeToggle({
  className,
  mode = 'light-dark',
  ...props
}: HTMLAttributes<HTMLElement> & {
  mode?: 'light-dark' | 'light-dark-system';
}) {
  const { theme, setTheme } = useTheme();

  const container = cn(
    'inline-flex items-center rounded-full border',
    className
  );

  return (
    <div className={container} data-theme-toggle="" {...props}>
      {full.map(([key, Icon]) => (
        <button
          className={cn(
            'size-8 rounded-full p-2 text-muted-foreground',
            itemVariants({ active: (theme ?? 'system') === key })
          )}
          key={key}
          onClick={() => setTheme(key)}
          type="button"
        >
          <Icon className="size-full" />
        </button>
      ))}
    </div>
  );
}
