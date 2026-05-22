'use client';

import type { JSX } from 'react';
import { Bar } from './bar';

export function UsageVisual(): JSX.Element {
  return (
    <div className="aspect-[444/264] w-full max-w-[444px] mx-auto relative overflow-hidden">
      <div className="absolute inset-0 flex flex-col justify-between">
        {Array.from({ length: 6 }).map((_, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: visual lines are static
          <div key={idx} className="w-full h-px bg-[var(--guide-color)]" />
        ))}
      </div>
      <div className="relative w-full h-full grid grid-cols-[repeat(7,_1fr)] grid-rows-[repeat(5,_1fr)] gap-0">
        <div className="row-start-[1] col-start-[1] row-end-[2] col-end-[2] flex items-center py-[3px]">
          <Bar
            className="w-full h-full !py-0"
            size="large"
            right="10s"
            variant="green"
          />
        </div>
        <div className="row-start-[1] col-start-[2] row-end-[6] col-end-[4]">
          <IdleTime />
        </div>
        <div className="row-start-[2] col-start-[4] row-end-[3] col-end-[5] flex items-center py-[3px]">
          <Bar
            className="w-full h-full !py-0"
            size="large"
            right="10s"
            variant="green"
          />
        </div>
        <div className="row-start-[1] col-start-[5] row-end-[6] col-end-[7]">
          <IdleTime />
        </div>
        <div className="row-start-[4] col-start-[7] row-end-[5] col-end-[8] flex items-center py-[3px]">
          <Bar
            className="w-full h-full !py-0"
            size="large"
            right="10s"
            variant="green"
          />
        </div>
      </div>
    </div>
  );
}

function IdleTime() {
  return (
    <div className="w-full h-[calc(100%-2px)] mt-px bg-gray-100 overflow-hidden relative">
      <div className="h-full flex gap-1 top-0 left-1/2 -translate-x-1/2 absolute rotate-45">
        {Array.from({ length: 56 }).map((_, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: visual lines are static
          <div key={idx} className="w-px h-[125%] bg-[var(--guide-color)]" />
        ))}
      </div>
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <span className="text-label-13-mono text-gray-900">idle</span>
      </div>
    </div>
  );
}
