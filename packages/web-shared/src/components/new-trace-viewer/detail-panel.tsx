'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Span } from '../trace-viewer/types';
import { formatDuration, getHighResInMs } from '../trace-viewer/util/timing';
import { getSpanDurationMs } from './utils';

interface DetailPanelProps {
  span: Span;
  rootStart: number;
  onClose: () => void;
}

export function DetailPanel({
  span,
  rootStart,
  onClose,
}: DetailPanelProps): ReactNode {
  const startMs = getHighResInMs(span.startTime);
  const durationMs = getSpanDurationMs(span);
  const offsetMs = startMs - rootStart;

  return (
    <aside className="grid h-full max-h-full grid-rows-[2.5rem_1fr] bg-background-200">
      <div className="flex items-center justify-between px-3 border-b border-gray-alpha-400">
        <span className="text-sm font-medium text-gray-1000 truncate">
          {span.name}
        </span>
        <button
          type="button"
          className="p-1 rounded-md text-gray-900 hover:text-gray-1000 hover:bg-gray-alpha-200 transition-colors"
          onClick={onClose}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="overflow-y-auto p-3 space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-gray-900">Resource</dt>
          <dd className="text-gray-1000 font-mono">{span.resource}</dd>
          <dt className="text-gray-900">Duration</dt>
          <dd className="text-gray-1000 tabular-nums font-mono">
            {formatDuration(durationMs)}
          </dd>
          <dt className="text-gray-900">Offset</dt>
          <dd className="text-gray-1000 tabular-nums font-mono">
            +{formatDuration(offsetMs)}
          </dd>
          <dt className="text-gray-900">Status</dt>
          <dd className="text-gray-1000 font-mono">
            {span.status.code === 2 ? 'Error' : 'OK'}
          </dd>
        </dl>
      </div>
    </aside>
  );
}
