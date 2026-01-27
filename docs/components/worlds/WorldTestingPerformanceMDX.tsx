'use client';

import { useWorldData } from './WorldDataProvider';
import { WorldTestingPerformance } from './WorldTestingPerformance';

/**
 * MDX-usable wrapper for WorldTestingPerformance.
 * Uses WorldDataContext to get the world data, so it must be used within a WorldDataProvider.
 */
export function WorldTestingPerformanceMDX() {
  const { worldId, world, meta } = useWorldData();
  return (
    <WorldTestingPerformance worldId={worldId} world={world} meta={meta} />
  );
}
