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

export type CopyButtonProps = Omit<IconButtonProps, 'children'> & {
  textToCopy: string;
};

const icon =
  '[grid-area:1/1] transition-[opacity,scale] duration-200 ease-in-out';

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ textToCopy, onClick, ...props }, ref) => {
    const toast = useToast();
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => () => clearTimeout(timeoutRef.current), []);

    const copy = (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClick?.(e);
      clearTimeout(timeoutRef.current);
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          setCopied(true);
          timeoutRef.current = setTimeout(() => setCopied(false), 1000);
        })
        .catch(() => toast.error('Failed to copy to clipboard'));
    };

    return (
      <IconButton ref={ref} onClick={copy} {...props}>
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
        {/* biome-ignore lint/a11y/useSemanticElements: <output> is a form control */}
        <span role="status" className="sr-only">
          {copied ? 'Copied' : ''}
        </span>
      </IconButton>
    );
  }
);
CopyButton.displayName = 'CopyButton';
