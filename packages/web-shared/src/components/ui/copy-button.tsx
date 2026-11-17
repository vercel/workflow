'use client';

import { Check, Copy, X } from 'lucide-react';
import {
  type JSX,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { useToast } from '../../lib/toast';
import { Button, type ButtonProps } from './button';
import { Spinner } from './spinner';

/** How long the copied (or failed) state shows before the copy icon returns. */
const RESET_MS = 1000;

type CopyState = 'idle' | 'pending' | 'copied' | 'failed';

export interface CopyButtonProps {
  /**
   * Text to copy. Pass a function to resolve it on click, e.g. a secret that
   * is fetched only when the user asks for it; the button shows a spinner
   * while the promise is pending.
   */
  text: string | (() => string | Promise<string>);
  /** Accessible name of the button. Defaults to `Copy to clipboard`. */
  label?: string;
  /** Announcement after a successful copy. Defaults to `Copied`. */
  copiedLabel?: string;
  /**
   * `tertiary` (default) for a borderless button inline with text,
   * `secondary` for a filled, bordered button laid over content, `default`
   * on an inverted surface such as a tooltip.
   */
  variant?: ButtonProps['variant'];
  /** `tiny` (default) is 24px with a 12px icon, `small` is 32px with 16px. */
  size?: 'tiny' | 'small';
  disabled?: boolean;
  /** Called after the text is on the clipboard. */
  onCopy?: () => void;
  /** Called when copying fails. Replaces the default error toast. */
  onCopyError?: (error: unknown) => void;
  /** Layout only (position, margin). Appearance comes from `variant` and `size`. */
  className?: string;
}

/**
 * Icon button that copies text to the clipboard: the icon swaps to a check
 * for one second, a failure shows an error toast, and a polite live region
 * announces the result.
 */
export function CopyButton({
  text,
  label = 'Copy to clipboard',
  copiedLabel = 'Copied',
  variant = 'tertiary',
  size = 'tiny',
  disabled,
  onCopy,
  onCopyError,
  className,
}: CopyButtonProps): JSX.Element {
  const toast = useToast();
  const [state, setState] = useState<CopyState>('idle');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const settle = useCallback((next: 'copied' | 'failed') => {
    if (!mountedRef.current) return;
    setState(next);
    timeoutRef.current = setTimeout(() => setState('idle'), RESET_MS);
  }, []);

  const handleClick = async (e: MouseEvent<HTMLButtonElement>) => {
    // Copy buttons sit in clickable rows and headers; a copy is not a select.
    e.stopPropagation();
    if (state === 'pending') return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      let value: string;
      if (typeof text === 'function') {
        setState('pending');
        value = await text();
      } else {
        value = text;
      }
      await navigator.clipboard.writeText(value);
      settle('copied');
      onCopy?.();
    } catch (error) {
      settle('failed');
      if (onCopyError) {
        onCopyError(error);
      } else {
        toast.error('Failed to copy to clipboard');
      }
    }
  };

  const announcement =
    state === 'copied'
      ? copiedLabel
      : state === 'failed'
        ? 'Failed to copy to clipboard'
        : '';

  return (
    <Button
      variant={variant}
      size={size}
      shape="square"
      aria-label={label}
      aria-busy={state === 'pending' || undefined}
      disabled={disabled}
      onClick={handleClick}
      className={className}
    >
      <span className="grid place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
        {state === 'pending' ? (
          <Spinner size={size === 'small' ? 16 : 12} />
        ) : (
          <>
            <SwapIcon visible={state === 'idle'}>
              <Copy aria-hidden />
            </SwapIcon>
            <SwapIcon visible={state === 'copied'}>
              <Check aria-hidden />
            </SwapIcon>
            <SwapIcon visible={state === 'failed'}>
              <X aria-hidden />
            </SwapIcon>
          </>
        )}
      </span>
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
    </Button>
  );
}

function SwapIcon({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'flex transition-[opacity,scale,transform] duration-150 ease-out motion-reduce:transition-none',
        visible ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
      )}
    >
      {children}
    </span>
  );
}

export interface TextWithCopyButtonProps
  extends Pick<
    CopyButtonProps,
    'text' | 'label' | 'copiedLabel' | 'onCopy' | 'onCopyError'
  > {
  /** The visible text. */
  children: ReactNode;
  /**
   * Lay the button over the right end of the text instead of after it, for
   * table cells where the text fills the column. Defaults to `false`.
   */
  overlay?: boolean;
  /** Layout of the wrapper. */
  className?: string;
}

/**
 * Text with a copy button that appears on hover and whenever the button has
 * keyboard focus, and stays visible on touch screens, which cannot hover.
 */
export function TextWithCopyButton({
  children,
  overlay = false,
  className,
  ...copyProps
}: TextWithCopyButtonProps): JSX.Element {
  const revealClassName =
    'opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 [@media(hover:none)]:opacity-100';

  if (overlay) {
    return (
      <span className={cn('group/copy relative inline-block', className)}>
        {children}
        <CopyButton
          {...copyProps}
          variant="secondary"
          className={cn(
            'absolute top-1/2 right-0 -translate-y-1/2',
            revealClassName
          )}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('group/copy inline-flex items-center gap-1', className)}
    >
      {children}
      <CopyButton {...copyProps} className={revealClassName} />
    </span>
  );
}
