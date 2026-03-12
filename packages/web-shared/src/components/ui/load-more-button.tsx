'use client';

import { Spinner } from './spinner';

const STYLES = `.wf-load-more{appearance:none;-webkit-appearance:none;border:none;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border-radius:6px;font-size:13px;font-weight:500;line-height:20px;color:var(--ds-gray-1000);background:var(--ds-background-100);box-shadow:0 0 0 1px var(--ds-gray-400);cursor:pointer;white-space:nowrap;gap:6px;transition:background 150ms}.wf-load-more:hover{background:var(--ds-gray-alpha-200)}.wf-load-more:disabled{opacity:.6;cursor:default}.wf-load-more:disabled:hover{background:var(--ds-background-100)}`;

interface LoadMoreButtonProps {
  loading?: boolean;
  onClick?: () => void;
  label?: string;
  loadingLabel?: string;
}

/**
 * A "Load more" button matching Geist's Button type="secondary" size="small"
 * with a spinner prefix when loading.
 */
export function LoadMoreButton({
  loading = false,
  onClick,
  label = 'Load more',
  loadingLabel = 'Loading...',
}: LoadMoreButtonProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="wf-load-more"
      >
        {loading && <Spinner size={14} />}
        {loading ? loadingLabel : label}
      </button>
    </>
  );
}
