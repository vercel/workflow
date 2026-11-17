import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button.js';
import { Spinner } from '../src/components/ui/spinner.js';

/** How many fading lines a render contains. */
function spinnerLines(markup: string) {
  return (markup.match(/animation-name:spinner-opacity/g) ?? []).length;
}

const icon = createElement('svg', { 'data-testid': 'prefix-icon' });

describe('Button loading', () => {
  it('keeps the label, disables the button and marks it busy', () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { loading: true, prefix: icon }, 'Save')
    );

    expect(markup).toContain('Save');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    // The spinner takes the prefix's slot instead of sitting beside it.
    expect(markup).not.toContain('prefix-icon');
  });

  it('renders the prefix and no busy state when idle', () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { prefix: icon }, 'Save')
    );

    expect(markup).toContain('prefix-icon');
    expect(markup).not.toContain('aria-busy');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('role="status"');
  });

  it('keeps asChild working with and without a prefix', () => {
    const plain = renderToStaticMarkup(
      createElement(
        Button,
        { asChild: true },
        createElement('a', { href: '/docs' }, 'Docs')
      )
    );
    // The link becomes the button and keeps its text as the label.
    expect(plain).toMatch(
      /^<a [^>]*href="\/docs"[^>]*><span [^>]*>Docs<\/span><\/a>$/
    );

    const decorated = renderToStaticMarkup(
      createElement(
        Button,
        { asChild: true, prefix: icon },
        createElement('a', { href: '/docs' }, 'Docs')
      )
    );
    expect(decorated).toMatch(/^<a [^>]*href="\/docs"/);
    expect(decorated).toContain('prefix-icon');
    expect(decorated).toContain('Docs</span></a>');
  });
});

describe('Button spinner size', () => {
  it('scales the loading spinner with the button', () => {
    const lines = (size?: 'small' | 'medium' | 'large') =>
      spinnerLines(
        renderToStaticMarkup(
          createElement(Button, { loading: true, size }, 'Save')
        )
      );

    expect(lines('small')).toBe(8);
    expect(lines('medium')).toBe(10);
    expect(lines(undefined)).toBe(10);
    expect(lines('large')).toBe(12);
  });
});

describe('Spinner', () => {
  it('keeps a pixel size as the box and uses the nearest named lines', () => {
    const markup = renderToStaticMarkup(createElement(Spinner, { size: 14 }));

    expect(markup).toContain('width:14px;height:14px');
    expect(spinnerLines(markup)).toBe(10);
  });

  it('defaults to the 20px spinner', () => {
    const markup = renderToStaticMarkup(createElement(Spinner));

    expect(markup).toContain('width:20px;height:20px');
    expect(spinnerLines(markup)).toBe(12);
  });
});
