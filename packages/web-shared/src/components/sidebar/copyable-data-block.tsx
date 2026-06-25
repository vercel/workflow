'use client';

import { Lock } from 'lucide-react';
import { useContext } from 'react';
import { CopyButton } from '../new-trace-viewer/components/copy-button';
import { Button } from '../ui/button';
import { DataInspector, DecryptClickContext } from '../ui/data-inspector';
import { Spinner } from '../ui/spinner';

const encryptedPlaceholderPreview = `{
  "input": "[encrypted]",
  "result": "[encrypted]"
}`;

export function EncryptedDataBlock() {
  const ctx = useContext(DecryptClickContext);

  return (
    <div className="relative min-h-20 overflow-hidden rounded-md border border-gray-alpha-400 bg-background-100">
      <pre
        aria-hidden="true"
        className="pointer-events-none m-0 select-none p-3 font-mono text-label-12 text-gray-900 blur-[4px]"
      >
        {encryptedPlaceholderPreview}
      </pre>
      <div className="absolute inset-0 flex items-center justify-center">
        {ctx ? (
          <Button onClick={ctx.onDecrypt} disabled={ctx.isDecrypting} size="xs">
            {ctx.isDecrypting ? (
              <Spinner size={10} />
            ) : (
              <Lock className="h-3 w-3" />
            )}
            <span>Decrypt</span>
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-gray-alpha-400 bg-gray-100 px-1.5 py-0.5 text-button-12 font-medium text-gray-700">
            <Lock className="h-3 w-3" />
            Encrypted
          </span>
        )}
      </div>
    </div>
  );
}

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
