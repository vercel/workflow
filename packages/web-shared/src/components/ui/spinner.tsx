import type { CSSProperties } from 'react';

const KEYFRAMES = `@keyframes wf-spinner-fade{0%{opacity:1}100%{opacity:.15}}`;

interface SpinnerConfig {
  angle: number;
  delays: number[];
  duration: number;
  lineW: number;
  lineH: number;
}

function getSpinnerConfig(size: number): SpinnerConfig {
  if (size <= 12) {
    return {
      angle: 45,
      delays: [-875, -750, -625, -500, -375, -250, -125, 0],
      duration: 1000,
      lineW: 3,
      lineH: 1.5,
    };
  }
  if (size <= 16) {
    return {
      angle: 36,
      delays: [-900, -800, -700, -600, -500, -400, -300, -200, -100, 0],
      duration: 1000,
      lineW: 4,
      lineH: 1.5,
    };
  }
  return {
    angle: 30,
    delays: [
      -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200, -100, 0,
    ],
    duration: 1200,
    lineW: size * 0.24,
    lineH: size * 0.08,
  };
}

export interface SpinnerProps {
  /** Diameter in pixels. 8, 10 or 12 bars are drawn depending on size. */
  size?: number;
  /** Bar colour. Defaults to the tertiary gray token. */
  color?: string;
  /**
   * Accessible label. When set, the spinner is announced as a loading
   * status. Leave it unset when the spinner sits inside a control that
   * already describes the pending state, such as a busy button.
   */
  label?: string;
}

/**
 * Multi-line fade spinner, for short indeterminate waits that have no final
 * shape to draw a skeleton for (a pending button, an inline refresh).
 */
export function Spinner({ size = 14, color, label }: SpinnerProps) {
  const config = getSpinnerConfig(size);

  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      {...(label
        ? { role: 'status', 'aria-label': label }
        : { 'aria-hidden': true })}
    >
      {/* React 19 hoists and dedupes this <style> by href, so the keyframes
          are emitted once however many spinners are mounted. */}
      <style href="wf-spinner" precedence="default">
        {KEYFRAMES}
      </style>
      {config.delays.map((delay, i) => {
        const style: CSSProperties = {
          width: config.lineW,
          height: config.lineH,
          marginLeft: -config.lineW / 2,
          marginTop: -config.lineH / 2,
          backgroundColor: color,
          transform: `rotate(${i * config.angle}deg) translate(${size * 0.36}px)`,
          animationDuration: `${config.duration}ms`,
          animationDelay: `${delay}ms`,
        };
        return (
          <span
            key={delay}
            className="absolute top-1/2 left-1/2 rounded-[1px] bg-gray-700 [animation-iteration-count:infinite] [animation-name:wf-spinner-fade] [animation-timing-function:linear]"
            style={style}
          />
        );
      })}
    </span>
  );
}
