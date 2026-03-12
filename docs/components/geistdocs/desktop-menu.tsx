'use client';

import DynamicLink from 'fumadocs-core/dynamic-link';
import { ExternalLinkIcon } from 'lucide-react';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@/components/ui/navigation-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

type DesktopMenuProps = {
  items: { label: string; href: string; preview?: boolean }[];
  className?: string;
};

export const DesktopMenu = ({ items, className }: DesktopMenuProps) => {
  const isMobile = useIsMobile();

  return (
    <NavigationMenu viewport={isMobile}>
      <NavigationMenuList className={cn('gap-px', className)}>
        {items.map((item) => (
          <NavigationMenuItem key={item.href}>
            <NavigationMenuLink
              asChild
              className="rounded-md px-3 font-medium text-sm"
            >
              {item.href.startsWith('http') ? (
                <a
                  className="flex flex-row items-center gap-2"
                  href={item.href}
                  rel="noopener"
                  target="_blank"
                >
                  {item.label}
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              ) : (
                <DynamicLink
                  href={`/[lang]${item.href}`}
                  className={
                    item.preview
                      ? 'flex flex-row items-center gap-1.5'
                      : undefined
                  }
                >
                  {item.label}
                  {item.preview && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
                      Preview
                    </span>
                  )}
                </DynamicLink>
              )}
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenu>
  );
};
