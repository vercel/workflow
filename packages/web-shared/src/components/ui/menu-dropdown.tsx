'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

const STYLES = `.wf-menu-btn{appearance:none;-webkit-appearance:none;border:none;display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 12px;border-radius:6px;font-size:14px;font-weight:500;line-height:20px;color:var(--ds-gray-1000);background:var(--ds-background-100);box-shadow:0 0 0 1px var(--ds-gray-400);cursor:pointer;white-space:nowrap;transition:background 150ms}.wf-menu-btn:hover{background:var(--ds-gray-alpha-200)}.wf-menu-item{appearance:none;-webkit-appearance:none;border:none;display:flex;align-items:center;width:100%;height:40px;padding:0 8px;border-radius:6px;font-size:14px;color:var(--ds-gray-1000);background:transparent;cursor:pointer;transition:background 150ms}.wf-menu-item:hover{background:var(--ds-gray-alpha-100)}`;

export interface MenuDropdownOption<T extends string = string> {
  value: T;
  label: string;
}

interface MenuDropdownProps<T extends string = string> {
  options: MenuDropdownOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * A dropdown menu that matches Geist's MenuButton (secondary) + Menu styling.
 * Uses CSS classes with proper :hover specificity (no inline background).
 */
export function MenuDropdown<T extends string = string>({
  options,
  value,
  onChange,
}: MenuDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label =
    options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <button
        type="button"
        className="wf-menu-btn"
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <svg
          width={16}
          height={16}
          viewBox="0 0 16 16"
          fill="none"
          className="-mr-1 ml-4 text-gray-900"
        >
          <path
            d="M4.5 6L8 9.5L11.5 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className="absolute top-full right-0 z-[2001] mt-1 min-w-[140px] bg-background-100 p-1 material-menu"
          role="menu"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitem"
              className={cn(
                'wf-menu-item',
                option.value === value ? 'font-medium' : 'font-normal'
              )}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
