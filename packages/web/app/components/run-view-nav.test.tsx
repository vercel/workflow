import { afterEach, describe, expect, it } from 'vitest';
import { focusRunViewItem } from './run-view-nav';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusRunViewItem', () => {
  it('skips the old row’s inactive item while a navigation is pending', () => {
    // The run page's row is still in the document, its Usage link inactive.
    document.body.innerHTML = `
      <div id="root">
        <a href="/run/r/usage" data-run-view-item="usage">Usage</a>
      </div>`;
    const root = document.getElementById('root');
    expect(focusRunViewItem(root, 'usage')).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('focuses the new page’s current Usage link', () => {
    document.body.innerHTML = `
      <div id="root">
        <a href="/run/r/usage" data-run-view-item="usage">Usage</a>
        <nav><a href="/run/r/usage" data-run-view-item="usage" aria-current="page">Usage</a></nav>
      </div>`;
    const root = document.getElementById('root');
    expect(focusRunViewItem(root, 'usage')).toBe(true);
    expect(document.activeElement?.getAttribute('aria-current')).toBe('page');
  });

  it('focuses the selected tab, not the Usage page’s link of that name', () => {
    document.body.innerHTML = `
      <div id="root">
        <a href="/run/r?tab=events" data-run-view-item="events">Events</a>
        <button role="tab" data-run-view-item="events" data-state="active">Events</button>
      </div>`;
    const root = document.getElementById('root');
    expect(focusRunViewItem(root, 'events')).toBe(true);
    expect(document.activeElement?.getAttribute('role')).toBe('tab');
  });
});
