import { Button } from '@workflow/web-shared';
import { Play } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import type { EnvMap } from '~/lib/types';
import { startWorkflowRun } from '~/lib/workflow-api-client';

const DEFAULT_INPUT = '[]';

export type ParsedWorkflowArgs =
  | { ok: true; args: unknown[] }
  | { ok: false; error: string };

/** Parse the dialog's text as a JSON array of workflow arguments. */
export function parseWorkflowArgs(text: string): ParsedWorkflowArgs {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: 'Inputs must be a JSON array, for example ["order_123"].',
    };
  }
  return { ok: true, args: value };
}

interface StartWorkflowButtonProps {
  workflowId: string;
  workflowName: string;
}

// The web UI passes an empty env; the server reads its own configuration.
const EMPTY_ENV: EnvMap = {};

export function StartWorkflowButton({
  workflowId,
  workflowName,
}: StartWorkflowButtonProps) {
  const navigate = useNavigate();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (starting) return;
    setOpen(next);
    if (!next) {
      setError(null);
    }
  };

  const handleStart = async () => {
    if (starting) return;
    const parsed = parseWorkflowArgs(input);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const newRunId = await startWorkflowRun(
        EMPTY_ENV,
        workflowId,
        parsed.args
      );
      toast.success('New run started', {
        description: `Run ID: ${newRunId}`,
      });
      setOpen(false);
      navigate(`/run/${newRunId}`);
    } catch (err) {
      toast.error('Failed to start run', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    // Rows open the graph sheet on click. React bubbles clicks from the
    // dialog's portal (its overlay included) up this tree too, so stop them
    // here, once, for the button and everything the dialog renders.
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops propagation
    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="secondary"
        size="small"
        prefix={<Play />}
        onClick={() => setOpen(true)}
      >
        Start
      </Button>
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start {workflowName}</AlertDialogTitle>
            <AlertDialogDescription>
              Inputs as a JSON array, one item per workflow argument. Only plain
              JSON works here: text, numbers, true/false, null, lists and
              objects. Dates, Maps, streams, class instances and other values
              need <code>start()</code> in your code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <label htmlFor={inputId} className="text-gray-900 text-label-13">
              Inputs
            </label>
            <textarea
              id={inputId}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (error) setError(null);
              }}
              rows={6}
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={starting}
            />
            {error && (
              <p
                id={`${inputId}-error`}
                role="alert"
                className="text-sm text-red-800"
              >
                {error}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={starting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={starting}
              onClick={(e) => {
                // Keep the dialog open until the start succeeds, so a
                // validation or server error stays next to the input.
                e.preventDefault();
                void handleStart();
              }}
            >
              {starting ? 'Starting...' : 'Start'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
