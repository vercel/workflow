'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CheckboxProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
    'checked' | 'onCheckedChange'
  > {
  /** Whether the checkbox is checked */
  checked?: boolean;
  /** Whether the checkbox is in indeterminate state (for "select all" with partial selection) */
  indeterminate?: boolean;
  /** Callback when checked state changes */
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(({ className, checked, indeterminate, onCheckedChange, ...props }, ref) => {
  // Generate a unique id for associating label with checkbox
  const id = React.useId();
  const checkboxId = props.id ?? id;

  // Convert our boolean props to Radix's CheckedState
  const checkedState: CheckboxPrimitive.CheckedState = indeterminate
    ? 'indeterminate'
    : (checked ?? false);

  return (
    // Label provides the click grace area and proper a11y association
    <label
      htmlFor={checkboxId}
      className="p-2 -m-2 inline-flex items-center justify-center cursor-pointer"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <CheckboxPrimitive.Root
        ref={ref}
        id={checkboxId}
        checked={checkedState}
        onCheckedChange={(state: CheckboxPrimitive.CheckedState) => {
          // Convert Radix's CheckedState back to boolean
          // 'indeterminate' becomes false on click (standard behavior)
          onCheckedChange?.(state === true);
        }}
        className={cn(
          'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
          'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
          className
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
          {indeterminate ? (
            <Minus className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    </label>
  );
});
Checkbox.displayName = 'Checkbox';

export { Checkbox };
