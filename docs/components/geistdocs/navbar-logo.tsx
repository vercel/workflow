'use client';

import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { IconSlashForward } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-slash-forward';
import { LogoAiElements } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-ai-elements';
import { LogoChatSdk } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-chat-sdk';
import { LogoFlagsSdk } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-flags-sdk';
import { LogoIconVercel } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-icon-vercel';
import { LogoStreamdown } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-streamdown';
import { LogoVercelOss } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-vercel-oss';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { cn } from '@/lib/utils';

const OSS_PRODUCT_LINKS: {
  href: string;
  logo: ComponentType<{ height: number }>;
  height: number;
}[] = [
  { href: 'https://flags-sdk.dev/', logo: LogoFlagsSdk, height: 20 },
  { href: 'https://chat-sdk.dev/', logo: LogoChatSdk, height: 20 },
  { href: 'https://elements.ai-sdk.dev/', logo: LogoAiElements, height: 12 },
  { href: 'https://streamdown.ai/', logo: LogoStreamdown, height: 17 },
];

type NavbarLogoProps = {
  className?: string;
  /** Where the logo links to (defaults to "/") */
  href?: string;
} & (
  | {
      variant: 'oss';
      /** Logo shown in the trigger (e.g. LogoAiSdk) */
      logo: ReactNode;
    }
  | {
      variant?: 'standard';
      /** Logo shown after the slash (e.g. product name) */
      logo: ReactNode;
    }
);

export function NavbarLogo({
  className,
  href = '/',
  ...props
}: NavbarLogoProps) {
  const isOss = props.variant === 'oss';

  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <Link
        className="text-gray-1000"
        href={isOss ? 'https://vercel.com/oss' : 'https://vercel.com/'}
        rel="noopener"
        target="_blank"
      >
        {isOss ? (
          <>
            <LogoIconVercel className="sm:hidden" size={20} />
            <LogoVercelOss className="hidden sm:block" size={18} />
          </>
        ) : (
          <LogoIconVercel size={20} />
        )}
      </Link>
      <div className="w-4 text-center text-gray-300 text-lg dark:text-gray-600">
        <IconSlashForward />
      </div>
      {isOss ? (
        <NavigationMenu viewportClassName="-left-5 top-4">
          <NavigationMenuList>
            <NavigationMenuItem className="flex items-center">
              <NavigationMenuTrigger className="-m-3 flex items-center gap-1.5 p-3">
                <Link
                  className="flex items-center text-gray-1000"
                  href={href}
                  onClick={(e) => e.stopPropagation()}
                >
                  {props.logo}
                </Link>
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <ul className="grid w-[200px] gap-0.5 p-2">
                  {OSS_PRODUCT_LINKS.map(
                    ({ href, logo: ProductLogo, height }) => (
                      <li key={href}>
                        <NavigationMenuLink asChild>
                          <Link
                            className="flex h-10 items-center gap-3 rounded-md px-3 py-2.5 text-gray-1000 text-sm outline-none transition-colors hover:bg-gray-100"
                            href={href}
                            rel="noopener"
                            target="_blank"
                          >
                            <ProductLogo height={height} />
                          </Link>
                        </NavigationMenuLink>
                      </li>
                    )
                  )}
                </ul>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      ) : (
        <Link className="flex items-center text-gray-1000" href={href}>
          {props.logo}
        </Link>
      )}
    </span>
  );
}
