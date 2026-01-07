'use client';

import { useCallback, useEffect, useRef } from 'react';
import { WORKFLOW_DEFINITIONS } from '@/app/workflows/definitions';
import { InvocationsPanel } from '@/components/invocations-panel';
import { TerminalLog } from '@/components/terminal-log';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkflowButton } from '@/components/workflow-button';
import { useWorkflowStorage } from '@/hooks';

export default function Home() {
  // Track active stream abort controllers
  const streamAbortControllers = useRef<Map<string, AbortController>>(
    new Map()
  );

  // Track which runs we've attempted to reconnect to (to avoid duplicates)
  const reconnectionAttempts = useRef<Set<string>>(new Set());

  // Use custom hooks for localStorage management
  const {
    logs,
    addLog,
    invocations,
    addInvocation,
    updateInvocationStatus,
    updateInvocationRunId,
    clearAll,
    isHydrated,
  } = useWorkflowStorage();

  // Stream reading helper
  const readStream = useCallback(
    async (runId: string, reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const decoder = new TextDecoder();
      const abortController = new AbortController();
      streamAbortControllers.current.set(runId, abortController);

      try {
        while (true) {
          if (abortController.signal.aborted) {
            reader.cancel();
            break;
          }

          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter((line) => line.trim());

          for (const line of lines) {
            addLog('stream', line, runId);
          }
        }

        if (!abortController.signal.aborted) {
          // Stream completed successfully
          updateInvocationStatus(runId, 'stream_complete');
          addLog('info', 'Stream completed', runId);
        }
      } catch (streamError) {
        if (!abortController.signal.aborted) {
          const errorMsg =
            streamError instanceof Error
              ? streamError.message
              : String(streamError);
          addLog('error', `Stream error: ${errorMsg}`, runId);
          updateInvocationStatus(runId, 'disconnected', undefined, errorMsg);
        }
      } finally {
        streamAbortControllers.current.delete(runId);
      }
    },
    [addLog, updateInvocationStatus]
  );

  // Await workflow result
  const awaitWorkflowResult = useCallback(
    async (runId: string) => {
      try {
        const response = await fetch('/api/workflows/await', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ runId }),
        });

        if (!response.ok) {
          const error = await response.json();
          const errorMsg = `${error.error || 'Unknown error'}${
            error.details ? ` - ${error.details}` : ''
          }`;
          addLog('error', `API error awaiting result: ${errorMsg}`, runId);
          // Use "failed" for API errors (our side)
          updateInvocationStatus(runId, 'failed', undefined, errorMsg);
        } else {
          const data = await response.json();

          // Check if the workflow result itself is an error
          const isWorkflowError =
            data.result &&
            typeof data.result === 'object' &&
            (data.result.error || data.result instanceof Error);

          if (isWorkflowError) {
            const errorMsg =
              data.result.error || data.result.message || 'Workflow error';
            addLog('error', `Workflow returned error: ${errorMsg}`, runId);
            // Use "error" for workflow errors (the workflow returned an error)
            updateInvocationStatus(runId, 'error', data.result, errorMsg);
          } else {
            addLog(
              'result',
              `Workflow completed: ${JSON.stringify(data.result)}`,
              runId
            );
            updateInvocationStatus(runId, 'done', data.result);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        addLog('error', `Failed to await result: ${errorMsg}`, runId);
        // Use "failed" for client/network errors
        updateInvocationStatus(runId, 'failed', undefined, errorMsg);
      }
    },
    [addLog, updateInvocationStatus]
  );

  // Reconnect to a stream (or just await result if stream is done)
  const reconnectToRun = useCallback(
    async (runId: string, silent = false) => {
      // First try to reconnect to the stream
      try {
        if (!silent) {
          addLog('info', `Reconnecting to run ${runId}...`, runId);
        }
        updateInvocationStatus(runId, 'streaming');

        const streamResponse = await fetch('/api/workflows/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ runId }),
        });

        if (streamResponse.ok) {
          // Stream is still available - read it
          const reader = streamResponse.body?.getReader();
          if (reader) {
            await readStream(runId, reader);
          }
        } else {
          // Stream not available - that's okay, workflow may have completed
          if (!silent) {
            addLog('info', `Stream ended, checking result...`, runId);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!silent) {
          addLog('error', `Error reconnecting to stream: ${errorMsg}`, runId);
        }
      }

      // Always try to await the result
      await awaitWorkflowResult(runId);
    },
    [addLog, updateInvocationStatus, readStream, awaitWorkflowResult]
  );

  // Manual reconnect handler (from UI button)
  const reconnectStream = useCallback(
    async (runId: string) => {
      // Reset the reconnection tracking for manual reconnects
      reconnectionAttempts.current.delete(runId);
      await reconnectToRun(runId, false);
    },
    [reconnectToRun]
  );

  // Auto-reconnect on page load for any "reconnecting" invocations
  useEffect(() => {
    // Wait for hydration to complete
    if (!isHydrated) return;

    const reconnectingInvocations = invocations.filter(
      (inv) => inv.status === 'reconnecting'
    );

    for (const inv of reconnectingInvocations) {
      // Skip if we've already attempted this run
      if (reconnectionAttempts.current.has(inv.runId)) continue;

      // Mark as attempted
      reconnectionAttempts.current.add(inv.runId);

      if (inv.runId.startsWith('temp-')) {
        // temp IDs can't be reconnected - mark as failed
        updateInvocationStatus(
          inv.runId,
          'failed',
          undefined,
          'Lost connection before receiving run ID'
        );
      } else {
        // Reconnect in the background
        addLog('info', `Auto-reconnecting to ${inv.runId}...`, inv.runId);
        reconnectToRun(inv.runId, true);
      }
    }
  }, [isHydrated, invocations, reconnectToRun, addLog, updateInvocationStatus]);

  // Start a workflow
  const startWorkflow = async (workflowName: string, args: unknown[]) => {
    let runId: string | null = null;
    let tempId = '';

    try {
      // Create invocation with "invoked" status
      tempId = `temp-${crypto.randomUUID()}`;
      addLog('info', `Starting workflow: ${workflowName}`);
      addInvocation(tempId, workflowName);

      const response = await fetch('/api/workflows/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflowName,
          args,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        const errorMsg = `${error.error || 'Unknown error'}${
          error.details ? ` - ${error.details}` : ''
        }`;
        addLog('error', `API error starting workflow: ${errorMsg}`);
        // Use "failed" for API errors
        updateInvocationStatus(tempId, 'failed', undefined, errorMsg);
        return;
      }

      // Check if this is a streaming response
      const contentType = response.headers.get('Content-Type');
      const isStream = contentType?.includes('text/event-stream');

      if (!isStream) {
        const errorMsg = 'No stream available - expected text/event-stream';
        addLog('error', errorMsg);
        updateInvocationStatus(tempId, 'failed', undefined, errorMsg);
        return;
      }

      // Get run ID from header
      runId = response.headers.get('X-Workflow-Run-Id');

      if (!runId) {
        const errorMsg = 'No run ID returned from server';
        addLog('error', errorMsg);
        updateInvocationStatus(tempId, 'failed', undefined, errorMsg);
        return;
      }

      // Update with real run ID and "streaming" status
      updateInvocationRunId(tempId, runId, 'streaming');
      addLog('info', `Started run ${runId}`, runId);

      // Read the stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No reader available');
      }

      await readStream(runId, reader);

      // Wait for the workflow result
      await awaitWorkflowResult(runId);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      addLog('error', `Failed to start workflow: ${errorMsg}`);
      // Use "failed" for client errors
      const targetId = runId || tempId;
      if (targetId) {
        updateInvocationStatus(targetId, 'failed', undefined, errorMsg);
      }
    }
  };

  // Disconnect from a stream
  const disconnectStream = (runId: string) => {
    const controller = streamAbortControllers.current.get(runId);
    if (controller) {
      controller.abort();
      streamAbortControllers.current.delete(runId);
      updateInvocationStatus(runId, 'disconnected');
      addLog('info', 'Disconnected from stream', runId);
    }
  };

  return (
    <TooltipProvider delayDuration={0}>
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-[1800px] mx-auto space-y-6">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">
              Workflow DevKit Examples
            </h1>
            <p className="text-muted-foreground">
              Select a workflow to start a run and view its output
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Workflow List */}
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Available Workflows</h2>
              <div className="space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto pr-2">
                {Object.entries(
                  WORKFLOW_DEFINITIONS.reduce(
                    (acc, workflow) => {
                      if (!acc[workflow.workflowFile]) {
                        acc[workflow.workflowFile] = [];
                      }
                      acc[workflow.workflowFile].push(workflow);
                      return acc;
                    },
                    {} as Record<string, typeof WORKFLOW_DEFINITIONS>
                  )
                ).map(([workflowFile, workflows]) => (
                  <div key={workflowFile} className="space-y-2">
                    <h3 className="text-xs font-mono text-muted-foreground px-1">
                      {workflowFile}
                    </h3>
                    <div className="space-y-2">
                      {workflows.map((workflow) => (
                        <WorkflowButton
                          key={`${workflow.workflowFile}:${workflow.name}`}
                          workflow={workflow}
                          onStart={startWorkflow}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Middle Column - Invocations */}
            <div className="h-[calc(100vh-180px)]">
              <InvocationsPanel
                invocations={invocations}
                onDisconnect={disconnectStream}
                onReconnect={reconnectStream}
              />
            </div>

            {/* Right Column - Terminal Log */}
            <div className="h-[calc(100vh-180px)]">
              <TerminalLog logs={logs} onClear={clearAll} />
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
