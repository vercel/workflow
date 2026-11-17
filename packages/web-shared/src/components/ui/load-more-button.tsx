'use client';

import { Button } from './button';

interface LoadMoreButtonProps {
  loading?: boolean;
  onClick?: () => void;
  label?: string;
  /** Label while loading. Defaults to `label`, so the button keeps its width. */
  loadingLabel?: string;
}

/**
 * A full-width secondary `Button` for loading the next page, with a spinner
 * while loading. Spacing around it is up to the caller.
 */
export function LoadMoreButton({
  loading = false,
  onClick,
  label = 'Load more',
  loadingLabel = label,
}: LoadMoreButtonProps) {
  return (
    <Button
      variant="secondary"
      className="w-full"
      loading={loading}
      onClick={onClick}
    >
      {loading ? loadingLabel : label}
    </Button>
  );
}
