import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DataInspector,
  isDeepEqual,
} from '../src/components/ui/data-inspector.js';
import { getWebRevivers } from '../src/lib/hydration.js';

const REVIVERS = getWebRevivers();

class TestIterable implements Iterable<string> {
  constructor(private readonly items: string[]) {}

  *[Symbol.iterator]() {
    yield* this.items;
  }
}

class CoordinatePairs implements Iterable<[number, number]> {
  *[Symbol.iterator]() {
    yield [1, 2];
    yield [3, 4];
  }
}

class MapLike {
  *[Symbol.iterator]() {
    yield 'wrong';
  }

  *entries() {
    yield ['color', 'blue'];
  }
}

function hydrateHeaders(entries: [string, string][]): Headers {
  return REVIVERS.Headers(entries) as Headers;
}

function hydrateSearchParams(value: string): URLSearchParams {
  return REVIVERS.URLSearchParams(value) as URLSearchParams;
}

function hydrateRequest(headers: [string, string][]): object {
  return REVIVERS.Request({
    method: 'GET',
    url: 'https://example.com',
    headers,
    body: null,
  }) as object;
}

function render(data: unknown, expandLevel = 1): string {
  return visibleText(
    renderToStaticMarkup(createElement(DataInspector, { data, expandLevel }))
  );
}

function visibleText(markup: string): string {
  return markup
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('DataInspector iterables', () => {
  it('renders hydrated Headers as an expandable container', () => {
    const markup = renderToStaticMarkup(
      createElement(DataInspector, {
        data: hydrateHeaders([['content-type', 'application/json']]),
        expandLevel: 0,
      })
    );

    expect(markup).toContain('data-json-expander');
    expect(visibleText(markup)).toContain('Headers');
    expect(visibleText(markup)).not.toContain('application/json');
  });

  it('expands hydrated Headers to render their entries', () => {
    const text = render(hydrateHeaders([['content-type', 'application/json']]));

    expect(text).toContain('content-type:');
    expect(text).toContain('"application/json"');
  });

  it('renders nested Headers on a hydrated Request', () => {
    const text = render(
      hydrateRequest([['content-type', 'application/json']]),
      2
    );

    expect(text).toContain('Request');
    expect(text).toContain('headers:');
    expect(text).toContain('Headers');
    expect(text).toContain('content-type:');
    expect(text).toContain('"application/json"');
  });

  it('renders and expands hydrated URLSearchParams entries', () => {
    const text = render(hydrateSearchParams('page=2&sort=created'));

    expect(text).toContain('URLSearchParams');
    expect(text).toContain('page:');
    expect(text).toContain('"2"');
    expect(text).toContain('sort:');
    expect(text).toContain('"created"');
  });

  it('keeps duplicate URLSearchParams keys', () => {
    const text = render(hydrateSearchParams('tag=a&tag=b'));

    expect(text).toContain('tag:');
    expect(text).toContain('"a"');
    expect(text).toContain('"b"');
  });

  it('expands custom Symbol.iterator implementations as a list', () => {
    const text = render(new TestIterable(['first', 'second']));

    expect(text).toContain('TestIterable');
    expect(text).toContain('"first"');
    expect(text).toContain('"second"');
    expect(text).not.toContain('0:');
  });

  it('does not treat 2-element yields as fields', () => {
    const text = render(new CoordinatePairs(), 2);

    expect(text).not.toContain('1:');
    expect(text).not.toContain('3:');
    expect(text).toContain('1');
    expect(text).toContain('2');
    expect(text).toContain('3');
    expect(text).toContain('4');
  });

  it('renders map-like values from entries() rather than the default iterator', () => {
    const text = render(new MapLike());

    expect(text).toContain('MapLike');
    expect(text).toContain('color:');
    expect(text).toContain('"blue"');
    expect(text).not.toContain('"wrong"');
  });

  it('treats Headers with different entries as unequal', () => {
    expect(
      isDeepEqual(
        hydrateHeaders([['x-version', 'one']]),
        hydrateHeaders([['x-version', 'two']])
      )
    ).toBe(false);
  });

  it('treats Headers with the same entries as equal', () => {
    expect(
      isDeepEqual(
        hydrateHeaders([['x-version', 'one']]),
        hydrateHeaders([['x-version', 'one']])
      )
    ).toBe(true);
  });

  it('treats URLSearchParams with different entries as unequal', () => {
    expect(
      isDeepEqual(hydrateSearchParams('page=1'), hydrateSearchParams('page=2'))
    ).toBe(false);
  });

  it('treats generic iterables with different values as unequal', () => {
    expect(
      isDeepEqual(new TestIterable(['one']), new TestIterable(['two']))
    ).toBe(false);
  });

  it('treats generic iterables with the same values as equal', () => {
    expect(
      isDeepEqual(new TestIterable(['one']), new TestIterable(['one']))
    ).toBe(true);
  });
});
