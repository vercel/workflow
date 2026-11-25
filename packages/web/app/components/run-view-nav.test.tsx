import { afterEach, describe, expect, it } from 'vitest';
import { focusRunView } from './run-view-nav';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusRunView', () => {
  it('focuses the Usage page’s content', () => {
    document.body.innerHTML = `
      <div id="root">
        <section tabindex="-1" data-run-view="usage">Usage</section>
      </div>`;
    const root = document.getElementById('root');
    expect(focusRunView(root, 'usage')).toBe(true);
    expect(document.activeElement?.getAttribute('data-run-view')).toBe('usage');
  });

  it('focuses the selected tab, not another one', () => {
    document.body.innerHTML = `
      <div id="root">
        <button role="tab" data-state="inactive">Trace</button>
        <button role="tab" data-state="active">Events</button>
      </div>`;
    const root = document.getElementById('root');
    expect(focusRunView(root, 'tabs')).toBe(true);
    expect(document.activeElement?.textContent).toBe('Events');
  });

  it('reports a view that has not rendered yet', () => {
    // While the navigation is pending, the old page is still in the
    // document: the run page's tabs, but no Usage content.
    document.body.innerHTML = `
      <div id="root">
        <button role="tab" data-state="active">Trace</button>
      </div>`;
    const root = document.getElementById('root');
    expect(focusRunView(root, 'usage')).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
