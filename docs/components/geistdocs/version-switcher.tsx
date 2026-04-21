'use client';

import { Check, ChevronDown } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  buildVersionUrl,
  getVersionFromPathname,
  VERSIONS,
} from '@/lib/geistdocs/versions';
import { cn } from '@/lib/utils';

export const VersionSwitcher = () => {
  const pathname = usePathname();
  const router = useRouter();
  const active = getVersionFromPathname(pathname);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'mb-4 flex w-full items-center justify-between rounded-md border',
          'bg-background-100 px-3 py-2 text-left transition-colors',
          'hover:bg-background-200 focus-visible:outline-hidden'
        )}
      >
        <div className="flex min-w-0 flex-col">
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
