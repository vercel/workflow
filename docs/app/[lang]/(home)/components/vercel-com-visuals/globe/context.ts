import { createContext, useContext } from 'react';
import type { Point } from './types';

interface GlobeContextProps {
  longitudeDivisions: number;
  latitudeDivisions: number;
  longitudeSegmentLength: number;
  nodeMatrix: Point[][];
  debug: boolean;
  matrixRelativeToOrigin: (x: number, y: number) => Point;
  perspectiveConstant: number;
}

export const GlobeContext = createContext<GlobeContextProps>({
  longitudeDivisions: 0,
  latitudeDivisions: 0,
  longitudeSegmentLength: 0,
  nodeMatrix: [],
  debug: false,
  matrixRelativeToOrigin: () => ({ x: 0, y: 0 }),
  perspectiveConstant: 1 / 4,
});
GlobeContext.displayName = 'GlobeContext';

export function useGlobeContext(): GlobeContextProps {
  return useContext(GlobeContext);
}
