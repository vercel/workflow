'use client';

import { CopyButton } from '../trace-viewer/components/copy-button';
import { DataInspector } from '../ui/data-inspector';

export const serializeForClipboard = (value: unknown): string => {
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
    <div className="relative overflow-x-auto rounded-md border border-gray-alpha-400 p-3">
      <CopyButton
        copyText={serializeForClipboard(data)}
        ariaLabel="Copy data"
        className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-gray-alpha-400 !bg-background-100 p-0 text-gray-900 transition-transform transition-colors duration-100 hover:bg-gray-200 active:scale-95 active:bg-gray-300"
      />
      <DataInspector data={data} />
    </div>
  );
}
