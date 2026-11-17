'use client';

import { Lock, LockOpen } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { Spinner } from './spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

interface DecryptButtonProps {
  /** Whether an encryption key has been obtained (decryption is active). */
  decrypted?: boolean;
  /** Whether the key is currently being fetched. */
  loading?: boolean;
  /** Whether decryption is unavailable. */
  disabled?: boolean;
  /** Explains why decryption is unavailable. Shown in a tooltip. */
  disabledReason?: string;
  /** Called when the user clicks to initiate decryption. */
  onClick?: () => void;
  /** `small` (32px) for toolbars and banners, `tiny` (24px) inline in data. */
  size?: 'small' | 'tiny';
  className?: string;
}

/**
 * The one control for starting decryption of a run's data.
 *
 * - idle: "Decrypt" with a lock icon
 * - loading: a spinner replaces the icon and the button is disabled
 * - decrypted: "Decrypted" with an open lock, in the blue confirmation style
 * - unavailable: disabled, with `disabledReason` in a tooltip and exposed to
 *   assistive tech as the button's description
 *
 * Clicks don't propagate, so it is safe inside a clickable row or tree node.
 */
export function DecryptButton({
  decrypted = false,
  loading = false,
  disabled = false,
  disabledReason,
  onClick,
  size = 'small',
  className,
}: DecryptButtonProps) {
  const reasonId = useId();
  const iconSize = size === 'tiny' ? 12 : 14;

  if (decrypted) {
    return (
      <Button
        variant="secondary"
        size={size}
        disabled
        className={cn(
          'disabled:cursor-default disabled:bg-blue-100 disabled:text-blue-900 disabled:[--themed-border:_var(--ds-blue-400)] disabled:hover:bg-blue-100',
          className
        )}
      >
        <LockOpen aria-hidden />
        Decrypted
      </Button>
    );
  }

  const showReason = disabled && !!disabledReason;

  const button = (
    <Button
      variant="secondary"
      size={size}
      className={className}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-describedby={showReason ? reasonId : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {loading ? <Spinner size={iconSize} /> : <Lock aria-hidden />}
      Decrypt
    </Button>
  );

  if (!showReason) {
    return button;
  }

  // A disabled <button> gets no pointer or focus events, so the tooltip
  // hangs off a focusable wrapper.
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: lets keyboard users reach the reason */}
          <span tabIndex={0} className="inline-flex rounded-md align-middle">
            {button}
            <span id={reasonId} className="sr-only">
              {disabledReason}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
