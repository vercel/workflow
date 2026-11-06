'use client';

import { Tabs as TabsPrimitive } from 'radix-ui';
import type * as React from 'react';
import { createContext, use } from 'react';

import { cn } from '@/lib/utils';

type TabsVariant = 'default' | 'underline';

const TabsVariantContext = createContext<TabsVariant>('default');

function Tabs({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root> & {
  variant?: TabsVariant;
}) {
  return (
    <TabsVariantContext value={variant}>
      <TabsPrimitive.Root
        data-slot="tabs"
        className={cn('flex flex-col gap-2', className)}
        {...props}
      />
    </TabsVariantContext>
  );
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  const variant = use(TabsVariantContext);
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        variant === 'underline'
          ? 'inline-flex items-baseline gap-6 shadow-[inset_0_-1px_0_var(--ds-gray-alpha-200)]'
          : 'bg-gray-100 text-gray-900 inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]',
        className
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = use(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        variant === 'underline'
          ? 'text-gray-900 data-[state=active]:text-gray-1000 inline-flex items-baseline justify-center px-0.5 py-3.5 mb-0 text-sm whitespace-nowrap border-b-2 border-transparent data-[state=active]:border-gray-1000 transition-colors hover:text-gray-1000 disabled:pointer-events-none disabled:opacity-50'
          : "data-[state=active]:bg-background-100 dark:data-[state=active]:text-gray-1000 focus-visible:border-gray-600 focus-visible:ring-gray-600/50 focus-visible:outline-gray-600 dark:data-[state=active]:border-gray-alpha-400 dark:data-[state=active]:bg-gray-alpha-400/30 text-gray-1000 dark:text-gray-900 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
