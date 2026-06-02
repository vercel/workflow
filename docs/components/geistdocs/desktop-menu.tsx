'use client';

import DynamicLink from 'fumadocs-core/dynamic-link';
import { useParams, usePathname } from 'next/navigation';
import { IconArrowUpRightSmall } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-arrow-up-right-small';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@/components/ui/navigation-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVersion } from '@/hooks/geistdocs/use-version';
import { cn } from '@/lib/utils';

interface DesktopMenuProps {
  className?: string;
  items: { label: string; href: string }[];
}

export const DesktopMenu = ({ items, className }: DesktopMenuProps) => {
  const isMobile = useIsMobile();
  const pathname = usePathname() ?? '/';
  const { lang } = useParams<{ lang?: string }>();
  const { activeVersion } = useVersion();

  // Prepend the active version prefix to versioned links (/docs and /cookbook)
  // so the navbar stays in sync with the selected version.
  const resolveHref = (href: string) => {
    if (
      !href.startsWith('http') &&
      (href.startsWith('/docs') || href.startsWith('/cookbook'))
    ) {
      return `${activeVersion.prefix}${href}`;
    }
    return href;
  };

  const matchesHref = (href: string) => {
    const resolved = resolveHref(href);
    // Check both the raw href and the version-resolved href so the active
    // state highlights correctly on both v4 and v5 doc paths.
    const candidates = [href, resolved];
    if (lang) {
      candidates.push(`/${lang}${href}`, `/${lang}${resolved}`);
    }
    return candidates.some(
      (candidate) =>
        pathname === candidate || pathname.startsWith(`${candidate}/`)
    );
  };

  return (
    <NavigationMenu viewport={isMobile}>
      <NavigationMenuList className={cn('h-14 gap-4', className)}>
        {items.map((item) => {
          const isExternal = item.href.startsWith('http');
          const isActive = !isExternal && matchesHref(item.href);
          return (
            <NavigationMenuItem key={item.href}>
              <NavigationMenuLink
                active={isActive}
                asChild
                className="flex items-center text-gray-900 text-sm transition-colors duration-100 hover:text-gray-1000 data-[active]:text-gray-1000"
              >
                {isExternal ? (
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
                  <DynamicLink href={`/[lang]${resolveHref(item.href)}`}>
                    {item.label}
                  </DynamicLink>
                )}
              </NavigationMenuLink>
            </NavigationMenuItem>
          );
        })}
      </NavigationMenuList>
    </NavigationMenu>
  );
};
