'use client';

import type { CSSProperties, ReactNode } from 'react';
import styles from '../trace-viewer.module.css';
import type { SpanNode } from '../types';
import { formatDuration } from '../util/timing';
import {
  type Segment,
  type SegmentStatus,
  SEGMENT_CLASS_MAP,
  computeSegments,
} from './span-segments';
import type { ResourceType, SpanLayout } from './span-strategies';

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────

function getDuration(node: SpanNode): string {
  if (node.isInstrumentationHint) {
    return 'Get Started';
  }
  return formatDuration(node.duration);
}

// ──────────────────────────────────────────────────────────────────────────
// Segment rendering (shared across all workflow span types)
// ──────────────────────────────────────────────────────────────────────────

const SEGMENT_LABELS: Record<SegmentStatus, string> = {
  queued: 'Queued',
  running: '',
  failed: 'Failed',
  retrying: 'Retry wait',
  succeeded: 'Executed',
  waiting: 'Waiting',
  sleeping: 'Sleeping',
  received: 'Received',
};

function SegmentLayer({
  segments,
  spanDuration,
}: {
  segments: Segment[];
  spanDuration: number;
}): ReactNode {
  if (segments.length === 0) return null;

  return (
    <div className={styles.segmentLayer}>
      {segments.map((seg, i) => {
        const className =
          styles[SEGMENT_CLASS_MAP[seg.status] as keyof typeof styles];
        const segDuration =
          (seg.endFraction - seg.startFraction) * spanDuration;
        const label = SEGMENT_LABELS[seg.status];
        const style: CSSProperties = {
          left: `${seg.startFraction * 100}%`,
          width: `${(seg.endFraction - seg.startFraction) * 100}%`,
        };

        return (
          <div
            key={`seg-${seg.status}-${String(i)}`}
            className={`${styles.segment} ${String(className)}`}
            style={style}
            title={
              label
                ? `${label} ${formatDuration(segDuration)}`
                : formatDuration(segDuration)
            }
          />
        );
      })}
    </div>
  );
}

/** Build inline segment tags to render next to the span name. */
function getSegmentTags(
  segments: Segment[],
  spanDuration: number
): { label: string; duration: string }[] {
  const tags: { label: string; duration: string }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = SEGMENT_LABELS[seg.status];
    if (!label) continue; // skip "running" which has no label
    let segDuration = (seg.endFraction - seg.startFraction) * spanDuration;

    // For terminal segments (succeeded/failed) with ~0 duration,
    // use the preceding running segment's duration instead.
    if (
      segDuration < 1 &&
      (seg.status === 'succeeded' || seg.status === 'failed') &&
      i > 0
    ) {
      const prev = segments[i - 1];
      if (prev.status === 'running') {
        segDuration = (prev.endFraction - prev.startFraction) * spanDuration;
      }
    }

    // Skip tags that still have no meaningful duration
    if (segDuration < 1) continue;

    tags.push({ label, duration: formatDuration(segDuration) });
  }
  return tags;
}

// ──────────────────────────────────────────────────────────────────────────
// Text content (shared label + duration rendering)
// ──────────────────────────────────────────────────────────────────────────

function TextContent({
  node,
  layout,
  durationMs,
  segmentTags,
}: SpanContentProps & {
  segmentTags?: { label: string; duration: string }[];
}): ReactNode {
  const duration = node.isInstrumentationHint
    ? getDuration(node)
    : formatDuration(durationMs ?? node.duration);

  if (layout.isSmall && !layout.isHovered) {
    return null;
  }

  const showTags =
    segmentTags &&
    segmentTags.length > 0 &&
    (layout.isHovered || layout.width > 200);

  return (
    <>
      <span className={styles.spanName}>
        {node.label || node.span.name}
        {showTags
          ? segmentTags.map((tag, i) => (
              <span key={i} className={styles.segmentTag}>
                {' · '}
                {tag.label} {tag.duration}
              </span>
            ))
          : null}
      </span>
      {layout.isHuge ? <span className={styles.spanSpacer} /> : null}
      {layout.isHovered || layout.width > 128 ? (
        <span className={styles.spanDuration}>{duration}</span>
      ) : null}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Content props
// ──────────────────────────────────────────────────────────────────────────

export interface SpanContentProps {
  node: SpanNode;
  layout: SpanLayout;
  durationMs?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Default content (generic OTEL spans — no segments)
// ──────────────────────────────────────────────────────────────────────────

function DefaultContent({ node, layout }: SpanContentProps): ReactNode {
  return <TextContent node={node} layout={layout} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Workflow content (segments + text for workflow span types)
// ──────────────────────────────────────────────────────────────────────────

function WorkflowContent({
  resourceType,
  node,
  layout,
  durationMs,
}: SpanContentProps & { resourceType: ResourceType }): ReactNode {
  const spanDuration = durationMs ?? node.duration;
  const { segments } = computeSegments(resourceType, node);
  const segmentTags = getSegmentTags(segments, spanDuration);

  return (
    <>
      <SegmentLayer segments={segments} spanDuration={spanDuration} />
      <TextContent
        durationMs={spanDuration}
        node={node}
        layout={layout}
        segmentTags={segmentTags}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Per-type content components
// ──────────────────────────────────────────────────────────────────────────

export function RunContent(props: SpanContentProps): ReactNode {
  return <WorkflowContent resourceType="run" {...props} />;
}

export function StepContent(props: SpanContentProps): ReactNode {
  return <WorkflowContent resourceType="step" {...props} />;
}

export function HookContent(props: SpanContentProps): ReactNode {
  return <WorkflowContent resourceType="hook" {...props} />;
}

export function SleepContent(props: SpanContentProps): ReactNode {
  return <WorkflowContent resourceType="sleep" {...props} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns the inner content for a span based on its resource type.
 */
export function SpanContent({
  resourceType,
  ...props
}: SpanContentProps & { resourceType: ResourceType }): ReactNode {
  switch (resourceType) {
    case 'run':
      return <RunContent {...props} />;
    case 'step':
      return <StepContent {...props} />;
    case 'hook':
      return <HookContent {...props} />;
    case 'sleep':
      return <SleepContent {...props} />;
    default:
      return <DefaultContent {...props} />;
  }
}
