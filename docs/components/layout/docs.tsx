'use client';
import { cva } from 'class-variance-authority';
import type { PageTree } from 'fumadocs-core/server';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'fumadocs-ui/components/ui/collapsible';
import { useSidebar } from 'fumadocs-ui/contexts/sidebar';
import { TreeContextProvider, useTreeContext } from 'fumadocs-ui/contexts/tree';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { isActive } from '../../lib/is-active';

/**
 * Recursively checks if the current pathname matches any page within a folder
 */
function isPathInFolder(folder: PageTree.Folder, pathname: string): boolean {
  // Check if folder has an index page that matches
  if (folder.index && isActive(folder.index.url, pathname, true)) {
    return true;
  }

  // Check all children
  return folder.children.some((child) => {
    if (child.type === 'page') {
      return isActive(child.url, pathname, true);
    }
    if (child.type === 'folder') {
      return isPathInFolder(child, pathname);
    }
    return false;
  });
}

export interface DocsLayoutProps {
  tree: PageTree.Root;
  children: ReactNode;
}

export function DocsLayout({ tree, children }: DocsLayoutProps) {
  return (
    <TreeContextProvider tree={tree}>
      <main
        className="mt-14 flex flex-1 flex-row [--fd-nav-height:56px]"
        id="nd-docs-layout"
      >
        <Sidebar />
        {children}
      </main>
    </TreeContextProvider>
  );
}

export function NavbarSidebarTrigger(props: ComponentProps<'button'>) {
  const { open, setOpen } = useSidebar();

  return (
    <button
      {...props}
      aria-label="Toggle Sidebar"
      className={cn(
        'inline-flex items-center justify-center rounded-md p-2 text-fd-muted-foreground transition-opacity hover:opacity-60',
        props.className
      )}
      onClick={() => setOpen(!open)}
    >
      <svg
        fill="none"
        height="20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width="20"
      >
        <line x1="3" x2="21" y1="12" y2="12" />
        <line x1="3" x2="21" y1="6" y2="6" />
        <line x1="3" x2="21" y1="18" y2="18" />
      </svg>
    </button>
  );
}

function Sidebar() {
  const { root } = useTreeContext();
  const { open, setOpen } = useSidebar();

  const children = useMemo(() => {
    function renderItems(items: PageTree.Node[]) {
      return items.map((item) => (
        <SidebarItem item={item} key={item.$id}>
          {item.type === 'folder' ? renderItems(item.children) : null}
        </SidebarItem>
      ));
    }

    return renderItems(root.children);
  }, [root]);

  return (
    <>
      {/* backdrop overlay for mobile */}
      {open && (
        <div
          className="fixed inset-0 z-10 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={cn(
          'fixed top-[var(--fd-nav-height)] z-20 flex shrink-0 flex-col overflow-auto px-4 pb-4 pt-[var(--fd-nav-height)] text-sm md:sticky md:h-[calc(100dvh-var(--fd-nav-height))] md:w-[300px]',
          'max-md:inset-x-0 max-md:bottom-0 max-md:bg-fd-background',
          !open && 'max-md:invisible'
        )}
      >
        {children}
      </aside>
    </>
  );
}

const linkVariants = cva(
  'flex w-full items-center gap-2 rounded-lg py-1.5 text-fd-foreground/80 [&_svg]:size-4',
  {
    variants: {
      active: {
        true: 'text-primary-blue',
        false: 'hover:text-fd-accent-foreground',
      },
    },
  }
);

function SidebarItem({
  item,
  children,
}: {
  item: PageTree.Node;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const { setOpen: setSidebarOpen } = useSidebar();
  const [isOpen, setIsOpen] = useState(() => {
    if (item.type !== 'folder') return false;

    // Open if explicitly set to defaultOpen
    if ('defaultOpen' in item && item.defaultOpen === true) {
      return true;
    }

    // Open if current path is within this folder
    return isPathInFolder(item, pathname);
  });

  // Expand folder when navigating to any page within it
  useEffect(() => {
    if (item.type === 'folder' && isPathInFolder(item, pathname)) {
      setIsOpen(true);
    }
  }, [pathname, item]);

  // Close sidebar on mobile when link is clicked
  const handleLinkClick = () => {
    // Only close on mobile (md breakpoint is 768px)
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  if (item.type === 'page') {
    return (
      <Link
        className={linkVariants({
          active: pathname === item.url,
        })}
        href={item.url}
        onClick={handleLinkClick}
      >
        {item.name}
        {item.icon}
      </Link>
    );
  }

  if (item.type === 'separator') {
    return (
      <p className="my-2 text-fd-muted-foreground first:mt-0">
        {item.name}
        {item.icon}
      </p>
    );
  }

  // folder type
  const hasChildren = item.children && item.children.length > 0;

  // if folder has no children, just render as a link
  if (!hasChildren && item.index) {
    return (
      <Link
        className={linkVariants({
          active: pathname === item.index.url,
        })}
        href={item.index.url}
        onClick={handleLinkClick}
      >
        {item.index.icon}
        {item.index.name}
      </Link>
    );
  }

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <div>
        {item.index ? (
          <div className="flex items-center gap-1">
            <Link
              className={cn(
                linkVariants({
                  active: pathname === item.index.url,
                }),
                'flex-1'
              )}
              href={item.index.url}
              onClick={handleLinkClick}
            >
              {item.index.name}
              {item.index.icon}
            </Link>
            <CollapsibleTrigger className="p-0.5">
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform',
                  !isOpen && '-rotate-90'
                )}
              />
            </CollapsibleTrigger>
          </div>
        ) : (
          <CollapsibleTrigger
            className={cn(
              linkVariants(),
              'flex w-full items-center justify-between text-start'
            )}
          >
            <span className="flex items-center gap-2">
              {item.name}
              {item.icon}
            </span>
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform',
                isOpen && 'rotate-90'
              )}
            />
          </CollapsibleTrigger>
        )}
        <CollapsibleContent>
          <div className="mt-1 flex flex-col border-l pl-4">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
