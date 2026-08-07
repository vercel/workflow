'use client';

import { useEffect, useRef, useState } from 'react';

const STYLES = `.wf-menu-btn{appearance:none;-webkit-appearance:none;border:none;display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 12px;border-radius:6px;font-size:14px;font-weight:500;line-height:20px;color:var(--ds-gray-1000);background:var(--ds-background-100);box-shadow:0 0 0 1px var(--ds-gray-400);cursor:pointer;white-space:nowrap;transition:background 150ms}.wf-menu-btn:hover{background:var(--ds-gray-alpha-200)}.wf-menu-btn-inline{appearance:none;-webkit-appearance:none;border:none;display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 12px;border-radius:0;font-size:13px;font-weight:400;line-height:16px;color:var(--ds-gray-900);background:transparent;cursor:pointer;white-space:nowrap;transition:background 150ms,color 150ms}.wf-menu-btn-inline:hover{color:var(--ds-gray-1000);background:var(--ds-gray-alpha-100)}.wf-menu-btn-inline:focus-visible{outline:2px solid var(--ds-focus-color);outline-offset:-2px}.wf-menu-item{appearance:none;-webkit-appearance:none;border:none;display:flex;align-items:center;width:100%;height:40px;padding:0 8px;border-radius:6px;font-size:14px;color:var(--ds-gray-1000);background:transparent;cursor:pointer;transition:background 150ms}.wf-menu-item:hover{background:var(--ds-gray-alpha-100)}`;

export interface MenuDropdownOption<T extends string = string> {
  value: T;
  label: string;
}

interface MenuDropdownProps<T extends string = string> {
  options: MenuDropdownOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * Visual style of the trigger button:
   * - `default`: standalone Geist secondary button (40px, bordered)
   * - `inline`: borderless full-height cell for slim header rows
   */
  variant?: 'default' | 'inline';
}

/**
 * A dropdown menu that matches Geist's MenuButton (secondary) + Menu styling.
 * Uses CSS classes with proper :hover specificity (no inline background).
 */
export function MenuDropdown<T extends string = string>({
  options,
  value,
  onChange,
  variant = 'default',
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
    <div
      ref={ref}
      style={{
        position: 'relative',
        flexShrink: 0,
        height: variant === 'inline' ? '100%' : undefined,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <button
        type="button"
        className={variant === 'inline' ? 'wf-menu-btn-inline' : 'wf-menu-btn'}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <svg
          width={16}
          height={16}
          viewBox="0 0 16 16"
          fill="none"
          style={{
            marginLeft: variant === 'inline' ? 6 : 16,
            marginRight: -4,
            color: 'var(--ds-gray-900)',
          }}
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
          style={{
            position: 'absolute',
            right: variant === 'inline' ? 4 : 0,
            top: variant === 'inline' ? 'calc(100% + 2px)' : '100%',
            marginTop: variant === 'inline' ? 0 : 4,
            minWidth: 140,
            padding: 4,
            borderRadius: 12,
            background: 'var(--ds-background-100)',
            boxShadow: 'var(--ds-shadow-menu, var(--ds-shadow-medium))',
            zIndex: 2001,
          }}
          role="menu"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitem"
              className="wf-menu-item"
              style={{
                fontWeight: option.value === value ? 500 : 400,
              }}
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
