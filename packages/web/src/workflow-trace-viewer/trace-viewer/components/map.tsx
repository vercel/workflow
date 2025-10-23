import {
  type MutableRefObject,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTraceViewer } from '../context';
import styles from '../trace-viewer.module.css';
import type { VisibleSpan } from '../types';
import { MAP_HEIGHT, TIMELINE_PADDING } from '../util/constants';
import { useImmediateStyle } from '../util/use-immediate-style';

const getDpi = (): number => {
  if ('devicePixelRatio' in globalThis) {
    return globalThis.devicePixelRatio || 1;
  }
  return 1;
};

const useDpi = (): number => {
  const [dpi, setDpi] = useState(1);
  useLayoutEffect(() => {
    const onChange = (): void => setDpi(getDpi());
    const media = matchMedia(`(resolution: ${dpi}dppx)`);
    media.addEventListener('change', onChange);
    onChange();

    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [dpi]);
  return dpi;
};

const padding = TIMELINE_PADDING;

export const MiniMap = memo(function MiniMap({
  timelineRef,
  rows,
  scale,
}: {
  timelineRef: MutableRefObject<HTMLDivElement | null>;
  rows: VisibleSpan[][];
  scale: number;
}) {
  const {
    state: { root, baseScale, timelineWidth, width: fullWidth, scrollbarWidth },
  } = useTraceViewer();
  const mapWidth = fullWidth + TIMELINE_PADDING * 2;
  const dpi = useDpi();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const thumbRatio =
    (fullWidth / (fullWidth - scrollbarWidth)) *
    Math.min(fullWidth / timelineWidth, baseScale / scale);
  const thumbWidth = Math.min(
    fullWidth,
    (timelineWidth - scrollbarWidth) * thumbRatio
  );
  useEffect(() => {
    let isHeld = false;
    let clientX = 0;
    let rect: DOMRect | undefined;

    const isValidEventTarget = (target: EventTarget | null): boolean => {
      return Boolean(containerRef.current?.contains(target as HTMLElement));
    };

    let nextFrame = 0;
    const onFrame = (): void => {
      if (!isHeld || !rect) return;
      const $timeline = timelineRef.current;
      if (!$timeline) return;

      const x = clientX - thumbWidth * 0.5 - rect.left;
      $timeline.scrollLeft = x / thumbRatio;
    };

    const onPointerMove = (event: PointerEvent): void => {
      ({ clientX } = event);
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!isValidEventTarget(event.target)) return;
      isHeld = true;
      rect = containerRef.current?.getBoundingClientRect();
      onPointerMove(event);
    };

    const onPointerUp = (): void => {
      isHeld = false;
      rect = undefined;
    };

    const onTouchStart = (event: TouchEvent): void => {
      if (!isValidEventTarget(event.target)) return;
      if (event.cancelable) {
        event.preventDefault();
      }
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!isHeld) return;
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('blur', onPointerUp);
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      cancelAnimationFrame(nextFrame);
    };
  }, [timelineRef, thumbRatio, thumbWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const render = (): void => {
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpi, dpi);

      const gap = 1;
      const height = 3;
      const ratio = (mapWidth - padding * 2) / root.duration;

      // TODO: fill spans based on depth
      ctx.fillStyle = '#ccc';
      ctx.beginPath();
      for (const row of rows) {
        for (const span of row) {
          const y = padding - gap + (gap + height) * span.row;
          if (y >= MAP_HEIGHT - height - padding) break;

          const x = padding + (span.startTime - root.startTime) * ratio;
          const width = span.duration * ratio;

          ctx.roundRect(x, y, width, height, height);
        }
      }
      ctx.fill();
    };

    const nextFrame = requestAnimationFrame(render);

    return () => cancelAnimationFrame(nextFrame);
  }, [dpi, root, mapWidth, rows]);

  const thumbRef = useRef<HTMLDivElement>(null);
  const { style: thumbStyle, setStyle: setThumbStyle } =
    useImmediateStyle(thumbRef);
  useLayoutEffect(() => {
    const $timeline = timelineRef.current;
    if (!$timeline) return;

    let nextFrame = 0;
    const onFrame = (): void => {
      setThumbStyle(
        'transform',
        `translateX(${padding + $timeline.scrollLeft * thumbRatio}px)`
      );
    };
    onFrame();

    const onScroll = (): void => {
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };
    $timeline.addEventListener('scroll', onScroll);

    return () => {
      cancelAnimationFrame(nextFrame);
      $timeline.removeEventListener('scroll', onScroll);
    };
  }, [timelineRef, thumbRatio, setThumbStyle]);

  return (
    <div
      className={styles.mapContainer}
      ref={containerRef}
      style={{
        width: thumbWidth > 0 ? mapWidth : '100%',
        height: MAP_HEIGHT,
      }}
    >
      <canvas
        className={styles.mapCanvas}
        height={MAP_HEIGHT * dpi}
        ref={canvasRef}
        style={{ width: mapWidth, height: MAP_HEIGHT }}
        width={mapWidth * dpi}
      />
      <div
        className={styles.mapThumb}
        ref={thumbRef}
        style={{
          transform: thumbStyle.transform,
          width:
            thumbWidth > 0
              ? thumbWidth
              : `calc(100% - ${TIMELINE_PADDING * 2}px)`,
          top: 2,
          height: MAP_HEIGHT - 4,
        }}
      />
    </div>
  );
});
