'use client';

import type { TableOfContents } from 'fumadocs-core/toc';
import { useState } from 'react';
import { IconFileText } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-file-text';
import { IconMenuAlt } from '@/components/geistcn-fallbacks/geistcn-assets/icons/icon-menu-alt';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSidebarContext } from '@/hooks/geistdocs/use-sidebar';
import { cn } from '@/lib/utils';

interface MobileDocsBarProps {
  toc?: TableOfContents;
}

export const MobileDocsBar = ({ toc }: MobileDocsBarProps) => {
  const { setIsOpen: setSidebarOpen } = useSidebarContext();
  const [tocOpen, setTocOpen] = useState(false);

  return (
    <div className="sticky top-16 z-30 -mx-6 -mt-6 mb-6 flex h-[54px] items-center justify-between border-b bg-background-100 px-6 md:hidden">
      <button
        className="flex items-center gap-3 text-base text-gray-1000"
        onClick={() => setSidebarOpen(true)}
        type="button"
      >
        <IconMenuAlt size={16} />
        Menu
      </button>

      {toc && toc.length > 0 && (
        <>
          <button
            aria-label="Table of contents"
            className="flex size-8 items-center justify-center rounded-md border border-gray-200 text-gray-900 transition-colors hover:bg-gray-100 hover:text-gray-1000"
            onClick={() => setTocOpen(true)}
            type="button"
          >
            <IconFileText size={16} />
          </button>

          <Sheet onOpenChange={setTocOpen} open={tocOpen}>
            <SheetContent className="w-72 gap-0" side="right">
              <SheetHeader>
                <SheetTitle className="px-4 pt-4 font-medium text-sm">
                  On this page
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Table of contents for the current page.
                </SheetDescription>
              </SheetHeader>
              <nav className="flex-1 overflow-y-auto px-4 pb-4">
                <ul className="space-y-1">
                  {toc.map((item) => (
                    <li key={item.url}>
                      <a
                        className={cn(
                          'block rounded-md py-1.5 text-gray-900 text-sm transition-colors hover:text-gray-1000',
                          item.depth > 2 && 'pl-4'
                        )}
                        href={item.url}
                        onClick={() => setTocOpen(false)}
                      >
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </SheetContent>
          </Sheet>
        </>
      )}
    </div>
  );
};
