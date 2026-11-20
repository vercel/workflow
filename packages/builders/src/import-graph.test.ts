import { afterEach, describe, expect, it } from 'vitest';
import {
  importParents,
  parentHasChild,
} from './discover-entries-esbuild-plugin.js';
import { entryReachability, ImportGraph } from './import-graph.js';

function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('entryReachability', () => {
  afterEach(() => {
    importParents.clear();
  });

  it('matches parentHasChild for every file and entry on random graphs', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seededRandom(seed);
      const pick = (count: number) => Math.floor(random() * count);
      const fileCount = 1 + pick(14);
      const files = Array.from({ length: fileCount + 2 }, (_, i) => `/f${i}`);
      importParents.clear();
      for (let edge = pick(fileCount * 3); edge > 0; edge--) {
        importParents.addEdge(files[pick(fileCount)], files[pick(fileCount)]);
      }
      const entries = Array.from(
        { length: pick(4) },
        () => files[pick(files.length)]
      );

      const reach = entryReachability(importParents, entries);

      for (const file of files) {
        expect(reach.entries.has(file)).toBe(entries.includes(file));
        expect(reach.leadsToEntry.has(file)).toBe(
          entries.some((entry) => parentHasChild(file, entry))
        );
        expect(reach.reachedFromEntry.has(file)).toBe(
          entries.some((entry) => parentHasChild(entry, file))
        );
      }
    }
  });

  it('handles cycles, self imports and diamonds', () => {
    importParents.addEdge('/a', '/b');
    importParents.addEdge('/b', '/a');
    importParents.addEdge('/c', '/c');
    importParents.addEdge('/top', '/left');
    importParents.addEdge('/top', '/right');
    importParents.addEdge('/left', '/entry');
    importParents.addEdge('/right', '/entry');
    importParents.addEdge('/entry', '/a');

    const reach = entryReachability(importParents, ['/entry', '/c']);

    expect([...reach.leadsToEntry].sort()).toEqual([
      '/c',
      '/left',
      '/right',
      '/top',
    ]);
    expect([...reach.reachedFromEntry].sort()).toEqual(['/a', '/b', '/c']);
  });
});

describe('ImportGraph version', () => {
  it('changes on every mutation and only then', () => {
    const graph = new ImportGraph();
    const seen = [graph.version];
    const expectChanged = (changed: boolean) => {
      expect(graph.version !== seen.at(-1)).toBe(changed);
      seen.push(graph.version);
    };

    graph.addEdge('/a', '/b');
    expectChanged(true);
    graph.addEdge('/a', '/c');
    expectChanged(true);
    graph.addEdge('/a', '/c');
    expectChanged(false);
    graph.set('/d', new Set());
    expectChanged(true);
    graph.delete('/d');
    expectChanged(true);
    graph.clear();
    expectChanged(true);
  });
});
