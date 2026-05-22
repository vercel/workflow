import { radius } from './constants';
import type { Point } from './types';

/**
 * Rounds a given number to three decimal places.
 */
export function _r(number: number | string): number {
  return Math.round(Number(number) * 1000) / 1000;
}

/**
 * Gives a valid react key given a string
 */
export function dKey(d: string): string {
  return d.replace(/ /g, '');
}

/**
 * Calculates the length of a latitude segment based on the perspective effect.
 */
export function getPerspectiveLatitudeSegment(
  longitudeDivisions: number,
  x: number,
  perspectiveConstant: number
): number {
  const mappedToCos =
    ((x + longitudeDivisions / 2) / longitudeDivisions) * Math.PI + Math.PI / 2;
  const perspective =
    (1 - Math.cos(mappedToCos)) * perspectiveConstant +
    (1 - perspectiveConstant);
  const latitudeSegmentLength =
    ((2 * radius) / longitudeDivisions) * perspective;
  return latitudeSegmentLength;
}

/**
 * Draws a great arc on an ellipse based on the given parameters.
 */
export function drawGreatArc(
  xRadius: number,
  yRadius: number,
  startAngle: number,
  endAngle: number,
  flipAngles = false
): {
  d: string;
  start: Point;
  end: Point;
  getXPointOnEllipse: (y: number) => number;
} {
  const adjustedStartAngle = flipAngles ? endAngle : startAngle;
  const adjustedEndAngle = flipAngles ? startAngle : endAngle;

  const start = polarToCartesian(
    radius,
    radius,
    xRadius,
    yRadius,
    adjustedEndAngle
  );
  const end = polarToCartesian(
    radius,
    radius,
    xRadius,
    yRadius,
    adjustedStartAngle
  );

  const largeArcFlag = adjustedEndAngle - adjustedStartAngle <= 180 ? '0' : '1';

  function getXPointOnEllipse(y: number): number {
    const r = radius;
    return r + xRadius * Math.sqrt(1 - (y - r) ** 2 / (r * r));
  }

  const d = [
    'M',
    _r(start.x),
    _r(start.y),
    'A',
    _r(xRadius),
    _r(yRadius),
    0,
    largeArcFlag,
    0,
    _r(end.x),
    _r(end.y),
  ].join(' ');

  return { d, getXPointOnEllipse, start, end };
}

/**
 * Draws a horizontal line on the SVG canvas.
 */
export function drawHorizontalLine(
  x1: number,
  x2: number,
  y: number
): {
  d: string;
  start: Point;
  end: Point;
} {
  const d = `M${_r(x1)},${_r(y)} h${_r(x2 - x1)}`;
  return {
    d,
    start: {
      x: x1,
      y,
    },
    end: {
      x: x2,
      y,
    },
  };
}

/**
 * Converts polar coordinates to Cartesian coordinates.
 */
function polarToCartesian(
  centerX: number,
  centerY: number,
  xRadius: number,
  yRadius: number,
  angleInDegrees: number
): Point {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;

  return {
    x: centerX + xRadius * Math.cos(angleInRadians),
    y: centerY + yRadius * Math.sin(angleInRadians),
  };
}

/**
 * Calculates the Euclidean distance between two points.
 */
export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Removes closely spaced points from an array of points.
 */
export function removeClosePoints(points: Point[]): Point[] {
  if (points.length < 2) {
    return points;
  }

  const result: Point[] = [points[0]];
  let currentIndex = 1;

  while (currentIndex < points.length) {
    const currentPoint = points[currentIndex];
    const lastPoint = result[result.length - 1];
    const dist = distance(currentPoint, lastPoint);

    if (dist >= 0.1) {
      result.push(currentPoint);
    }

    currentIndex++;
  }

  return result;
}
