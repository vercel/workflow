/** @vitest-environment jsdom */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataInspector } from '../src/components/ui/data-inspector.js';

class CachedIteratorIterable implements Iterable<string> {
  private iterator: Iterator<string> | undefined;

  constructor(private readonly values: string[]) {}

  [Symbol.iterator](): Iterator<string> {
    this.iterator ??= this.values[Symbol.iterator]();
    return this.iterator;
  }
}

class UndefinedEntriesIterable implements Iterable<string> {
  *[Symbol.iterator]() {
    yield 'fallback';
  }

  entries(): undefined {
    return undefined;
  }
}

class NonPairEntriesIterable implements Iterable<string> {
  *[Symbol.iterator]() {
    yield 'fallback';
  }

  *entries() {
    yield 'not-a-pair';
  }
}

describe('DataInspector live iterables', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(data: unknown, expandLevel = 1): string {
    flushSync(() => {
      root.render(createElement(DataInspector, { data, expandLevel }));
    });
    return container.textContent ?? '';
  }

  it('preserves a generator across renders', () => {
    function* values() {
      yield 1;
      yield 2;
    }

    const data = values();
    const firstRender = render(data);
    const secondRender = render(data);

    expect(firstRender).toContain('1');
    expect(firstRender).toContain('2');
    expect(secondRender).toBe(firstRender);
  });

  it('preserves the first item when a cached iterator replaces another', () => {
    render(new CachedIteratorIterable(['old']));

    const replacement = render(
      new CachedIteratorIterable(['first', 'second'])
    );

    expect(replacement).toContain('"first"');
    expect(replacement).toContain('"second"');
  });

  it('bounds iterable consumption while collapsed', () => {
    let consumed = 0;
    function* values() {
      while (consumed < 10_000) {
        consumed += 1;
        yield consumed;
      }
    }

    render(values(), 0);

    expect(consumed).toBeLessThan(10_000);
  });

  it('renders a row when an iterable snapshot is truncated', () => {
    function* values() {
      for (let value = 0; value < 10_000; value += 1) {
        yield value;
      }
    }

    expect(render(values())).toContain('truncated');
  });

  it('falls back when entries() does not return an iterable', () => {
    expect(render(new UndefinedEntriesIterable())).toContain('"fallback"');
  });

  it('falls back when entries() does not produce pairs', () => {
    const output = render(new NonPairEntriesIterable());

    expect(output).toContain('"fallback"');
    expect(output).not.toContain('"not-a-pair"');
  });
});
