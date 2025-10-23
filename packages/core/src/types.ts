import { types } from 'node:util';

export function getConstructorName(obj: unknown): string | null {
  if (obj === null || obj === undefined) {
    return null;
  }
  const ctor = obj.constructor;
  if (!ctor || ctor.name === 'Object') {
    return null;
  }
  return ctor.name;
}

export function getConstructorNames(obj: unknown): string[] {
  const proto = Object.getPrototypeOf(obj);
  const name = getConstructorName(proto);
  if (name === null) {
    return [];
  }
  return [name, ...getConstructorNames(proto)];
}

/**
 * `instanceof` operator that works across different `vm` contexts,
 * based on the `name` property of the constructors of the prototype chain.
 */
export function isInstanceOf<T>(
  v: unknown,
  ctor: new (...args: any[]) => T
): v is T {
  return getConstructorNames(v).includes(ctor.name);
}

export function getErrorName(v: unknown): string {
  if (types.isNativeError(v)) {
    return v.name;
  }
  return 'Error';
}

export function getErrorStack(v: unknown): string {
  if (types.isNativeError(v)) {
    return v.stack ?? '';
  }
  return '';
}
