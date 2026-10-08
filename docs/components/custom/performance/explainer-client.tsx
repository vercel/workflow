'use client';

import {
  IconPause,
  IconPlayFill,
  IconRefreshCounterClockwise,
} from '@vercel/geistdocs/assets/icons';
import { Button } from '@vercel/geistdocs/components/button';
import { CodeBlock } from '@vercel/geistdocs/components/code-block';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ms, versions } from '@/lib/performance';
import { cn } from '@/lib/utils';
import { type MetricModel, models, modelTitle } from './models';
import { Timeline } from './timeline';

/** Shiki tokens for each model's code, one array per line, keyed by model id. */
export type ModelTokens = Record<
  MetricModel['id'],
  { content: string; color?: string }[][]
>;

/** How long one play-through of a run takes. */
const PLAY_MS = 6000;
/** The timeline is drawn at least this wide and scrolls in narrower containers. */
const MIN_TIMELINE_WIDTH = 420;

const Definition = ({ text }: { text: string }) => (
  <>
    {text.split('`').map((part, i) =>
      i % 2 ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text segments
        <code key={i}>{part}</code>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text segments
        <Fragment key={i}>{part}</Fragment>
      )
    )}
  </>
);

/** What the clock is doing at playhead `t`, for screen readers and the status line. */
const describe = (model: MetricModel, t: number) => {
  const unique = (labels: string[]) => [...new Set(labels)];
  if (t >= 100) {
    return `Clock stopped: ${unique(model.brackets.map((b) => b.label)).join(', ')}.`;
  }
  const running = unique(
    model.brackets.filter((b) => t > b.from && t < b.to).map((b) => b.label)
  );
  const stopped = unique(
    model.brackets.filter((b) => t >= b.to).map((b) => b.label)
  );
  if (running.length) {
    return `Clock running: ${running.join(', ')}.${
      stopped.length ? ` Stopped: ${stopped.join(', ')}.` : ''
    }`;
  }
  return stopped.length
    ? `Stopped: ${stopped.join(', ')}.`
    : 'Clock not started yet.';
};

const usePrefersReducedMotion = () => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
};

const useWidth = <T extends HTMLElement>(fallback: number) => {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};

export const PerformanceExplainerClient = ({
  tokens,
}: {
  tokens: ModelTokens;
}) => {
  const id = useId();
  const [index, setIndex] = useState(0);
  const [t, setT] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const [timelineRef, timelineWidth] = useWidth<HTMLDivElement>(560);
  const frame = useRef(0);
  const model = models[index];

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const play = () => {
    if (playing) {
      stop();
      return;
    }
    // With reduced motion, jump to the finished run instead of animating it.
    if (reducedMotion) {
      setT(100);
      setPlayed(true);
      return;
    }
    let from = t >= 100 ? 0 : t;
    let prev = performance.now();
    setT(from);
    setPlaying(true);
    const tick = (now: number) => {
      from = Math.min(100, from + ((now - prev) / PLAY_MS) * 100);
      prev = now;
      setT(from);
      if (from < 100) {
        frame.current = requestAnimationFrame(tick);
      } else {
        frame.current = 0;
        setPlaying(false);
        setPlayed(true);
      }
    };
    frame.current = requestAnimationFrame(tick);
  };

  const select = (next: number) => {
    stop();
    setIndex(next);
    setT(100);
    setPlayed(false);
  };

  const status = describe(model, t);
  const lines = tokens[model.id];
  const active = (i: number) =>
    t < 100 && (model.code[i].at ?? []).some(([a, b]) => t >= a && t < b);

  const playLabel = playing ? 'Pause' : t >= 100 && played ? 'Replay' : 'Play';
  const PlayIcon = playing
    ? IconPause
    : t >= 100 && played
      ? IconRefreshCounterClockwise
      : IconPlayFill;

  return (
    <figure
      aria-labelledby={`${id}-title`}
      className="not-prose my-8 flex flex-col gap-6 rounded-lg border border-gray-400 bg-background-100 p-4 sm:p-6"
    >
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Benchmark</legend>
        {models.map((m, i) => (
          <Button
            aria-pressed={i === index}
            key={m.id}
            onClick={() => select(i)}
            size="small"
            variant={i === index ? 'default' : 'secondary'}
          >
            {m.name}
          </Button>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <p
          className="m-0 font-semibold text-gray-1000 text-heading-20"
          id={`${id}-title`}
        >
          {modelTitle(model)}
        </p>
        <p className="m-0 text-copy-14 text-gray-900 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-gray-1000">
          <Definition text={model.definition} />
        </p>
      </div>

      <div className="min-w-0 overflow-x-auto" ref={timelineRef}>
        <Timeline
          model={model}
          t={t}
          width={Math.max(MIN_TIMELINE_WIDTH, timelineWidth)}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <Button
          className="self-start"
          onClick={play}
          prefix={<PlayIcon size={16} />}
          size="small"
          variant="secondary"
        >
          {playLabel}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            className="text-gray-900 text-label-13"
            htmlFor={`${id}-scrub`}
          >
            Run timeline
          </label>
          <input
            aria-valuetext={status}
            className="w-full accent-[var(--ds-gray-1000)]"
            id={`${id}-scrub`}
            max={100}
            min={0}
            onChange={(event) => {
              stop();
              setT(Number(event.target.value));
            }}
            step={0.5}
            type="range"
            value={t}
          />
        </div>
      </div>

      <p aria-live="polite" className="-mt-3 m-0 text-copy-13 text-gray-900">
        {status}
      </p>

      <CodeBlock
        className={cn(
          'my-0! min-w-0',
          '[&_.line]:transition-opacity motion-reduce:[&_.line]:transition-none',
          t < 100 && '[&_.line:not([data-active=true])]:opacity-40'
        )}
      >
        {lines.map((line, i) => (
          <Fragment key={`${model.id}-${i}`}>
            {i > 0 ? '\n' : null}
            <span
              className={cn('line', model.code[i].mark && 'font-semibold')}
              data-active={active(i) || undefined}
            >
              {line.length
                ? line.map((tok, j) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder
                      key={j}
                      style={tok.color ? { color: tok.color } : undefined}
                    >
                      {tok.content}
                    </span>
                  ))
                : ' '}
            </span>
          </Fragment>
        ))}
      </CodeBlock>

      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-copy-14 sm:grid-cols-[max-content_minmax(0,1fr)]">
        {model.results.map((r) => (
          <Fragment key={r.label}>
            <dt className="font-medium text-gray-1000">{r.label}, p75</dt>
            <dd className="m-0 mb-2 text-gray-900 sm:mb-0">
              {ms(r.next)} on {versions.next}, {ms(r.v4)} on {versions.v4}
            </dd>
          </Fragment>
        ))}
      </dl>

      <figcaption className="flex flex-col gap-1 text-copy-13 text-gray-900">
        {model.note ? <span>{model.note}</span> : null}
        <span>Illustrative timing, not to scale.</span>
      </figcaption>
    </figure>
  );
};
