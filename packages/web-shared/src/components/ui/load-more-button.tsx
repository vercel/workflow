'use client';

import { Button } from './button';

interface LoadMoreButtonProps {
  loading?: boolean;
  onClick?: () => void;
  label?: string;
  /** Label while loading. Defaults to `label`, so the button keeps its width. */
  loadingLabel?: string;
  /** Drop the 16px gap above the button. */
  noGap?: boolean;
}

/**
 * A full-width secondary `Button` for loading the next page, 16px below the
 * content above it, with a spinner while loading.
 */
export function LoadMoreButton({
  loading = false,
  onClick,
  label = 'Load more',
  loadingLabel = label,
  noGap = false,
}: LoadMoreButtonProps) {
  return (
    <Button
      variant="secondary"
      className={noGap ? 'w-full' : 'mt-4 w-full'}
      loading={loading}
      onClick={onClick}
    >
      {loading ? loadingLabel : label}
    </Button>
  );
}
