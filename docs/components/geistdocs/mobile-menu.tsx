'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { IconArrowUpRight } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-arrow-up-right';
import { nav } from '@/geistdocs';
import { cn } from '@/lib/utils';
import { SearchButton } from './search';

function NavLink({
  href,
  external,
  onClick,
  children,
}: {
  href: string;
  external?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      className="group flex items-center justify-between rounded-md p-3 text-gray-900 transition-colors hover:bg-gray-100 hover:text-gray-1000"
      href={href}
      onClick={onClick}
      rel={external ? 'noopener' : undefined}
      target={external ? '_blank' : undefined}
    >
      {children}
      {external && (
        <IconArrowUpRight
          className="text-gray-900 group-hover:text-gray-1000"
          size={16}
        />
      )}
    </Link>
  );
}

function MobileMenuButton({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? 'Close menu' : 'Open menu'}
      className="relative flex size-8 items-center justify-center rounded-full border border-gray-200 transition-colors hover:bg-gray-100 lg:hidden"
      onClick={onClick}
      type="button"
    >
      <span className="flex flex-col items-center justify-center gap-[5px]">
        <span
          className={cn(
            'block h-[1.5px] w-3.5 bg-gray-1000 transition-all duration-150',
            expanded && 'translate-y-[3.25px] rotate-45'
          )}
        />
        <span
          className={cn(
            'block h-[1.5px] w-3.5 bg-gray-1000 transition-all duration-150',
            expanded && '-translate-y-[3.25px] -rotate-45'
          )}
        />
      </span>
    </button>
  );
}

export const MobileMenu = () => {
  const [show, setShow] = useState(false);
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  // Close on route change
  useEffect(() => {
    if (pathname !== previousPathname.current) {
      setShow(false);
      previousPathname.current = pathname;
    }
  }, [pathname]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && show) {
        setShow(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [show]);

  // Lock scroll when open
  useEffect(() => {
    document.body.style.overflow = show ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [show]);

  const close = () => setShow(false);

  return (
    <>
      <MobileMenuButton expanded={show} onClick={() => setShow(!show)} />

      {/* Backdrop */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: backdrop dismiss */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
      <div
        className={cn(
          'fixed inset-0 top-16 z-40 bg-background-200 backdrop-blur-sm transition-opacity duration-200',
          show
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
        onClick={close}
      />

      {/* Popover */}
      <div
        className={cn(
          'fixed inset-x-0 top-16 bottom-0 z-40 overflow-y-auto bg-background-200 px-2 transition-all duration-200',
          show
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none -translate-y-2 opacity-0'
        )}
      >
        {/* Search */}
        <div className="p-4">
          <SearchButton className="w-full" onClick={close} />
        </div>

        {/* Navigation */}
        <nav className="px-1">
          {nav.map(({ label, href }) => (
            <NavLink
              external={href.startsWith('http')}
              href={href}
              key={href}
              onClick={close}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </>
  );
};
