'use client';

import { Button } from './button';
import { Spinner } from './spinner';

interface LoadMoreButtonProps {
  loading?: boolean;
  onClick?: () => void;
  label?: string;
  /** Label shown while loading. Defaults to `label`, so the width stays put. */
  loadingLabel?: string;
}

/**
 * A small secondary "Load More" button. While loading it shows a spinner in
 * front of the label and ignores further clicks.
 */
export function LoadMoreButton({
  loading = false,
  onClick,
  label = 'Load More',
  loadingLabel = label,
}: LoadMoreButtonProps) {
  return (
    <Button
      variant="secondary"
      size="small"
      aria-busy={loading || undefined}
      onClick={loading ? undefined : onClick}
    >
      {loading && <Spinner size={14} />}
      {loading ? loadingLabel : label}
    </Button>
  );
}
