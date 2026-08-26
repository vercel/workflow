// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataInspector } from '../src/components/ui/data-inspector.js';
import { getWebRevivers } from '../src/lib/hydration.js';

const REVIVERS = getWebRevivers();

class TestIterable implements Iterable<string | [string, string]> {
  constructor(private readonly items: Array<string | [string, string]>) {}

  *[Symbol.iterator]() {
    yield* this.items;
  }
}

function* generateValue(value: string) {
  yield value;
}

function hydrateHeaders(entries: [string, string][]): Headers {
  return REVIVERS.Headers(entries) as Headers;
}

function hydrateSearchParams(value: string): URLSearchParams {
  return REVIVERS.URLSearchParams(value) as URLSearchParams;
}

describe('DataInspector iterables', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(data: unknown, expandLevel = 0) {
    act(() => {
      root.render(createElement(DataInspector, { data, expandLevel }));
    });
  }

  function getExpandableRow(): HTMLElement {
    const row = container.querySelector<HTMLElement>('[data-json-expander]');
    if (!row) throw new Error('expected an expandable inspector row');
    return row;
  }

  it('renders hydrated Headers as an expandable container', () => {
    render(hydrateHeaders([['content-type', 'application/json']]));

    const row = getExpandableRow();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toContain('Headers');
  });

  it('expands hydrated Headers to render their entries', () => {
    render(hydrateHeaders([['content-type', 'application/json']]));
    const row = getExpandableRow();

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(row.textContent).toContain('content-type:');
    expect(row.textContent).toContain('"application/json"');
  });

  it('renders and expands hydrated URLSearchParams entries', () => {
    render(hydrateSearchParams('page=2&sort=created'));
    const row = getExpandableRow();

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(row.textContent).toContain('URLSearchParams');
    expect(row.textContent).toContain('page:');
    expect(row.textContent).toContain('"2"');
    expect(row.textContent).toContain('sort:');
    expect(row.textContent).toContain('"created"');
  });

  it('expands custom Symbol.iterator implementations', () => {
    render(new TestIterable(['first', ['named', 'second']]));
    const row = getExpandableRow();

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(row.textContent).toContain('TestIterable');
    expect(row.textContent).toContain('0:');
    expect(row.textContent).toContain('"first"');
    expect(row.textContent).toContain('named:');
    expect(row.textContent).toContain('"second"');
  });

  it('updates when a distinct Headers instance has different entries', () => {
    render(hydrateHeaders([['x-version', 'one']]), 1);
    expect(container.textContent).toContain('"one"');

    render(hydrateHeaders([['x-version', 'two']]), 1);

    expect(container.textContent).toContain('"two"');
    expect(container.textContent).not.toContain('"one"');
  });

  it('updates when distinct URLSearchParams have different entries', () => {
    render(hydrateSearchParams('page=1'), 1);
    expect(container.textContent).toContain('"1"');

    render(hydrateSearchParams('page=2'), 1);

    expect(container.textContent).toContain('"2"');
    expect(container.textContent).not.toContain('"1"');
  });

  it('updates when distinct generic iterables yield different values', () => {
    render(new TestIterable(['one']), 1);
    expect(container.textContent).toContain('"one"');

    render(new TestIterable(['two']), 1);

    expect(container.textContent).toContain('"two"');
    expect(container.textContent).not.toContain('"one"');
  });

  it('preserves and updates self-iterating iterators', () => {
    const first = generateValue('one');
    render(first, 1);
    expect(container.textContent).toContain('"one"');

    render(first, 1);
    expect(container.textContent).toContain('"one"');

    render(generateValue('two'), 1);

    expect(container.textContent).toContain('"two"');
    expect(container.textContent).not.toContain('"one"');
  });
});
