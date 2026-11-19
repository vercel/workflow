/**
 * Internal: finding and applying changes between two versions of a frozen
 * value, for storing state passed between steps by reference (see
 * `serialization/state-refs.ts`).
 *
 * A frozen value can't change, so an object that appears in both versions is
 * unchanged and needs no comparison. Changes are recorded in Workflow's own
 * format, which is stored in the event log and never depends on immer.
 */

/** @internal */
export type StatePath = readonly (string | number)[];

/**
 * @internal
 * Workflow's own change format. It is stored in the event log, so it never depends on immer.
 */
export type StateOp =
  | { readonly op: 'set'; readonly path: StatePath; readonly value: unknown }
  | { readonly op: 'del'; readonly path: StatePath }
  | {
      readonly op: 'append';
      readonly path: StatePath;
      readonly items: readonly unknown[];
    }
  /** The object's keys in their new order, when it is not old keys then new ones. */
  | {
      readonly op: 'order';
      readonly path: StatePath;
      readonly keys: readonly string[];
    };

type Dict = Record<string, unknown>;

/** @internal */
export function isPlainObject(value: unknown): value is Dict {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Whether two plain objects are the same kind: both null-prototype
 * dictionaries, or both ordinary objects. Not the prototypes themselves: an
 * object made in workflow code has the workflow VM's `Object.prototype`, one
 * revived from a step output the host's.
 */
function sameKind(a: object, b: object): boolean {
  return (
    (Object.getPrototypeOf(a) === null) === (Object.getPrototypeOf(b) === null)
  );
}

/**
 * @internal
 * Whether two state values hold the same data: identical, or equal plain
 * objects, arrays, dates and byte arrays. Lets a recipe return rebuilt copies
 * without every copied subtree counting as a change.
 */
export function sameState(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    // A plain loop, not every(): holes must match holes.
    for (let i = 0; i < a.length; i++)
      if (i in a !== i in b || !sameState(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    const otherKeys = Object.keys(b);
    // Same keys in the same order: code may iterate objects in insertion order.
    return (
      sameKind(a, b) &&
      keys.length === otherKeys.length &&
      keys.every((k, i) => otherKeys[i] === k && sameState(a[k], b[k]))
    );
  }
  return false;
}

/**
 * @internal
 * The changes from `base` to `next`, found by identity: immer shares every
 * unchanged subtree, so only changed paths are visited. An array that only grew
 * at the end becomes one `append`; any other array change replaces the array.
 */
export function diffState(
  base: unknown,
  next: unknown,
  path: (string | number)[] = [],
  out: StateOp[] = []
): StateOp[] {
  if (Object.is(base, next)) return out;
  if (Array.isArray(base) && Array.isArray(next)) {
    // Holes are skipped by element comparisons, so a sparse array is stored whole.
    if (hasHoles(base) || hasHoles(next)) {
      out.push({ op: 'set', path, value: next });
      return out;
    }
    if (
      next.length >= base.length &&
      base.every((value, i) => sameState(value, next[i]))
    ) {
      if (next.length > base.length)
        out.push({ op: 'append', path, items: next.slice(base.length) });
    } else if (next.length === base.length) {
      for (let i = 0; i < next.length; i++)
        diffState(base[i], next[i], [...path, i], out);
    } else {
      out.push({ op: 'set', path, value: next });
    }
    return out;
  }
  if (isPlainObject(base) && isPlainObject(next) && sameKind(base, next)) {
    const baseKeys = Object.keys(base);
    const nextKeys = Object.keys(next);
    for (const key of baseKeys)
      if (!Object.hasOwn(next, key))
        out.push({ op: 'del', path: [...path, key] });
    for (const key of nextKeys) {
      if (!Object.hasOwn(base, key))
        out.push({ op: 'set', path: [...path, key], value: next[key] });
      else diffState(base[key], next[key], [...path, key], out);
    }
    // Code may iterate objects in insertion order, so a changed order is a change.
    const expected = [
      ...baseKeys.filter((key) => Object.hasOwn(next, key)),
      ...nextKeys.filter((key) => !Object.hasOwn(base, key)),
    ];
    if (expected.some((key, index) => key !== nextKeys[index]))
      out.push({ op: 'order', path, keys: nextKeys });
    return out;
  }
  if (!sameState(base, next)) out.push({ op: 'set', path, value: next });
  return out;
}

function hasHoles(array: readonly unknown[]): boolean {
  for (let i = 0; i < array.length; i++) if (!(i in array)) return true;
  return false;
}

/** @internal */
export function opsBytes(ops: readonly StateOp[]): number {
  try {
    return JSON.stringify(ops)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Plain-object state may have own properties named `__proto__`, `constructor`
 * or `prototype`. Reading only own properties and writing with
 * `defineProperty` keeps them ordinary data and never reaches a prototype.
 */
function ownValue(object: Dict, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}
function setOwn(object: Dict, key: string, value: unknown): void {
  // Assignment is much cheaper than `defineProperty`, but assigning a key the
  // object inherits, such as `__proto__`, can reach its prototype instead of
  // creating own data.
  if (!Object.hasOwn(object, key) && key in object) {
    Object.defineProperty(object, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    object[key] = value;
  }
}
function copyObject(object: Dict): Dict {
  const copy: Dict =
    Object.getPrototypeOf(object) === null ? Object.create(null) : {};
  for (const key of Object.keys(object)) setOwn(copy, key, object[key]);
  return copy;
}

/**
 * Copies only the containers on each changed path; everything else stays
 * shared. A container copied earlier in the same `applyStateOps` call is
 * reachable from nothing but the value being built, so later changes update
 * it in place instead of copying it again.
 */
function updateIn(
  value: unknown,
  path: StatePath,
  at: number,
  update: (value: unknown) => unknown,
  fresh: WeakSet<object>
): unknown {
  if (at === path.length) return update(value);
  const key = path[at] as string | number;
  if (Array.isArray(value)) {
    const copy = fresh.has(value) ? value : value.slice();
    fresh.add(copy);
    copy[Number(key)] = updateIn(
      value[Number(key)],
      path,
      at + 1,
      update,
      fresh
    );
    return copy;
  }
  if (!isPlainObject(value))
    throw new Error('State change does not match its base');
  const copy = fresh.has(value) ? value : copyObject(value);
  fresh.add(copy);
  setOwn(
    copy,
    String(key),
    updateIn(ownValue(value, String(key)), path, at + 1, update, fresh)
  );
  return copy;
}

/** @internal */
export function applyStateOps(base: unknown, ops: readonly StateOp[]): unknown {
  const fresh = new WeakSet<object>();
  let value = base;
  for (const change of ops) {
    if (change.op === 'set')
      value = updateIn(value, change.path, 0, () => change.value, fresh);
    else if (change.op === 'append')
      value = updateIn(
        value,
        change.path,
        0,
        (array) => {
          if (!Array.isArray(array))
            throw new Error('State append does not match its base');
          if (fresh.has(array)) {
            for (const item of change.items) array.push(item);
            return array;
          }
          const grown = [...array, ...change.items];
          fresh.add(grown);
          return grown;
        },
        fresh
      );
    else if (change.op === 'order')
      value = updateIn(
        value,
        change.path,
        0,
        (object) => {
          if (
            !isPlainObject(object) ||
            change.keys.length !== Object.keys(object).length ||
            !change.keys.every((key) => Object.hasOwn(object, key))
          )
            throw new Error('State key order does not match its base');
          const copy: Dict =
            Object.getPrototypeOf(object) === null ? Object.create(null) : {};
          for (const key of change.keys) setOwn(copy, key, object[key]);
          fresh.add(copy);
          return copy;
        },
        fresh
      );
    else {
      const parent = change.path.slice(0, -1);
      const key = change.path[change.path.length - 1] as string | number;
      value = updateIn(
        value,
        parent,
        0,
        (object) => {
          if (!isPlainObject(object))
            throw new Error('State delete does not match its base');
          const copy = fresh.has(object) ? object : copyObject(object);
          fresh.add(copy);
          delete copy[String(key)];
          return copy;
        },
        fresh
      );
    }
  }
  return value;
}
