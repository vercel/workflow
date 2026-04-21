'use client';

import { Check, ChevronDown, Workflow } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  buildVersionUrl,
  type DocsVersion,
  getVersionFromPathname,
  VERSIONS,
} from '@/lib/geistdocs/versions';
import { cn } from '@/lib/utils';

const VersionIcon = ({ version }: { version: DocsVersion }) => {
  const palette = version.preRelease
    ? 'bg-orange-100 text-orange-700 ring-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900/60'
    : 'bg-blue-100 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900/60';
  return (
    <div
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-md ring-1',
        palette
      )}
    >
      <Workflow aria-hidden="true" className="size-5" />
    </div>
  );
};

export const VersionSwitcher = () => {
  const pathname = usePathname();
  const router = useRouter();
  const active = getVersionFromPathname(pathname);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'mb-4 flex w-full items-center gap-3 rounded-md border',
          'bg-background-100 px-3 py-2 text-left transition-colors',
          'hover:bg-background-200 focus-visible:outline-hidden'
        )}
      >
        <VersionIcon version={active} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">{active.label}</span>
          <span className="truncate text-fd-muted-foreground text-xs">
            {active.subtitle}
          </span>
        </div>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-fd-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        {VERSIONS.map((version) => {
          const isActive = version.id === active.id;
          return (
            <DropdownMenuItem
              key={version.id}
              className="flex items-center gap-3 py-2"
              onSelect={() => {
                if (isActive) return;
                router.push(buildVersionUrl(pathname, version));
              }}
            >
              <VersionIcon version={version} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-sm">
                  {version.label}
                </span>
                <span className="truncate text-fd-muted-foreground text-xs">
                  {version.subtitle}
                </span>
              </div>
              {isActive && (
                <Check aria-hidden="true" className="size-4 text-fd-primary" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
