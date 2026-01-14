'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { SegmentedControl } from '@/components/ui/segmented-control';

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const currentTheme = theme || 'system';

  return (
    <SegmentedControl
      value={currentTheme}
      onValueChange={(value) => setTheme(value)}
      options={[
        { value: 'system', icon: <Monitor className="h-4 w-4" /> },
        { value: 'light', icon: <Sun className="h-4 w-4" /> },
        { value: 'dark', icon: <Moon className="h-4 w-4" /> },
      ]}
      className="h-8"
    />
  );
}
