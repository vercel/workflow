'use client';

import type { CSSProperties } from 'react';
import { useMemo, type PropsWithChildren, useCallback } from 'react';
import { Path } from './path';
import { Node } from './node';
import { diameter, radius, strokeWidth } from './constants';
import {
  dKey,
  drawGreatArc,
  drawHorizontalLine,
  getPerspectiveLatitudeSegment,
} from './utils';
import type { Point } from './types';
import { GlobeContext } from './context';

interface GlobeProps {
  half?: boolean;
  longitudeDivisions: number;
  latitudeDivisions: number;
  topLit?: boolean;
  fill?: string;
  debug?: boolean;
  color?: string;
  gradientMask?: boolean;
  style?: CSSProperties;
  className?: string;
  perspectiveConstant?: number;
}

function Globe({
  debug = false,
  children,
  color,
  half,
  longitudeDivisions = 8,
  latitudeDivisions = 10,
  topLit,
  fill,
  gradientMask,
  className,
  style,
  perspectiveConstant = 1 / 4,
}: PropsWithChildren<GlobeProps>): React.ReactNode {
  const longitudeSegmentLength = diameter / latitudeDivisions;

  const arcs = Array.from({ length: longitudeDivisions + 1 }, (_, i) => i)
    .map((x) => x - longitudeDivisions / 2)
    .map((x) => {
      const latitudeSegmentLength = getPerspectiveLatitudeSegment(
        longitudeDivisions,
        x,
        perspectiveConstant
      );
      const xRadius = latitudeSegmentLength * x;
      const arc = drawGreatArc(xRadius, radius, 0, 180, x > 0);
      return arc;
    });

  function createPerspectiveMatrix(): Point[][] {
    const matrix: Point[][] = [];
    for (let y = 0; y < latitudeDivisions; y++) {
      const row: Point[] = [];
      arcs.forEach((arc) => {
        const yScaled = y * longitudeSegmentLength;
        row.push({ x: arc.getXPointOnEllipse(yScaled), y: yScaled });
      });
      matrix.push(row);
    }
    return matrix;
  }

  const nodeMatrix = createPerspectiveMatrix();

  const xToTopLeft = useCallback(
    (x: number): number => {
      return x + longitudeDivisions / 2;
    },
    [longitudeDivisions]
  );

  const yToTopLeft = useCallback(
    (y: number): number => {
      return latitudeDivisions / 2 - y;
    },
    [latitudeDivisions]
  );

  const matrixRelativeToOrigin = useCallback(
    (x: number, y: number): Point => {
      return nodeMatrix[yToTopLeft(y)][xToTopLeft(x)];
    },
    [nodeMatrix, xToTopLeft, yToTopLeft]
  );

  const contextValue = useMemo(
    () => ({
      longitudeDivisions,
      latitudeDivisions,
      nodeMatrix,
      longitudeSegmentLength,
      matrixRelativeToOrigin,
      debug,
      perspectiveConstant,
    }),
    [
      longitudeDivisions,
      latitudeDivisions,
      nodeMatrix,
      longitudeSegmentLength,
      matrixRelativeToOrigin,
      debug,
      perspectiveConstant,
    ]
  );

  return (
    <svg
      aria-hidden
      className={className}
      height="100%"
      style={style}
      viewBox={`-${strokeWidth} -${strokeWidth} ${diameter + strokeWidth * 2} ${
        diameter - (half ? radius : 0) + strokeWidth * 2
      }`}
      width="100%"
    >
      <g
        data-testid="globe-wireframe"
        mask={gradientMask ? 'url(#globe-gradient-mask)' : undefined}
      >
        <circle cx={radius} cy={radius} fill={fill || 'none'} r={radius} />
        {arcs.map((arc) => {
          return (
            <path
              d={arc.d}
              fill="none"
              key={`arc-${dKey(arc.d)}`}
              stroke="url(#globe-gradient)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {nodeMatrix.map((row, y) => {
          const start = row[0];
          const end = row[row.length - 1];
          const line = drawHorizontalLine(start.x, end.x, start.y);
          if (y === 0) return null;
          return (
            <path
              d={line.d}
              fill="none"
              key={`line-${dKey(line.d)}`}
              stroke="url(#globe-gradient)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </g>
      {gradientMask ? (
        <mask id="globe-gradient-mask">
          <rect
            fill="url(#globe-mask-gradient)"
            height="100%"
            width="100%"
            x="0"
            y="0"
          />
        </mask>
      ) : null}
      <GlobeContext.Provider value={contextValue}>
        {children}
      </GlobeContext.Provider>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="globe-gradient"
          x1="0"
          x2={0}
          y1="0"
          y2={radius}
        >
          <stop offset="0%" stopColor={color ? color : 'var(--ds-gray-500)'} />
          <stop
            offset="100%"
            stopColor={
              color
                ? color
                : topLit
                  ? 'var(--ds-gray-100)'
                  : 'var(--ds-gray-500)'
            }
          />
        </linearGradient>
        {gradientMask ? (
          <linearGradient
            gradientTransform="rotate(90)"
            id="globe-mask-gradient"
          >
            <stop offset=".7" stopColor="white" stopOpacity="1" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
        ) : null}
      </defs>
    </svg>
  );
}
// Reassign the Globe components to the Globe object
Globe.Path = Path;
Globe.Node = Node;

export { Globe };
