'use client';

import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useVersion } from '@/hooks/geistdocs/use-version';
import { type DocsVersion, VERSIONS } from '@/lib/geistdocs/versions';
import { cn } from '@/lib/utils';

const VersionIcon = ({ version }: { version: DocsVersion }) => {
  const container = version.preRelease
    ? 'bg-orange-100 border-orange-300 dark:bg-orange-800 dark:border-orange-700'
    : 'bg-blue-100 border-blue-300 dark:bg-blue-200 dark:border-blue-700';
  const iconColor = version.preRelease
    ? 'text-orange-900 dark:text-orange-200'
    : 'text-blue-900 dark:text-blue-900';
  return (
    <div
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-md border',
        container
      )}
    >
      <svg
        aria-hidden="true"
        className={iconColor}
        height="16"
        viewBox="0 0 16 16"
        width="16"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          clipRule="evenodd"
          d="M1 1.5H1.75H14.25H15V2.25V6.25V7H14.25H8.75V14.25V15H7.25V14.25V7H1.75H1V6.25V2.25V1.5ZM2.5 5.5V3H13.5V5.5H2.5Z"
          fill="currentColor"
          fillRule="evenodd"
        />
      </svg>
    </div>
  );
};

export const VersionSwitcher = () => {
  const { activeVersion, switchVersion } = useVersion();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'mb-4 flex w-full items-center gap-3 rounded-md border',
          'bg-background-100 px-3 py-2 text-left transition-colors',
          'hover:bg-background-200 focus-visible:outline-hidden'
        )}
      >
        <VersionIcon version={activeVersion} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">
            {activeVersion.label}
          </span>
          <span className="truncate text-fd-muted-foreground text-xs">
            {activeVersion.subtitle}
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
          const isActive = version.id === activeVersion.id;
          return (
            <DropdownMenuItem
              key={version.id}
              className="flex items-center gap-3 py-2"
              onSelect={() => {
                if (isActive) return;
                switchVersion(version);
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
                <Check
                  aria-hidden="true"
                  className="size-4 text-green-900 dark:text-green-600"
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
