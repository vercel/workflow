import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttributePanel } from '../src/components/sidebar/attribute-panel.js';

/**
 * Metadata rows for long identifiers (Hook ID, Token) must expose a copy
 * button so users can grab the full value even when the row truncates.
 */
describe('AttributePanel metadata copy support', () => {
  it('renders copy buttons for Hook ID and Token', () => {
    const hookId = 'hook_01KX4GF2S98CCYQ3C5PVX4QDJA';
    const token = 'wrun_01KX4GF2HAAJBS2G5RDZT6V6EF:auth_token_value';

    const markup = renderToStaticMarkup(
      createElement(AttributePanel, {
        data: {
          hookId,
          token,
          moduleSpecifier: 'eve',
          receivedCount: 0,
          createdAt: new Date('2026-07-09T22:37:39.420Z'),
        },
      })
    );

    expect(markup).toContain(`aria-label="Copy Hook ID"`);
    expect(markup).toContain(`aria-label="Copy Token"`);
    expect(markup).toContain(hookId);
    expect(markup).toContain(token);
  });

  it('does not render a copy button for Times Resolved', () => {
    const markup = renderToStaticMarkup(
      createElement(AttributePanel, {
        data: {
          hookId: 'hook_abc',
          token: 'tok_abc',
          receivedCount: 0,
        },
      })
    );

    expect(markup).toContain('aria-label="Copy Hook ID"');
    expect(markup).toContain('aria-label="Copy Token"');
    expect(markup).not.toContain('aria-label="Copy Times Resolved"');
  });
});
