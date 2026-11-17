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
 * A "Load more" button: a small secondary `Button` that shows a spinner while
 * loading.
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
      size="small"
      loading={loading}
      onClick={onClick}
    >
      {loading ? loadingLabel : label}
    </Button>
  );
}
