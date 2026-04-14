'use client';

import DynamicLink from 'fumadocs-core/dynamic-link';
import { IconArrowUpRightSmall } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-arrow-up-right-small';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@/components/ui/navigation-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface DesktopMenuProps {
  className?: string;
  items: { label: string; href: string }[];
}

export const DesktopMenu = ({ items, className }: DesktopMenuProps) => {
  const isMobile = useIsMobile();

  return (
    <NavigationMenu viewport={isMobile}>
      <NavigationMenuList className={cn('h-14 gap-4', className)}>
        {items.map((item) => (
          <NavigationMenuItem key={item.href}>
            <NavigationMenuLink
              asChild
              className="flex items-center text-gray-900 text-sm transition-colors duration-100 hover:text-gray-1000"
            >
              {item.href.startsWith('http') ? (
                <a
                  className="flex flex-row items-center gap-1"
                  href={item.href}
                  rel="noopener"
                  target="_blank"
                >
                  {item.label}
                  <IconArrowUpRightSmall aria-hidden="true" size={12} />
                </a>
              ) : (
                <DynamicLink href={`/[lang]${item.href}`}>
                  {item.label}
                </DynamicLink>
              )}
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenu>
  );
};
