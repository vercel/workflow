'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Check, Copy } from 'lucide-react';
import { type JSX, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { iconButtonVariants } from './icon-button';

const COPIED_FEEDBACK_MS = 1000;

const copyButtonVariants = cva('[&_svg]:size-3.5', {
  variants: {
    variant: {
      /** Borderless, for rows and section headers. */
      ghost: '',
      /** Boxed, for floating over a code or data block. */
      outline:
        'bg-background-100 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)] enabled:hover:bg-gray-100',
    },
  },
  defaultVariants: { variant: 'ghost' },
});

interface CopyButtonProps extends VariantProps<typeof copyButtonVariants> {
  copyText: string;
  ariaLabel: string;
  className?: string;
}

/**
 * Icon button that copies `copyText` to the clipboard and briefly swaps its
 * icon for a check mark. Clicks don't propagate, so it is safe inside a
 * clickable row.
 */
export function CopyButton({
  copyText,
  ariaLabel,
  variant,
  className,
}: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : ariaLabel}
      className={cn(
        iconButtonVariants({ size: 'tiny' }),
        copyButtonVariants({ variant }),
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        navigator.clipboard.writeText(copyText).then(
          () => {
            setCopied(true);
            timeoutRef.current = setTimeout(
              () => setCopied(false),
              COPIED_FEEDBACK_MS
            );
          },
          () => {
            // Clipboard access can be denied (permissions, insecure context).
            // Leave the icon unchanged rather than claim a copy happened.
          }
        );
      }}
    >
      <span className="relative size-3.5">
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
            copied ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
          )}
        >
          <Check aria-hidden />
        </span>
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
            copied ? 'scale-0 opacity-0' : 'scale-100 opacity-100'
          )}
        >
          <Copy aria-hidden />
        </span>
      </span>
    </button>
  );
}
