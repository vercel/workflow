import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button.js';

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
    expect(plain).toMatch(/^<a [^>]*href="\/docs"[^>]*>Docs<\/a>$/);

    const decorated = renderToStaticMarkup(
      createElement(
        Button,
        { asChild: true, prefix: icon },
        createElement('a', { href: '/docs' }, 'Docs')
      )
    );
    expect(decorated).toMatch(/^<a [^>]*href="\/docs"/);
    expect(decorated).toContain('prefix-icon');
    expect(decorated).toContain('Docs</a>');
  });
});
