'use client';

import { Lock } from 'lucide-react';
import { useContext } from 'react';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { DataInspector, DecryptClickContext } from '../ui/data-inspector';

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
        className="pointer-events-none m-0 select-none p-3 text-label-12-mono text-gray-900 blur-[4px]"
      >
        {encryptedPlaceholderPreview}
      </pre>
      <div className="absolute inset-0 flex items-center justify-center">
        {ctx ? (
          <Button
            onClick={ctx.onDecrypt}
            loading={ctx.isDecrypting}
            disabled={ctx.isDecryptDisabled}
            title={
              ctx.isDecryptDisabled ? ctx.decryptDisabledReason : undefined
            }
            size="small"
            prefix={<Lock />}
          >
            Decrypt
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
    typeof value === 'bigint' ||
    value === null
  ) {
    return String(value);
  }
  try {
    // Hydrated payloads can contain BigInt values, which JSON.stringify rejects.
    // Write them as decimal strings, matching the CLI's `stringifyJSON`.
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    );
  } catch {
    return String(value);
  }
};

export function CopyableDataBlock({ data }: { data: unknown }) {
  return (
    <div className="relative overflow-x-auto rounded-md border border-gray-alpha-400 p-3">
      <CopyButton
        textToCopy={serializeForClipboard(data)}
        aria-label="Copy data"
        className="absolute right-2 top-2 z-10 border border-gray-alpha-400 bg-background-100 enabled:hover:bg-gray-200"
      />
      <DataInspector data={data} />
    </div>
  );
}
