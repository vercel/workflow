'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@/components/ui/navigation-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

type DesktopMenuProps = {
  items: { label: string; href: string }[];
};

export const DesktopMenu = ({ items }: DesktopMenuProps) => {
  const isMobile = useIsMobile();
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href.startsWith('http')) return false;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <NavigationMenu viewport={isMobile}>
      <NavigationMenuList className="gap-px">
        {items.map((item) => (
          <NavigationMenuItem key={item.href}>
            <NavigationMenuLink
              asChild
              className={cn(
                'rounded-md px-3 font-medium text-sm text-muted-foreground',
                isActive(item.href) && 'text-primary'
              )}
            >
              <Link href={item.href}>{item.label}</Link>
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenu>
  );
};
