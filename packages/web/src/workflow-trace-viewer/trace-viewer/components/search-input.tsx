import type { ChangeEventHandler, ReactNode } from 'react';
import styles from '../trace-viewer.module.css';

export function SearchInput({
  height,
  width,
  value,
  placeholder,
  onChange,
}: {
  height: number | string;
  width?: number | string;
  value: string;
  placeholder?: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
}): ReactNode {
  return (
    <label className={styles.searchInputLabel}>
      <div className={styles.searchInputPrefix}>
        <MagnifyingGlassIcon />
      </div>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        style={{ height, width }}
      />
    </label>
  );
}

function MagnifyingGlassIcon(): ReactNode {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11.5 11.5L14 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
