'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';
import { cn } from '../../lib/cn';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    showArrow?: boolean;
    /**
     * Render into `document.body`. Turn it off inside a menu: menus sit in the
     * browser's top layer, which a portaled tooltip can't rise above.
     */
    portal?: boolean;
  }
>(
  (
    {
      className,
      sideOffset = 8,
      showArrow = true,
      portal = true,
      children,
      ...props
    },
    ref
  ) => {
    const content = (
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-[99999] flex items-center gap-1 rounded-[10px] bg-gray-1000 px-2 py-1.5 !text-label-13 text-background-100 shadow-md select-none',
          className
        )}
        {...props}
      >
        {children}
        {showArrow ? (
          <TooltipPrimitive.Arrow
            width={11}
            height={5}
            className="fill-gray-1000"
          />
        ) : null}
      </TooltipPrimitive.Content>
    );
    return portal ? (
      <TooltipPrimitive.Portal>{content}</TooltipPrimitive.Portal>
    ) : (
      content
    );
  }
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
