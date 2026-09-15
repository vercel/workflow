/**
 * Layout constants shared by SplitPane and TraceViewerSkeleton. Kept in a
 * module without 'use client' so the skeleton's import chain stays
 * server-component-safe for external consumers.
 */

/** Width (px) of the draggable gutter column between the list and timeline. */
export const GUTTER_PX = 1;

/** Minimum width (px) of either SplitPane pane. */
export const MIN_PX = 50;

/** Default width (px) of the start (event list) pane. */
export const DEFAULT_START_PX = 340;

/** Grid column template for the [list | gutter | timeline] split. */
export function paneColTemplate(startPx: number): string {
  return `${startPx}px ${GUTTER_PX}px minmax(${MIN_PX}px, 1fr)`;
}
