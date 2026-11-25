'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';
import { cn } from '../../lib/cn';

export const TOOLTIP_DELAY_MS = 400;

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  skipDelayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    showArrow?: boolean;
  }
>(({ className, sideOffset, showArrow = true, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      // Radix adds the arrow's height to the offset; either way the pill sits 10px from the trigger.
      sideOffset={sideOffset ?? (showArrow ? 4 : 10)}
      className={cn(
        'invert-theme z-[var(--ds-z-tooltip)] flex max-w-[250px] select-none items-center gap-1 rounded-lg bg-background-100 px-2 py-1.5 text-center font-normal text-[13px] leading-[1.3] text-balance text-gray-1000 break-words whitespace-pre-line has-[kbd]:pr-1.5',
        'transition-opacity duration-100 ease-in starting:opacity-0',
        className
      )}
      {...props}
    >
      {children}
      {showArrow ? (
        <TooltipPrimitive.Arrow width={14} height={6} asChild>
          <svg
            aria-hidden="true"
            viewBox="0 0 14 6"
            xmlns="http://www.w3.org/2000/svg"
            className="-translate-y-[0.6px]"
          >
            <path
              className="fill-background-100"
              d="M13.8284 0H0.17157C0.702003 0 1.21071 0.210714 1.58578 0.585787L5.58578 4.58579C6.36683 5.36684 7.63316 5.36683 8.41421 4.58579L12.4142 0.585786C12.7893 0.210714 13.298 0 13.8284 0Z"
            />
          </svg>
        </TooltipPrimitive.Arrow>
      ) : null}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
