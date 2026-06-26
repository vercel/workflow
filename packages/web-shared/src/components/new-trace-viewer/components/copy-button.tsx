'use client';

import { Check, Copy } from 'lucide-react';
import { type JSX, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/cn';

interface CopyButtonProps {
  copyText: string;
  ariaLabel: string;
  className?: string;
}

export function CopyButton({
  copyText,
  ariaLabel,
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
      aria-label={ariaLabel}
      className={cn(
        'cursor-pointer text-gray-800 hover:text-gray-1000 bg-transparent border-0 p-1 m-0',
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        void navigator.clipboard.writeText(copyText).then(() => {
          setCopied(true);
          timeoutRef.current = setTimeout(() => setCopied(false), 1000);
        });
      }}
    >
      <div className="relative w-3 h-3">
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-all duration-150 ease-out',
            copied ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
          )}
        >
          <Check className="w-3 h-3" />
        </div>
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-all duration-150 ease-out',
            copied ? 'scale-0 opacity-0' : 'scale-100 opacity-100'
          )}
        >
          <Copy className="w-3 h-3" />
        </div>
      </div>
    </button>
  );
}
