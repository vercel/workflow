import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimestampTooltip } from './timestamp-tooltip';

const NOW = new Date('2026-11-18T03:33:23.263Z');
const DAY = 24 * 60 * 60 * 1000;

describe('TimestampTooltip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a relative time label when it has no children', () => {
    vi.useFakeTimers({ now: NOW });

    expect(
      renderToStaticMarkup(
        createElement(TimestampTooltip, { date: NOW.getTime() - 3 * DAY })
      )
    ).toContain('3 days ago');
  });

  it('renders its children in place of the label', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TimestampTooltip,
        { date: NOW },
        createElement('span', null, 'Nov 17 22:33:23.26')
      )
    );

    expect(markup).toContain('Nov 17 22:33:23.26');
    expect(markup).not.toContain('ago');
  });

  it('renders nothing for a missing date and no children', () => {
    expect(
      renderToStaticMarkup(createElement(TimestampTooltip, { date: null }))
    ).toBe('');
  });
});
