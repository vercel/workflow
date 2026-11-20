import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  Menu,
  MenuContent,
  MenuTrigger,
  ResolveHookDropdownItem,
  TooltipProvider,
} from '@workflow/web-shared';
import type { Hook } from '@workflow/world';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunActionsButtons } from './run-actions';

const api = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  recreateRun: vi.fn(),
  reenqueueRun: vi.fn(async () => {}),
  wakeUpRun: vi.fn(),
}));
vi.mock('~/lib/workflow-api-client', () => api);
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// jsdom lacks the popover, animation and layout APIs menus use.
beforeAll(() => {
  HTMLElement.prototype.showPopover = () => {};
  HTMLElement.prototype.hidePopover = () => {};
  Element.prototype.getAnimations = () => [];
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.checkVisibility = () => true;
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  document.elementsFromPoint = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunActionsButtons', () => {
  it('re-enqueues from the More actions menu with the keyboard', async () => {
    render(
      <TooltipProvider>
        <RunActionsButtons
          env={{}}
          runId="wrun_1"
          runStatus="running"
          events={[]}
        />
      </TooltipProvider>
    );

    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);

    const reenqueue = await screen.findByRole('menuitem', {
      name: 'Re-enqueue',
    });
    expect(reenqueue.hasAttribute('aria-disabled')).toBe(false);
    expect(
      screen
        .getByRole('menuitem', { name: 'Cancel Active Sleeps' })
        .getAttribute('aria-disabled')
    ).toBe('true');

    await act(async () => {
      reenqueue.focus();
      fireEvent.keyDown(reenqueue, { key: 'Enter' });
    });

    expect(api.reenqueueRun).toHaveBeenCalledWith({}, 'wrun_1');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('ResolveHookDropdownItem', () => {
  it('renders a menu item of the shared Menu when no item component is passed', async () => {
    const onResolveClick = vi.fn();
    const hook = { hookId: 'hook_1', runId: 'wrun_1' } as Hook;
    render(
      <Menu>
        <MenuTrigger aria-label="Hook actions">…</MenuTrigger>
        <MenuContent>
          <ResolveHookDropdownItem
            hook={hook}
            onResolveClick={onResolveClick}
          />
        </MenuContent>
      </Menu>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hook actions' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Resolve Hook' })
    );

    expect(onResolveClick).toHaveBeenCalledWith(hook);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
