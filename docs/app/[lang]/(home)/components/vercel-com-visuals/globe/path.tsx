'use client';

import type { CSSProperties, JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { diameter, radius } from './constants';
import {
  _r,
  distance,
  drawGreatArc,
  drawHorizontalLine,
  getPerspectiveLatitudeSegment,
  removeClosePoints,
} from './utils';
import type { Path, Point } from './types';
import { useGlobeContext } from './context';
import styles from './path.module.css';

interface PathProps {
  color?: string;
  p3Color?: string;
  delay?: number;
  duration?: number;
  gradientSizeMultiplier?: number;
  linearTiming?: boolean;
  maxSegmentDuration?: number;
  onAnimateComplete?: () => void;
  onAnimationCompleteOffset?: number;
  path: Path;
  repeat?: number;
  repeatDelay?: number;
  gradientMask?: boolean;
  'data-testid'?: string;
}

// biome-ignore lint/suspicious/noRedeclare: matches upstream
export function Path({
  path,
  delay = 0,
  repeatDelay = 0,
  duration,
  maxSegmentDuration = 0.3,
  gradientSizeMultiplier = 1,
  repeat = 0,
  linearTiming = false,
  color = 'white',
  p3Color,
  onAnimateComplete,
  onAnimationCompleteOffset = 0,
  gradientMask,
}: PathProps): JSX.Element {
  const [jsLoaded, setJsLoaded] = useState(false);

  const {
    longitudeDivisions,
    latitudeDivisions,
    longitudeSegmentLength,
    matrixRelativeToOrigin,
    debug,
    perspectiveConstant,
  } = useGlobeContext();

  const id = `${path.directions.split('').join('')}${path.origin.x}${
    path.origin.y
  }`;
  const gradient = `${id}-gradient`;

  const { pathPoints, d } = createPath();

  const xPath = [
    pathPoints.at(0)?.x,
    ...pathPoints.map((p) => p.x),
    pathPoints.at(-1)?.x,
  ] as number[];

  const yPath = [
    pathPoints.at(0)?.y,
    ...pathPoints.map((p) => p.y),
    pathPoints.at(-1)?.y,
  ] as number[];

  const xPathAhead = [
    ...pathPoints.map((p) => p.x),
    pathPoints.at(-1)?.x,
    pathPoints.at(-1)?.x,
  ] as number[];

  const yPathAhead = [
    ...pathPoints.map((p) => p.y),
    pathPoints.at(-1)?.y,
    pathPoints.at(-1)?.y,
  ] as number[];

  const numPoints = xPath.length;
  const numDirections = path.directions.length;

  const segmentDuration = duration
    ? duration / numDirections
    : maxSegmentDuration;

  const distances = xPath.map((_, i) =>
    distance(
      { x: xPath[i], y: yPath[i] },
      { x: xPathAhead[i], y: yPathAhead[i] }
    )
  );
  const maxDistance = Math.max(...distances);

  const keyTimes = distances.map(
    (dist) => (dist / maxDistance) * segmentDuration
  );

  const sumTimes = keyTimes.reduce((a, b) => a + b, 0);

  let total = 0;
  const times = keyTimes.map((t) => {
    const time = t / sumTimes;
    total += time;
    return total;
  });

  // remove the last element from timings
  times.pop();

  // insert 0 at the beginning
  times.unshift(0);

  // make second to last times the average between the last and 3rd to last time
  times[times.length - 2] =
    (times[times.length - 1] + times[times.length - 3]) / 2;

  // make the second time the average between the first and third time
  times[1] = (times[0] + times[2]) / 2;

  const opacityKeys = Array.from({ length: numPoints }).map((_, i) =>
    i === 0 || i === numPoints - 1 ? 0 : 1
  );

  const radiusKeys = xPath.map((_, i) =>
    i === 0 || i === numPoints - 1
      ? 0
      : (radius / Math.max(longitudeDivisions, latitudeDivisions)) *
        gradientSizeMultiplier
  );

  const transition = {
    duration: segmentDuration * numDirections,
    repeatDelay,
    repeat,
    ease: 'linear',
    times: linearTiming ? times : undefined,
    delay,
  };

  function createPath(): { d: string; pathPoints: Point[] } {
    let dPath = '';
    const points: Point[] = [];
    let x = path.origin.x;
    let y = path.origin.y;

    path.directions.split('').forEach((dir, i) => {
      const latitudeSegmentLength = getPerspectiveLatitudeSegment(
        longitudeDivisions,
        x,
        perspectiveConstant
      );
      const xRadius = latitudeSegmentLength * x;

      const angleFromY = (_y: number): number => {
        return toDegrees(Math.acos((longitudeSegmentLength * _y) / radius));
      };

      function toDegrees(radians: number): number {
        return (radians * 180) / Math.PI;
      }
      const onRight = x > 0;
      const onLeft = x < 0;
      const centered = x === 0;

      switch (dir.toLowerCase()) {
        case 'u': {
          const upArc = drawGreatArc(
            xRadius,
            radius,
            angleFromY(y),
            angleFromY(y + 1),
            onRight
          );

          dPath += upArc.d;

          if (i === 0)
            points.push(onLeft || centered ? upArc.end : upArc.start);
          points.push(onLeft || centered ? upArc.start : upArc.end);

          y += 1;

          break;
        }
        case 'd': {
          const downArc = drawGreatArc(
            xRadius,
            radius,
            angleFromY(y),
            angleFromY(y - 1),
            onLeft
          );

          dPath += downArc.d;

          if (i === 0)
            points.push(onRight || centered ? downArc.end : downArc.start);
          points.push(onRight || centered ? downArc.start : downArc.end);

          y -= 1;

          break;
        }
        case 'l': {
          const leftStart = matrixRelativeToOrigin(x, y);
          const leftEnd = matrixRelativeToOrigin(x - 1, y);
          const leftLine = drawHorizontalLine(
            leftStart.x,
            leftEnd.x,
            leftStart.y
          );
          dPath += leftLine.d;

          points.push(leftLine.start, leftLine.end);
          x -= 1;
          break;
        }
        case 'r': {
          const rightStart = matrixRelativeToOrigin(x, y);
          const rightEnd = matrixRelativeToOrigin(x + 1, y);
          const rightLine = drawHorizontalLine(
            rightStart.x,
            rightEnd.x,
            rightStart.y
          );
          dPath += rightLine.d;

          points.push(rightLine.start, rightLine.end);

          x += 1;
          break;
        }
        default:
          throw new Error(`Unknown direction ${dir}`);
      }
    });

    return { d: dPath, pathPoints: removeClosePoints(points) };
  }

  const transitionProps = {
    delay,
    duration: segmentDuration * numDirections,
    id,
    repeat,
    repeatCount: repeat === Number.POSITIVE_INFINITY ? 'indefinite' : repeat,
    repeatDelay,
  };

  const AnimateCX = (
    <AnimateAttribute {...transitionProps} attributeName="cx" values={xPath} />
  );
  const AnimateCY = (
    <AnimateAttribute {...transitionProps} attributeName="cy" values={yPath} />
  );
  const AnimateR = (
    <AnimateAttribute
      {...transitionProps}
      attributeName="r"
      values={radiusKeys}
    />
  );
  const AnimateOpacity = (
    <AnimateAttribute
      {...transitionProps}
      attributeName="opacity"
      values={opacityKeys}
    />
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: matches upstream
  useEffect(() => {
    setJsLoaded(true);
    if (!onAnimateComplete || repeat === Number.POSITIVE_INFINITY) return;
    const id = setTimeout(
      () => {
        onAnimateComplete();
      },
      (transition.duration * (repeat + 1) +
        transition.delay +
        onAnimationCompleteOffset) *
        1000
    );
    return () => clearTimeout(id);
  }, []);

  return (
    <g
      id={id}
      mask={gradientMask ? 'url(#globe-gradient-mask)' : undefined}
      opacity={jsLoaded ? 1 : 0}
    >
      <path
        d={d}
        fill="none"
        stroke={`url(#${gradient})`}
        strokeLinecap="round"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      >
        {AnimateOpacity}
      </path>
      {debug ? (
        <>
          <g opacity={0.3}>
            <rect
              fill={`url(#${gradient})`}
              height={diameter}
              width={diameter}
              x={0}
              y={0}
            >
              {AnimateOpacity}
            </rect>
          </g>
          <path
            d={d}
            fill="none"
            opacity={0.5}
            stroke="#888888"
            strokeLinecap="round"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <circle fill="none" r={8} stroke="#ffffff88">
            {AnimateOpacity}
            {AnimateCX}
            {AnimateCY}
          </circle>
        </>
      ) : null}
      <defs>
        <radialGradient
          className={styles.gradient}
          cx={100}
          cy={100}
          gradientUnits="userSpaceOnUse"
          id={gradient}
          r={0}
          style={
            {
              '--normal-color': color,
              '--p3-color': p3Color,
            } as CSSProperties
          }
        >
          <stop offset="0" stopColor="var(--color)" />
          <stop offset="0.4" stopColor="var(--color)" />
          <stop offset="1" stopColor="var(--color)" stopOpacity={0} />
          {AnimateCX}
          {AnimateCY}
          {AnimateR}
        </radialGradient>
      </defs>
    </g>
  );
}

export function AnimateAttribute({
  attributeName,
  values,
  delay,
  repeatCount = 'indefinite',
  repeatDelay,
  duration,
  id,
}: {
  attributeName: string;
  values: (string | number)[];
  delay: number;
  repeatCount?: number | string | undefined;
  repeatDelay: number;
  duration: number;
  id: string;
}): JSX.Element {
  const _id = `${attributeName}-${id}`;
  const totalDur = repeatDelay + duration;
  const proportionOfRepeatDelay = repeatDelay / totalDur;
  const normalizedTotalDur = 1 - proportionOfRepeatDelay;
  const ref = useRef<SVGAnimateElement>(null);
  const shouldReduceMotion = useReducedMotion();

  // biome-ignore lint/correctness/useExhaustiveDependencies: matches upstream
  useEffect(() => {
    if (!ref.current) return;
    ref.current.endElement();
    const id = setTimeout(() => {
      if (!ref.current) return;
      ref.current.beginElement();
    }, delay * 1000);
    return () => clearTimeout(id);
  }, []);

  const keyTimes = `${values
    .map((_, i) => {
      const time = i / (values.length - 1);
      return _r(time * normalizedTotalDur);
    })
    .join(';')};1`;

  const adjustedValues = `${values.map((v) => _r(v)).join(';')};0`;

  return (
    <animate
      attributeName={attributeName}
      dur={`${totalDur}s`}
      id={_id}
      keyTimes={keyTimes}
      ref={ref}
      repeatCount={shouldReduceMotion ? 3 : repeatCount}
      values={adjustedValues}
    />
  );
}
