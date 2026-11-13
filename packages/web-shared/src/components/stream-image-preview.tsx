'use client';

import { useEffect, useState } from 'react';
import { getStreamImageType } from '../lib/stream-image';
import { Button } from './ui/button';

export function StreamImagePreview({ data }: { data: Uint8Array }) {
  const [source, setSource] = useState<{
    data: Uint8Array;
    url: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const type = getStreamImageType(data);

  useEffect(() => {
    if (!type) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
    setSource({ data, url });
    setFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [data, type]);

  const url = source?.data === data ? source.url : null;
  return (
    <div className="min-w-0 w-full">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-label-12 text-gray-900">Image Preview</span>
        {url ? (
          <Button asChild size="tiny" variant="secondary">
            <a href={url} download={`workflow-stream.${type?.split('/')[1]}`}>
              Download Image
            </a>
          </Button>
        ) : null}
      </div>
      <div className="relative aspect-video w-full">
        {failed ? (
          <output className="text-copy-14 text-gray-900">
            This image can’t be previewed. Download it to view its contents.
          </output>
        ) : url ? (
          <img
            alt="Workflow stream content"
            className="absolute inset-0 h-full w-full object-contain"
            onError={() => setFailed(true)}
            src={url}
          />
        ) : (
          <div className="h-full w-full bg-gray-100" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
