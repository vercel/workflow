export class ImportGraph extends Map<string, Set<string>> {
  private changes = 0;

  get version(): number {
    return this.changes;
  }

  addEdge(parent: string, child: string): void {
    const children = this.get(parent);
    if (!children) {
      this.set(parent, new Set([child]));
    } else if (!children.has(child)) {
      children.add(child);
      this.changes++;
    }
  }

  override set(key: string, value: Set<string>): this {
    this.changes++;
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    this.changes++;
    return super.delete(key);
  }

  override clear(): void {
    this.changes++;
    super.clear();
  }
}

export interface EntryReachability {
  readonly entries: ReadonlySet<string>;
  readonly leadsToEntry: ReadonlySet<string>;
  readonly reachedFromEntry: ReadonlySet<string>;
}

export function entryReachability(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  entries: Iterable<string>
): EntryReachability {
  const entrySet = new Set(entries);

  const parentsOf = new Map<string, string[]>();
  for (const [parent, children] of graph) {
    for (const child of children) {
      const parents = parentsOf.get(child);
      if (parents) parents.push(parent);
      else parentsOf.set(child, [parent]);
    }
  }

  return {
    entries: entrySet,
    leadsToEntry: reachableFrom(entrySet, (file) => parentsOf.get(file)),
    reachedFromEntry: reachableFrom(entrySet, (file) => graph.get(file)),
  };
}

function reachableFrom(
  roots: Iterable<string>,
  neighbors: (file: string) => Iterable<string> | undefined
): Set<string> {
  const reached = new Set<string>();
  const stack = [...roots];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    for (const next of neighbors(file) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      stack.push(next);
    }
  }
  return reached;
}
