'use client';

import { type RefObject, useCallback, useState } from 'react';
import {
  clampPanelWidth,
  computeMaxPanelWidth,
  PANEL_MIN_WIDTH,
  readStoredPanelWidth,
  writeStoredPanelWidth,
} from './detail-panel-width';
import { useElementWidth } from './use-element-width';

/** The details panel's width, bounded by the container it shares. */
export interface DetailPanelWidth {
  /** Rendered width (px): the preferred width clamped to the container. */
  width: number;
  /** Widest the container allows (px), for the resize handle. */
  maxWidth: number;
  /** Sets and persists the preferred width, clamped to the container. */
  resize: (width: number) => void;
}

/**
 * Width state for `DetailPanelShell` (model in detail-panel-width.ts). Call it
 * from a component that stays mounted while the panel opens, closes and
 * changes selection, so the width holds across all three in a session;
 * localStorage only carries it to the next one. The container is measured
 * only while `open`.
 */
export function useDetailPanelWidth(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean
): DetailPanelWidth {
  const [storedWidth, setStoredWidth] = useState<number>(() =>
    readStoredPanelWidth()
  );
  const containerWidth = useElementWidth(containerRef, open);

  const resize = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next, containerWidth);
      setStoredWidth(clamped);
      writeStoredPanelWidth(clamped);
    },
    [containerWidth]
  );

  return {
    width: clampPanelWidth(storedWidth, containerWidth),
    maxWidth: Math.max(PANEL_MIN_WIDTH, computeMaxPanelWidth(containerWidth)),
    resize,
  };
}
