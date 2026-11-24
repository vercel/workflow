import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflowArgs } from './start-workflow-dialog';
import { WorkflowsList } from './workflows-list';

const { navigate, startWorkflowRun, toast } = vi.hoisted(() => ({
  navigate: vi.fn(),
  startWorkflowRun: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('sonner', () => ({ toast }));
vi.mock('~/lib/workflow-api-client', () => ({ startWorkflowRun }));
// The graph viewer pulls in React Flow, which jsdom can't lay out; the sheet
// only needs to open.
vi.mock('~/components/flow-graph/workflow-graph-viewer', () => ({
  WorkflowGraphViewer: () => <div data-testid="graph-viewer" />,
}));
vi.mock('~/lib/flow-graph/use-workflow-graph', () => ({
  useWorkflowGraphManifest: () => ({
    loading: false,
    error: null,
    manifest: {
      workflows: {
        'workflow//./workflows/order//processOrder': {
          workflowId: 'workflow//./workflows/order//processOrder',
          workflowName: 'processOrder',
          filePath: 'workflows/order.ts',
          nodes: [],
          edges: [],
        },
        'workflow//./workflows/mail//sendMail': {
          workflowId: 'workflow//./workflows/mail//sendMail',
          workflowName: 'sendMail',
          filePath: 'workflows/mail.ts',
          nodes: [],
          edges: [],
        },
      },
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function openStartDialog(workflowName: string) {
  const row = screen.getByText(workflowName).closest('tr');
  if (!row) throw new Error(`no row for ${workflowName}`);
  fireEvent.click(
    within(row).getByRole('button', { name: `Start ${workflowName}` })
  );
  return screen.getByRole('alertdialog');
}

function submit(dialog: HTMLElement, text: string) {
  fireEvent.change(within(dialog).getByLabelText('Inputs'), {
    target: { value: text },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
}

describe('WorkflowsList Start button', () => {
  it('renders a Start button on every workflow row', () => {
    render(<WorkflowsList />);
    for (const name of ['processOrder', 'sendMail']) {
      const row = screen.getByText(name).closest('tr');
      expect(row).not.toBeNull();
      expect(
        within(row as HTMLElement).getByRole('button', {
          name: `Start ${name}`,
        })
      ).toBeTruthy();
    }
  });

  it('opens the start dialog without opening the graph sheet', () => {
    render(<WorkflowsList />);
    const dialog = openStartDialog('processOrder');
    expect(within(dialog).getByText('Start processOrder')).toBeTruthy();
    expect(
      (within(dialog).getByLabelText('Inputs') as HTMLTextAreaElement).value
    ).toBe('[]');
    expect(screen.queryByTestId('graph-viewer')).toBeNull();
  });

  it('does not open the graph sheet when the dialog is dismissed by clicking outside it', () => {
    render(<WorkflowsList />);
    openStartDialog('processOrder');
    const overlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"]'
    );
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);
    expect(screen.queryByTestId('graph-viewer')).toBeNull();
  });

  it.each([
    ['invalid JSON', '["order_123"', 'Invalid JSON'],
    ['a non-array', '{"orderId":"order_123"}', 'must be a JSON array'],
  ])('shows an inline error for %s and does not call the server', (_, text, message) => {
    render(<WorkflowsList />);
    const dialog = openStartDialog('processOrder');
    submit(dialog, text);

    expect(within(dialog).getByRole('alert').textContent).toContain(message);
    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('starts the run and navigates to it', async () => {
    startWorkflowRun.mockResolvedValue({
      runId: 'wrun_new',
      appReachable: true,
    });
    render(<WorkflowsList />);
    const dialog = openStartDialog('processOrder');
    submit(dialog, '["order_123"]');

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/run/wrun_new'));
    expect(startWorkflowRun).toHaveBeenCalledWith(
      {},
      'workflow//./workflows/order//processOrder',
      ['order_123']
    );
    expect(toast.success).toHaveBeenCalledWith('New run started', {
      description: 'Run ID: wrun_new',
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("warns, and still opens the run, when the app didn't answer", async () => {
    startWorkflowRun.mockResolvedValue({
      runId: 'wrun_new',
      appReachable: false,
    });
    render(<WorkflowsList />);
    submit(openStartDialog('processOrder'), '[]');

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/run/wrun_new'));
    expect(toast.warning).toHaveBeenCalledWith(
      "Run created, but your app didn't respond",
      expect.objectContaining({
        description: expect.stringContaining('when the app is reachable'),
      })
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('puts the cursor in the inputs when the dialog opens', () => {
    render(<WorkflowsList />);
    const dialog = openStartDialog('processOrder');
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText('Inputs')
    );
  });

  it('shows the server error in a toast and stays on the page', async () => {
    startWorkflowRun.mockRejectedValue(new Error('No workflow named x'));
    render(<WorkflowsList />);
    const dialog = openStartDialog('processOrder');
    submit(dialog, '[]');

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to start run', {
        description: 'No workflow named x',
      })
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('shows Starting... and disables the button while the start is in flight', async () => {
    let resolve: (result: { runId: string; appReachable: boolean }) => void =
      () => {};
    startWorkflowRun.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(<WorkflowsList />);
    const dialog = openStartDialog('processOrder');
    submit(dialog, '[]');

    const button = await within(dialog).findByRole('button', {
      name: 'Starting...',
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve({ runId: 'wrun_new', appReachable: true });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/run/wrun_new'));
  });

  it('offers Start in the graph sheet header too', () => {
    render(<WorkflowsList />);
    fireEvent.click(screen.getByText('sendMail'));
    const sheet = screen.getByRole('dialog');
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Start sendMail' })
    );
    expect(
      within(screen.getByRole('alertdialog')).getByText('Start sendMail')
    ).toBeTruthy();
  });
});

describe('parseWorkflowArgs', () => {
  it('accepts an empty array and arrays of any JSON values', () => {
    expect(parseWorkflowArgs('[]')).toEqual({ ok: true, args: [] });
    expect(parseWorkflowArgs(' ["a", 1, null, {"b": [2]}] ')).toEqual({
      ok: true,
      args: ['a', 1, null, { b: [2] }],
    });
  });

  it.each([
    '',
    'order_123',
    '"order_123"',
    '42',
    'null',
    '{}',
  ])('rejects %j', (text) => {
    expect(parseWorkflowArgs(text).ok).toBe(false);
  });
});
