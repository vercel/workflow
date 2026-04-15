import * as React from 'react';
import { NavigationMenu as NavigationMenuPrimitive } from 'radix-ui';
import { cva } from 'class-variance-authority';
import { IconChevronDownSmall } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-chevron-down-small';

import { cn } from '@/lib/utils';

function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function isKeyboardClick(event: React.MouseEvent) {
  return event.detail === 0;
}

function NavigationMenu({
  className,
  children,
  viewport = true,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Root> & {
  viewport?: boolean;
  viewportClassName?: string;
}) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      data-viewport={viewport}
      className={cn(
        'group/navigation-menu relative z-10 flex max-w-max flex-1 items-center justify-center',
        className
      )}
      {...props}
    >
      {children}
      {viewport && (
        <NavigationMenuViewport wrapperClassName={viewportClassName} />
      )}
    </NavigationMenuPrimitive.Root>
  );
}

function NavigationMenuList({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.List>) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn(
        'group flex flex-1 list-none items-center justify-center gap-1',
        className
      )}
      {...props}
    />
  );
}

function NavigationMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Item>) {
  return (
    <NavigationMenuPrimitive.Item
      data-slot="navigation-menu-item"
      className={cn('relative', className)}
      {...props}
    />
  );
}

const navigationMenuTriggerStyle = cva(
  'group inline-flex relative px-3 gap-1 w-max items-center justify-center text-sm transition-colors text-gray-900 hover:text-gray-1000 focus:text-gray-1000 focus:outline-none disabled:pointer-events-none disabled:opacity-50 data-[active]:text-gray-1000 data-[state=open]:text-gray-1000'
);

function NavigationMenuTrigger({
  className,
  children,
  onClick,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Trigger>) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(navigationMenuTriggerStyle(), 'group', className)}
      // Prevent the trigger from closing the menu when clicked on non-touch
      // devices. Touch and keyboard users retain default toggle behavior.
      onClick={(event) => {
        if (!isTouchDevice() && !isKeyboardClick(event)) {
          event.preventDefault();
        }
        onClick?.(event);
      }}
      {...props}
    >
      {children}
      <IconChevronDownSmall
        className="relative top-px size-3.5 text-gray-900 transition-all duration-200 ease group-hover:text-gray-1000 group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
      <div className="absolute -mx-12 inset-x-0 bottom-0 z-50 hidden h-[18px] group-data-[state=open]:flex" />
    </NavigationMenuPrimitive.Trigger>
  );
}

function NavigationMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Content>) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        'left-0 top-0 w-full data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out md:absolute md:w-auto',
        'group-data-[viewport=false]/navigation-menu:bg-popover group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:data-[state=open]:animate-in group-data-[viewport=false]/navigation-menu:data-[state=closed]:animate-out group-data-[viewport=false]/navigation-menu:data-[state=closed]:zoom-out-95 group-data-[viewport=false]/navigation-menu:data-[state=open]:zoom-in-95 group-data-[viewport=false]/navigation-menu:data-[state=open]:fade-in-0 group-data-[viewport=false]/navigation-menu:data-[state=closed]:fade-out-0 group-data-[viewport=false]/navigation-menu:top-full group-data-[viewport=false]/navigation-menu:mt-1.5 group-data-[viewport=false]/navigation-menu:overflow-hidden group-data-[viewport=false]/navigation-menu:rounded-lg group-data-[viewport=false]/navigation-menu:shadow group-data-[viewport=false]/navigation-menu:duration-200 **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none',
        className
      )}
      {...props}
    />
  );
}

function NavigationMenuViewport({
  className,
  wrapperClassName,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Viewport> & {
  wrapperClassName?: string;
}) {
  return (
    <div
      className={cn(
        'absolute left-0 top-[70%] flex justify-center',
        wrapperClassName
      )}
    >
      <NavigationMenuPrimitive.Viewport
        data-slot="navigation-menu-viewport"
        className={cn(
          'origin-top-center relative mt-3.5 h-[var(--radix-navigation-menu-viewport-height)] w-full overflow-hidden rounded-lg bg-background-100 text-gray-950 [box-shadow:var(--ds-shadow-menu)] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-90 md:w-[var(--radix-navigation-menu-viewport-width)]',
          className
        )}
        {...props}
      />
    </div>
  );
}

function NavigationMenuLink({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Link>) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      className={cn(
        'block w-full text-sm outline-none transition-colors',
        className
      )}
      {...props}
    />
  );
}

function NavigationMenuIndicator({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Indicator>) {
  return (
    <NavigationMenuPrimitive.Indicator
      data-slot="navigation-menu-indicator"
      className={cn(
        'data-[state=visible]:animate-in data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:fade-in top-[70%] z-[1] flex items-end justify-center overflow-hidden transition-all duration-200',
        className
      )}
      {...props}
    >
      <div className="relative top-[6.5px] size-4 rotate-45 rounded-tl-sm border border-r-0 border-b-0 border-gray-200 bg-white" />
    </NavigationMenuPrimitive.Indicator>
  );
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuContent,
  NavigationMenuTrigger,
  NavigationMenuLink,
  NavigationMenuIndicator,
  NavigationMenuViewport,
  navigationMenuTriggerStyle,
};
