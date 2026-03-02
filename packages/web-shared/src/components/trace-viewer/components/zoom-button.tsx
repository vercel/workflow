'use client';
import { type ReactNode, useCallback } from 'react';
import { useTraceViewer } from '../context';
import styles from '../trace-viewer.module.css';
import { IconMinus, IconZoomIn, IconZoomOut } from './zoom-icons';

export function ZoomButton(): ReactNode {
  const { dispatch } = useTraceViewer();

  const onZoomIn = useCallback((): void => {
    dispatch({
      type: 'adjustScaleRatio',
      direction: 1,
    });
  }, [dispatch]);

  const onZoomOut = useCallback((): void => {
    dispatch({
      type: 'adjustScaleRatio',
      direction: -1,
    });
  }, [dispatch]);

  const onResetZoom = useCallback((): void => {
    dispatch({
      type: 'adjustScaleRatio',
      direction: 0,
    });
  }, [dispatch]);

  return (
    <div className={styles.zoomButtonGroup}>
      <button
        aria-label="Zoom Out"
        className={styles.zoomButton}
        onClick={onZoomOut}
        type="button"
      >
        <IconZoomOut size={18} />
      </button>
      <div className={styles.divider} />
      <button
        aria-label="Reset Zoom"
        className={styles.zoomButton}
        onClick={onResetZoom}
        type="button"
      >
        <IconMinus size={18} />
      </button>
      <div className={styles.divider} />
      <button
        aria-label="Zoom In"
        className={styles.zoomButton}
        onClick={onZoomIn}
        type="button"
      >
        <IconZoomIn size={18} />
      </button>
    </div>
  );
}
