'use client';

// import { cn } from "../../lib/utils";
import EventList from './components/event-list';
import type { Trace } from '../trace-viewer/types';
import { useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Timeline, TimelineBar } from './components/timeline';
import { getHighResInMs } from '../trace-viewer/util/timing';

interface NewTraceViewerProps {
  trace: Trace;
}

const TraceHeader = () => {
  return (
    <header>
      <h1>Trace</h1>
    </header>
  );
};

export function NewTraceViewer({ trace }: NewTraceViewerProps): ReactNode {
  const activeSpan = trace.spans[0];
  const splitRatio = 0.5;
  const compression = useMemo(() => {
    let minStart = Number.POSITIVE_INFINITY;
    let maxEnd = Number.NEGATIVE_INFINITY;

    for (const span of trace.spans) {
      const start = getHighResInMs(span.startTime);
      const end = getHighResInMs(span.endTime);

      if (start < minStart) minStart = start;
      if (end > maxEnd) maxEnd = end;
    }

    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
      minStart = 0;
      maxEnd = 1;
    }

    const range = Math.max(maxEnd - minStart, 1);

    return {
      toVisual(time: number): number {
        return Math.min(Math.max((time - minStart) / range, 0), 1);
      },
    };
  }, [trace.spans]);

  return (
    <div
      data-pane="pane-root"
      className="flex w-full overflow-hidden h-full max-h-full"
      style={{
        display: 'grid',
        gridTemplateColumns: activeSpan
          ? 'minmax(100px, 1fr) 3px clamp(50px, 430px, 100%)'
          : 'minmax(100px, 1fr) 3px',
        height: '100%',
      }}
    >
      <div>
        <TraceHeader />
        <div
          data-pane="left-pane"
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(50px, ${splitRatio * 100}%) 3px minmax(50px, ${(1 - splitRatio) * 100}%)`,
            height: '100%',
          }}
        >
          <EventList spans={trace.spans} />
          <div className="w-px bg-gray-alpha-400 h-full" role="separator" />
          <Timeline>
            {trace.spans.map((span) => (
              <TimelineBar
                key={span.spanId}
                span={span}
                compression={compression}
                isSelected={false}
                onClick={() => {}}
              />
            ))}
          </Timeline>
        </div>
      </div>
      {activeSpan ? (
        <>
          <div className="w-px bg-gray-alpha-400 h-full" role="separator"></div>
          <aside
            id="side-panel"
            className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-200"
          >
            <button
              type="button"
              onClick={() => console.log('close side panel')}
            >
              <X />
            </button>
          </aside>
        </>
      ) : null}
    </div>
  );
}
