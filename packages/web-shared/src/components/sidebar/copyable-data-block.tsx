'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { DataInspector } from '../ui/data-inspector';

const serializeForClipboard = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export function CopyableDataBlock({ data }: { data: unknown }) {
  return (
    <div
      className="relative overflow-x-auto rounded-md border p-3 pt-9"
      style={{ borderColor: 'var(--ds-gray-300)' }}
    >
      <button
        type="button"
        aria-label="Copy data"
        title="Copy"
        className="!absolute !right-2 !top-2 !flex !h-6 !w-6 !items-center !justify-center !rounded-md !border !bg-[var(--ds-background-100)] !text-[var(--ds-gray-800)] transition-transform transition-colors duration-100 hover:!bg-[var(--ds-gray-alpha-200)] active:!scale-95 active:!bg-[var(--ds-gray-alpha-300)]"
        style={{ borderColor: 'var(--ds-gray-300)' }}
        onClick={() => {
          navigator.clipboard
            .writeText(serializeForClipboard(data))
            .then(() => {
              toast.success('Copied to clipboard');
            })
            .catch(() => {
              toast.error('Failed to copy');
            });
        }}
      >
        <Copy size={12} />
      </button>
      <DataInspector data={data} />
    </div>
  );
}
