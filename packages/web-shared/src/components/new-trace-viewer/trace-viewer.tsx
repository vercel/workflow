'use client';

import { X } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import type { Trace } from '../trace-viewer/types';
import { getHighResInMs } from '../trace-viewer/util/timing';
import { Divider, SplitPane } from './components/alt-split-pane';
import EventList from './components/event-list';
import { Timeline, TimelineBar } from './components/timeline';
import { ActiveSpanProvider, useActiveSpan } from './context';

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
  return (
    <ActiveSpanProvider spans={trace.spans}>
      <NewTraceViewerContent trace={trace} />
    </ActiveSpanProvider>
  );
}

function NewTraceViewerContent({ trace }: NewTraceViewerProps): ReactNode {
  const { activeSpan, activeSpanId, setActiveSpan, clearActiveSpan } =
    useActiveSpan();
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
      className="flex w-full h-full max-h-full"
      style={{
        display: 'grid',
        gridTemplateColumns: activeSpan
          ? 'minmax(100px, 1fr) 3px clamp(50px, 430px, 100%)'
          : 'minmax(100px, 1fr) 3px',
        height: '100%',
      }}
    >
      <div
        id="trace-parent"
        className="grid grid-rows-[auto_1fr] h-full min-h-0 overflow-hidden relative border"
      >
        <TraceHeader />
        <SplitPane>
          <EventList
            spans={trace.spans}
            activeSpanId={activeSpanId}
            onSelectSpan={setActiveSpan}
          />
          <Timeline>
            {trace.spans.map((span) => (
              <TimelineBar
                key={span.spanId}
                span={span}
                compression={compression}
                isSelected={span.spanId === activeSpanId}
                onClick={() => setActiveSpan(span.spanId)}
              />
            ))}
          </Timeline>
        </SplitPane>
      </div>
      {activeSpan ? (
        <>
          <Divider />
          <aside
            id="side-panel"
            className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-200"
          >
            <button type="button" onClick={clearActiveSpan}>
              <X />
            </button>
          </aside>
        </>
      ) : null}
    </div>
  );
}
