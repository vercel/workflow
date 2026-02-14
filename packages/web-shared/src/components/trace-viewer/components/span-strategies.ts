import type { RefObject } from 'react';
import type { RootNode, ScrollSnapshot, VisibleSpan } from '../types';
import { MARKER_HEIGHT, ROW_HEIGHT, ROW_PADDING } from '../util/constants';

/**
 * The resource type of a workflow span, read from span.attributes.resource.
 * Falls back to 'default' for non-workflow (generic OTEL) spans.
 */
export type ResourceType = 'run' | 'step' | 'hook' | 'sleep' | 'default';

/** Minimum rendered width so very short spans are always visible */
const MIN_SPAN_WIDTH = 4;

/**
 * Layout result computed by a span strategy. Controls how the span
 * is sized and positioned in the timeline.
 */
export interface SpanLayout {
  /** The rendered width in pixels */
  width: number;
  /** The actual duration-based width (before min-width clamping) */
  actualWidth: number;
  /** The rendered height in pixels */
  height: number;
  /** The y position in pixels */
  top: number;
  /** The x position in pixels (from left) */
  left: number;
  /** Whether the span is considered "small" (< 64px actual width) */
  isSmall: boolean;
  /** Whether the span is considered "huge" (>= 500px actual width) */
  isHuge: boolean;
  /** Whether the span is currently hovered (with hover eligibility) */
  isHovered: boolean;
  /** Whether the span is expanded (hovered or selected) — controls sizing */
  isExpanded: boolean;
  /** Whether the span is near the right side of the visible area */
  isNearRightSide: boolean;
}

/**
 * Reads the resource type from a span's attributes.
 */
export function getResourceType(node: VisibleSpan): ResourceType {
  const resource = node.span.attributes?.resource;
  if (
    resource === 'run' ||
    resource === 'step' ||
    resource === 'hook' ||
    resource === 'sleep'
  ) {
    return resource;
  }
  return 'default';
}

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────

function computeIsSmall(actualWidth: number): boolean {
  return actualWidth < 64;
}

function computeIsHuge(actualWidth: number): boolean {
  return actualWidth >= 500;
}

function computeIsHovered(node: VisibleSpan, isHuge: boolean): boolean {
  return node.isHovered && !isHuge && node.isHighlighted !== false;
}

function computeIsNearRightSide(
  node: VisibleSpan,
  root: RootNode,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>,
  isHovered: boolean
): boolean {
  if (!isHovered) return false;

  let visibleDuration = root.duration;
  let visibleEndTime = root.endTime;
  const snapshot = scrollSnapshotRef.current;
  if (snapshot) {
    visibleDuration = snapshot.endTime - snapshot.startTime;
    visibleEndTime = snapshot.endTime;
  }
  return visibleEndTime - node.startTime < 0.25 * visibleDuration;
}

// ──────────────────────────────────────────────────────────────────────────
// Default layout (used by step, hook, run, default — all behave the same today)
// ──────────────────────────────────────────────────────────────────────────

function computeDefaultLayout(
  node: VisibleSpan,
  root: RootNode,
  scale: number,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>
): SpanLayout {
  const left = (node.startTime - root.startTime) * scale;
  let top = MARKER_HEIGHT + (ROW_HEIGHT + ROW_PADDING) * node.row;
  const actualWidth = node.duration * scale;
  const width = Math.max(actualWidth, MIN_SPAN_WIDTH);
  let height = ROW_HEIGHT;

  const isHuge = computeIsHuge(actualWidth);
  const isSmall = computeIsSmall(actualWidth);
  const isHovered = computeIsHovered(node, isHuge);
  const isExpanded = isHovered || Boolean(node.isSelected);

  if (isSmall && !isExpanded) {
    height *= 0.4;
    top += (ROW_HEIGHT - height) * 0.5;
  }

  const isNearRightSide = computeIsNearRightSide(
    node,
    root,
    scrollSnapshotRef,
    isExpanded
  );

  return {
    width,
    actualWidth,
    height,
    top,
    left,
    isSmall,
    isHuge,
    isHovered,
    isExpanded,
    isNearRightSide,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-type layout functions
// Each returns the same result today but provides a clear extension point.
// ──────────────────────────────────────────────────────────────────────────

export function getRunLayout(
  node: VisibleSpan,
  root: RootNode,
  scale: number,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>
): SpanLayout {
  return computeDefaultLayout(node, root, scale, scrollSnapshotRef);
}

export function getStepLayout(
  node: VisibleSpan,
  root: RootNode,
  scale: number,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>
): SpanLayout {
  return computeDefaultLayout(node, root, scale, scrollSnapshotRef);
}

export function getHookLayout(
  node: VisibleSpan,
  root: RootNode,
  scale: number,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>
): SpanLayout {
  return computeDefaultLayout(node, root, scale, scrollSnapshotRef);
}

export function getSleepLayout(
  node: VisibleSpan,
  root: RootNode,
  scale: number,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>
): SpanLayout {
  return computeDefaultLayout(node, root, scale, scrollSnapshotRef);
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────

/**
 * Computes the layout for a span based on its resource type.
 */
export function getSpanLayout(
  resourceType: ResourceType,
  node: VisibleSpan,
  root: RootNode,
  scale: number,
  scrollSnapshotRef: RefObject<ScrollSnapshot | undefined>
): SpanLayout {
  switch (resourceType) {
    case 'run':
      return getRunLayout(node, root, scale, scrollSnapshotRef);
    case 'step':
      return getStepLayout(node, root, scale, scrollSnapshotRef);
    case 'hook':
      return getHookLayout(node, root, scale, scrollSnapshotRef);
    case 'sleep':
      return getSleepLayout(node, root, scale, scrollSnapshotRef);
    default:
      return computeDefaultLayout(node, root, scale, scrollSnapshotRef);
  }
}
