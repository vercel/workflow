'use client';

/**
 * Demo component for browser workflows.
 *
 * This component demonstrates how to use browser workflows from React.
 */

import { useState } from 'react';
import { browserExample } from '@/app/workflows/browser/example';
import { useWorkflowRun } from '@workflow/world-browser/react';

export function BrowserWorkflowDemo() {
  const [input, setInput] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);

  // Subscribe to workflow run updates
  const { steps, status, output, isLoading, isComplete } =
    useWorkflowRun(runId);

  const handleRun = async () => {
    setErrorMessage(null);
    setResult(null);
    setRunId(null);
    setIsTriggering(true);

    try {
      // Call the workflow directly - this triggers the browser SharedWorker
      const workflowResult = await browserExample({ text: input });
      setResult(workflowResult);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTriggering(false);
    }
  };

  const handleRunAsync = async () => {
    setErrorMessage(null);
    setResult(null);
    setRunId(null);
    setIsTriggering(true);

    try {
      // Use the trigger method for async execution with progress tracking
      // @ts-expect-error - trigger may not be typed yet
      if (browserExample.trigger) {
        // @ts-expect-error - trigger may not be typed yet
        const { runId: newRunId } = await browserExample.trigger({
          text: input,
        });
        setRunId(newRunId);
      } else {
        // Fallback to direct call
        const workflowResult = await browserExample({ text: input });
        setResult(workflowResult);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTriggering(false);
    }
  };

  // Update result when workflow completes
  if (isComplete && output && !result) {
    setResult(output);
  }

  return (
    <div className="p-4 border rounded-lg bg-gray-50 dark:bg-gray-900">
      <h2 className="text-lg font-semibold mb-4">Browser Workflow Demo</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Input Text</label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full px-3 py-2 border rounded-md"
            placeholder="Enter some text (at least 3 characters)..."
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleRun}
            disabled={!input || isTriggering}
            className="px-4 py-2 bg-blue-500 text-white rounded-md disabled:opacity-50"
          >
            {isTriggering ? 'Running...' : 'Run (Wait for Result)'}
          </button>
          <button
            onClick={handleRunAsync}
            disabled={!input || isTriggering}
            className="px-4 py-2 bg-green-500 text-white rounded-md disabled:opacity-50"
          >
            {isTriggering ? 'Triggering...' : 'Run (Track Progress)'}
          </button>
        </div>

        {/* Progress display */}
        {runId && (
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded">
            <p className="text-sm font-medium">Run ID: {runId}</p>
            <p className="text-sm">Status: {status || 'Unknown'}</p>
            {isLoading && <p className="text-sm text-blue-500">Loading...</p>}
            {steps.length > 0 && (
              <div className="mt-2">
                <p className="text-sm font-medium">Steps:</p>
                <ul className="text-sm list-disc list-inside">
                  {steps.map((step) => (
                    <li key={step.stepId}>
                      {step.stepName}:{' '}
                      <span
                        className={
                          step.status === 'completed'
                            ? 'text-green-600'
                            : step.status === 'failed'
                              ? 'text-red-600'
                              : step.status === 'running'
                                ? 'text-blue-600'
                                : 'text-gray-500'
                        }
                      >
                        {step.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {errorMessage ? (
          <div className="p-3 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-100 rounded">
            <strong>Error:</strong> {errorMessage}
          </div>
        ) : null}

        {result ? (
          <div className="p-3 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100 rounded">
            <p className="font-medium mb-2">Result:</p>
            <pre className="text-sm overflow-auto">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>

      <div className="mt-4 text-sm text-gray-500">
        <p>
          <strong>Note:</strong> Browser workflows run entirely in the browser
          using SharedWorker and Turso WASM. They persist across page reloads
          and work offline.
        </p>
      </div>
    </div>
  );
}
