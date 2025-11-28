'use client';

import { ExternalLink, Monitor, Moon, Settings, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsSidebar } from './settings-sidebar';

// Controlled version that doesn't show the trigger button
function SettingsSidebarDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <SettingsSidebar open={open} onOpenChange={onOpenChange} />;
}

export function SettingsDropdown() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const currentTheme = theme || 'system';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <Settings className="h-[1.2rem] w-[1.2rem]" />
            <span className="sr-only">Settings</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <div className="px-2 py-1.5 flex items-center gap-3">
            <DropdownMenuLabel className="px-0 mb-0">Theme</DropdownMenuLabel>
            <SegmentedControl
              value={currentTheme}
              onValueChange={setTheme}
              options={[
                {
                  value: 'system',
                  icon: <Monitor className="h-4 w-4" />,
                },
                {
                  value: 'light',
                  icon: <Sun className="h-4 w-4" />,
                },
                {
                  value: 'dark',
                  icon: <Moon className="h-4 w-4" />,
                },
              ]}
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <span>Configuration</span>
            <Settings className="ml-auto h-4 w-4" />
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a
              href="https://useworkflow.dev/docs/getting-started"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>Docs</span>
              <ExternalLink className="ml-auto h-4 w-4" />
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsSidebarDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}
