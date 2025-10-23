import { useEffect, useRef } from 'react';

/**
 * The delta is positive while zooming in, negative while zooming out
 */
export type TrackpadZoomHandler = (delta: number) => void;

export function useTrackpadZoom(handler: TrackpadZoomHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let pendingDelta = 0;
    let nextFrame = 0;
    const onFrame = (): void => {
      handlerRef.current(pendingDelta);
      pendingDelta = 0;
    };

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      let delta = -event.deltaY;

      switch (event.deltaMode) {
        case WheelEvent.DOM_DELTA_PAGE:
          delta *= window.innerHeight;
          break;
        case WheelEvent.DOM_DELTA_LINE:
          delta *= 20;
          break;
        default:
          break;
      }

      pendingDelta += delta;
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };

    window.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      window.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(nextFrame);
    };
  }, []);
}
