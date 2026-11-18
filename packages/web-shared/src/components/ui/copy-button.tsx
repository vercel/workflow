'use client';

import { Check, Copy } from 'lucide-react';
import {
  forwardRef,
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { useToast } from '../../lib/toast';
import { IconButton, type IconButtonProps } from './icon-button';
import { Spinner } from './spinner';

export type CopyButtonProps = Omit<IconButtonProps, 'children'> & {
  textToCopy: string | (() => Promise<string>);
};

const icon =
  '[grid-area:1/1] transition-[opacity,scale] duration-200 ease-in-out';

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ textToCopy, onClick, ...props }, ref) => {
    const toast = useToast();
    const [state, setState] = useState<'idle' | 'pending' | 'copied'>('idle');
    const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => () => clearTimeout(timeoutRef.current), []);

    const copy = async (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClick?.(e);
      if (state === 'pending') return;
      clearTimeout(timeoutRef.current);
      try {
        let text = textToCopy;
        if (typeof text === 'function') {
          setState('pending');
          text = await text();
        }
        await navigator.clipboard.writeText(text);
        setState('copied');
        timeoutRef.current = setTimeout(() => setState('idle'), 1000);
      } catch {
        setState('idle');
        toast.error('Failed to copy to clipboard');
      }
    };

    const copied = state === 'copied';
    return (
      <IconButton
        ref={ref}
        aria-busy={state === 'pending' || undefined}
        onClick={copy}
        {...props}
      >
        {state === 'pending' ? (
          <Spinner size="sm" />
        ) : (
          <span className="grid">
            <Check
              className={cn(
                icon,
                copied ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
              )}
            />
            <Copy
              className={cn(
                icon,
                copied ? 'scale-50 opacity-0' : 'scale-100 opacity-100'
              )}
            />
          </span>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: <output> is a form control */}
        <span role="status" className="sr-only">
          {copied ? 'Copied' : ''}
        </span>
      </IconButton>
    );
  }
);
CopyButton.displayName = 'CopyButton';
