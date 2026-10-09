'use client';

import { IconPause, IconPlayFill } from '@vercel/geistdocs/assets/icons';
import { Button } from '@vercel/geistdocs/components/button';
import NextImage from 'next/image';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { type MetricModel, models, modelTitle } from './models';

/**
 * Each metric's animation in public/performance/explainers: its file prefix and its size in
 * CSS pixels. The files are rendered at 2x for the docs content width, with the code above
 * the timeline, by the durabench explainer recorder (`node record.mjs docs`).
 */
const animations: Record<
  MetricModel['id'],
  { file: string; width: number; height: number }
> = {
  ttfs: { file: '01-ttfs', width: 720, height: 688 },
  stso: { file: '02-stso', width: 720, height: 744 },
  fanout: { file: '03-fanout', width: 720, height: 1022 },
  resume: { file: '04-resume', width: 720, height: 710 },
  stream: { file: '05-stream', width: 720, height: 784 },
};

const source = (metric: MetricModel['id'], theme: 'light' | 'dark') =>
  `/performance/explainers/${animations[metric].file}-${theme}`;

/** The animation's last frame, in the light and the dark rendering. */
const Still = ({ metric, alt }: { metric: MetricModel['id']; alt: string }) => {
  const { width, height } = animations[metric];
  return (['light', 'dark'] as const).map((theme) => (
    <NextImage
      alt={alt}
      className={cn(
        'block h-auto w-full',
        theme === 'light'
          ? '[.dark-theme_&]:hidden!'
          : '[.light-theme_&]:hidden!'
      )}
      height={height}
      key={theme}
      sizes="(min-width: 768px) 720px, 100vw"
      src={`${source(metric, theme)}-poster.webp`}
      width={width}
    />
  ));
};

/**
 * Plays the animation while it is on screen. Readers who prefer reduced motion see the
 * finished timeline until they press play; the reader's own play or pause always wins.
 */
const usePlayback = (theme: 'light' | 'dark') => {
  const [mounted, setMounted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [choice, setChoice] = useState<'play' | 'pause' | null>(null);
  const [visible, setVisible] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    setMounted(true);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.25 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const showVideo = mounted && (choice !== null || !reducedMotion);
  const playing = showVideo && choice !== 'pause';

  // `theme` re-runs this when the video element is replaced for the other theme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const node = video.current;
    if (!node || !showVideo) return;
    if (playing && visible) {
      node.play().catch((error: unknown) => {
        // A browser that blocks autoplay leaves the animation paused until the reader
        // presses play. An interrupted play() (the effect re-running) is not a refusal.
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          setChoice('pause');
        }
      });
    } else {
      node.pause();
    }
  }, [playing, visible, showVideo, theme]);

  return {
    frame,
    video,
    mounted,
    showVideo,
    playing,
    toggle: () => setChoice(playing ? 'pause' : 'play'),
  };
};

/**
 * A looping animation of how one benchmark metric is measured, with a light and a dark
 * rendering. It plays muted while it is on screen, can be paused, and shows its last frame
 * as a still image for readers who prefer reduced motion.
 */
export const MetricVideo = ({
  metric,
  children,
}: {
  metric: MetricModel['id'];
  /** Caption shown under the animation. */
  children?: ReactNode;
}) => {
  const id = useId();
  const model = models.find((m) => m.id === metric);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const { frame, video, mounted, showVideo, playing, toggle } =
    usePlayback(theme);

  if (!model) return null;
  const { width, height } = animations[metric];
  const label = `Animation: how ${modelTitle(model)} is measured`;

  return (
    <figure className="not-prose my-8 flex w-full max-w-full flex-col gap-4">
      <div
        className="relative overflow-hidden rounded-lg border border-gray-400 bg-background-100 shadow-[var(--ds-shadow-small)]"
        ref={frame}
      >
        {showVideo ? (
          <video
            aria-describedby={children ? `${id}-caption` : undefined}
            aria-label={label}
            className="block h-auto w-full"
            height={height}
            key={theme}
            loop
            muted
            playsInline
            poster={`${source(metric, theme)}-poster.webp`}
            preload="metadata"
            ref={video}
            width={width}
          >
            <source src={`${source(metric, theme)}.mp4`} type="video/mp4" />
          </video>
        ) : (
          <Still alt={label} metric={metric} />
        )}
        {mounted ? (
          <Button
            aria-label={playing ? 'Pause animation' : 'Play animation'}
            className="absolute right-3 bottom-3"
            onClick={toggle}
            prefix={
              playing ? <IconPause size={16} /> : <IconPlayFill size={16} />
            }
            size="small"
            variant="secondary"
          >
            {playing ? 'Pause' : 'Play'}
          </Button>
        ) : null}
      </div>
      {children ? (
        <figcaption
          className={cn(
            'mx-auto max-w-[640px] text-center text-copy-14 text-gray-900 max-[600px]:px-4',
            '[&_a]:text-gray-1000 [&_a]:underline [&_a]:decoration-gray-700 [&_a]:underline-offset-4',
            '[&_code]:font-mono [&_code]:text-[13px]'
          )}
          id={`${id}-caption`}
        >
          {children}
        </figcaption>
      ) : null}
    </figure>
  );
};
