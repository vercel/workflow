'use client';

import type { JSX } from 'react';
import { Globe } from './globe';

export function PlainGlobe(): JSX.Element {
  return (
    <Globe
      color="var(--guide-color)"
      fill="var(--ds-background-200)"
      gradientMask
      half
      latitudeDivisions={8}
      longitudeDivisions={8}
      style={{ overflow: 'visible' }}
    >
      {IDLE_PATHS.map((path, i) => {
        const key = `idle-path-plain-globe-${path.directions}-${path.origin.x}-${path.origin.y}`;
        return (
          <Globe.Path
            color={path.color}
            data-testid={key}
            delay={0.15 * i}
            gradientMask
            gradientSizeMultiplier={1}
            key={key}
            maxSegmentDuration={0.8}
            p3Color={path.p3Color}
            path={path}
            repeat={Number.POSITIVE_INFINITY}
            repeatDelay={2.5}
          />
        );
      })}
    </Globe>
  );
}

const IDLE_PATHS = [
  {
    origin: {
      x: 3,
      y: 3,
    },
    directions: 'lldll',
    color: '#EBE51A',
    p3Color: 'color(display-p3 0.9176 0.898 0.3137)',
  },
  {
    origin: {
      x: 2,
      y: 2,
    },
    directions: 'ld',
    color: '#A4E600',
    p3Color: 'color(display-p3 0.698 0.8941 0.2667)',
  },
  {
    origin: {
      x: 3,
      y: 1,
    },
    directions: 'lull',
    color: '#2DDD69',
    p3Color: 'color(display-p3 0.4235 0.8549 0.4627)',
  },
  {
    origin: {
      x: 2,
      y: 1,
    },
    directions: 'llld',
    color: '#FF904D',
    p3Color: 'color(display-p3 0.9843 0.5882 0.3608)',
  },
  {
    origin: {
      x: -1,
      y: 3,
    },
    directions: 'lld',
    color: '#62DE00',
    p3Color: 'color(display-p3 0.5176 0.8588 0.251)',
  },
  {
    origin: {
      x: -2,
      y: 2,
    },
    directions: 'lld',
    color: '#FFBB3D',
    p3Color: 'color(display-p3 0.9608 0.7451 0.3412)',
  },
  {
    origin: {
      x: -1,
      y: 1,
    },
    directions: 'llld',
    color: '#F8E52C',
    p3Color: 'color(display-p3 0.9608 0.8988 0.3412)',
  },
];
