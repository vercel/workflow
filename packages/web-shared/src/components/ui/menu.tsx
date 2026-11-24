'use client';

import {
  Menu,
  MenuContent as MenuContentPart,
  MenuItemIcon as MenuItemIconPart,
  MenuItem as MenuItemPart,
  MenuSeparator as MenuSeparatorPart,
  MenuTrigger,
} from '@ui-sdk/react/menu';
import type * as React from 'react';
import { cn } from '../../lib/cn';

type MenuContentProps = Omit<
  React.ComponentProps<typeof MenuContentPart>,
  'className'
> & { className?: string };

type MenuItemProps = Omit<
  React.ComponentProps<typeof MenuItemPart>,
  'className'
> & { className?: string };

type MenuItemIconProps = Omit<
  React.ComponentProps<typeof MenuItemIconPart>,
  'className'
> & { className?: string };

type MenuSeparatorProps = Omit<
  React.ComponentProps<typeof MenuSeparatorPart>,
  'className'
> & { className?: string };

// Menu content keeps the browser's popover border, padding and background, so
// every one of them is set here.
function MenuContent({
  className,
  sideOffset = 4,
  ...props
}: MenuContentProps): React.JSX.Element {
  return (
    <MenuContentPart
      sideOffset={sideOffset}
      className={cn(
        'm-0 min-w-[180px] max-h-(--available-height) overflow-y-auto overscroll-contain',
        'rounded-xl border-0 bg-background-100 p-2 text-gray-1000 shadow-[var(--ds-shadow-menu)] outline-none',
        'transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none',
        className
      )}
      {...props}
    />
  );
}

function MenuItem({ className, ...props }: MenuItemProps): React.JSX.Element {
  return (
    <MenuItemPart
      className={cn(
        'flex h-10 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 text-[14px] text-gray-1000 outline-none',
        'data-highlighted:bg-gray-alpha-100',
        'data-disabled:cursor-not-allowed data-disabled:text-gray-700 data-disabled:data-highlighted:bg-transparent',
        'data-destructive:text-red-800',
        className
      )}
      {...props}
    />
  );
}

function MenuItemIcon({
  className,
  ...props
}: MenuItemIconProps): React.JSX.Element {
  return (
    <MenuItemIconPart
      className={cn('flex shrink-0 [&_svg]:size-4', className)}
      {...props}
    />
  );
}

function MenuSeparator({
  className,
  ...props
}: MenuSeparatorProps): React.JSX.Element {
  return (
    <MenuSeparatorPart
      className={cn('-mx-2 my-2 h-px bg-gray-alpha-400', className)}
      {...props}
    />
  );
}

export {
  Menu,
  MenuContent,
  type MenuContentProps,
  MenuItem,
  MenuItemIcon,
  type MenuItemIconProps,
  type MenuItemProps,
  MenuSeparator,
  type MenuSeparatorProps,
  MenuTrigger,
};
