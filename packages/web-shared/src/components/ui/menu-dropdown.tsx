'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from './button';

export interface MenuDropdownOption<T extends string = string> {
  value: T;
  label: string;
}

interface MenuDropdownProps<T extends string = string> {
  options: MenuDropdownOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the trigger when the selected label alone is unclear. */
  'aria-label'?: string;
}

/**
 * Single-select dropdown with a secondary-button trigger that shows the
 * current option. Keyboard support (arrow keys, typeahead, Escape, focus
 * return) comes from the Radix menu primitive.
 */
export function MenuDropdown<T extends string = string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: MenuDropdownProps<T>) {
  const label =
    options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="secondary"
          className="shrink-0 pr-3 data-[state=open]:bg-gray-100"
          aria-label={ariaLabel}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="text-gray-900" aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[2001] min-w-[160px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain rounded-xl bg-background-100 p-1.5 text-label-14 text-gray-1000 shadow-[var(--ds-shadow-menu)]"
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as T)}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="flex h-9 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-gray-alpha-100 data-[disabled]:text-gray-700"
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4" aria-hidden />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
