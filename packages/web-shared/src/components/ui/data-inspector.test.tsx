// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { collapseRefs, DataInspector, isBytesDisplay } from './data-inspector';

afterEach(cleanup);

function renderInspector(data: unknown, expandLevel = 3) {
  return render(<DataInspector data={data} expandLevel={expandLevel} />);
}

function tree(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.wf-json-view');
  if (!el) throw new Error('inspector container not found');
  return el;
}

function texts(container: HTMLElement, selector: string): string[] {
  return Array.from(container.querySelectorAll(selector)).map(
    (n) => n.textContent ?? ''
  );
}

describe('collapseRefs', () => {
  it('converts typed arrays to a bytes-display marker', () => {
    const result = collapseRefs({ delta: new Uint8Array([1, 2, 3]) }) as {
      delta: unknown;
    };
    expect(isBytesDisplay(result.delta)).toBe(true);
  });

  it('converts typed arrays nested inside arrays', () => {
    const result = collapseRefs([new Uint8Array([1])]) as unknown[];
    expect(isBytesDisplay(result[0])).toBe(true);
  });

  it('leaves plain primitives untouched', () => {
    expect(collapseRefs(42)).toBe(42);
    expect(collapseRefs('hi')).toBe('hi');
    expect(collapseRefs(null)).toBe(null);
    expect(collapseRefs(undefined)).toBe(undefined);
  });

  it('does not convert a DataView (only array views)', () => {
    const view = new DataView(new ArrayBuffer(4));
    expect(collapseRefs(view)).toBe(view);
  });

  it('leaves Date instances untouched', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(collapseRefs(date)).toBe(date);
  });

  it('preserves Map and Set containers while collapsing their contents', () => {
    const map = collapseRefs(new Map([['k', new Uint8Array([1])]])) as Map<
      string,
      unknown
    >;
    expect(map).toBeInstanceOf(Map);
    expect(isBytesDisplay(map.get('k'))).toBe(true);

    const set = collapseRefs(new Set([new Uint8Array([1])])) as Set<unknown>;
    expect(set).toBeInstanceOf(Set);
    expect(isBytesDisplay([...set][0])).toBe(true);
  });

  it('recurses into plain objects but returns a new object', () => {
    const input = { a: { b: 1 } };
    const result = collapseRefs(input) as typeof input;
    expect(result).not.toBe(input);
    expect(result.a.b).toBe(1);
  });
});

describe('DataInspector rendering', () => {
  it('renders object keys, typed value colors, and quotes strings', () => {
    const { container } = renderInspector({
      name: 'exec',
      count: 3,
      ok: true,
      missing: null,
    });
    const root = tree(container);

    expect(texts(root, '.wf-json-label')).toEqual([
      'name:',
      'count:',
      'ok:',
      'missing:',
    ]);
    expect(texts(root, '.wf-json-string')).toContain('"exec"');
    expect(texts(root, '.wf-json-number')).toContain('3');
    expect(texts(root, '.wf-json-boolean')).toContain('true');
    expect(texts(root, '.wf-json-null')).toContain('null');
  });

  it('renders undefined with its own value style', () => {
    const { container } = renderInspector({ closureVars: undefined });
    expect(texts(tree(container), '.wf-json-undefined')).toEqual(['undefined']);
  });

  it('renders brackets and trailing commas between entries', () => {
    const { container } = renderInspector({ a: 1, b: 2 });
    const punctuation = texts(tree(container), '.wf-json-punctuation');
    expect(punctuation).toContain('{');
    expect(punctuation).toContain('}');
    // one comma after the first (non-last) entry, none after the last
    expect(punctuation.filter((p) => p === ',')).toHaveLength(1);
  });

  it('renders array elements without keys, using square brackets', () => {
    const { container } = renderInspector([1, 'two']);
    const root = tree(container);
    expect(root.querySelectorAll('.wf-json-label')).toHaveLength(0);
    const punctuation = texts(root, '.wf-json-punctuation');
    expect(punctuation).toContain('[');
    expect(punctuation).toContain(']');
  });

  it('renders an empty object as {} with no expander or ... indicator', () => {
    const { container } = renderInspector({});
    const root = tree(container);
    expect(texts(root, '.wf-json-punctuation')).toEqual(['{', '}']);
    expect(root.querySelector('[data-json-expander]')).toBeNull();
    expect(root.querySelector('.wf-json-collapsed-content')).toBeNull();
  });

  it('renders an empty array as []', () => {
    const { container } = renderInspector([]);
    expect(texts(tree(container), '.wf-json-punctuation')).toEqual(['[', ']']);
    expect(tree(container).querySelector('[data-json-expander]')).toBeNull();
  });

  it('collapses nodes deeper than expandLevel and shows the ... indicator', () => {
    const { container } = renderInspector({ outer: { inner: 1 } }, 1);
    const root = tree(container);
    // outer (level 1) is collapsed
    expect(root.querySelector('.wf-json-collapsed-content')).not.toBeNull();
    // its child is not rendered yet
    expect(texts(root, '.wf-json-label')).not.toContain('inner:');
  });

  it('expands a collapsed node when its expander is clicked', () => {
    const { container } = renderInspector({ outer: { inner: 1 } }, 1);
    const root = tree(container);
    // the collapsed node's expander carries the expand-icon class (the expanded
    // root carries collapse-icon), so this targets `outer`, not the root.
    const expander = root.querySelector<HTMLButtonElement>(
      '.wf-json-expand-icon[data-json-expander]'
    );
    expect(expander).not.toBeNull();
    fireEvent.click(expander as HTMLButtonElement);
    expect(texts(tree(container), '.wf-json-label')).toContain('inner:');
  });

  it('renders Dates as ISO strings with the date style', () => {
    const { container } = renderInspector({
      at: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(texts(tree(container), '.wf-json-date')).toEqual([
      '2026-01-02T03:04:05.000Z',
    ]);
  });

  it('prefixes class instances, Maps, and Sets with a type name', () => {
    class Widget {
      id = 1;
    }
    const { container } = renderInspector({
      widget: new Widget(),
      m: new Map([['k', 'v']]),
      s: new Set([1]),
    });
    const classNames = texts(tree(container), '.wf-json-classname');
    expect(classNames).toContain('Widget');
    expect(classNames).toContain('Map');
    expect(classNames).toContain('Set');
  });
});
