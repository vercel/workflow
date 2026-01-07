import { useCallback } from 'react';
import type {
  Invocation,
  InvocationStatus,
} from '@/components/invocations-panel';
import type { LogEntry } from '@/components/terminal-log';
import { useLocalStorage } from './use-local-storage';

const ACTIVE_STATUSES: InvocationStatus[] = [
  'invoked',
  'streaming',
  'reconnecting',
];
const TERMINAL_STATUSES: InvocationStatus[] = ['done', 'error', 'failed'];

export function useWorkflowLogs() {
  const [logs, setLogs, clearLogs, isHydrated] = useLocalStorage<LogEntry[]>(
    'workflow-logs',
    [],
    {
      deserializer: (value) => {
        const parsed = JSON.parse(value);
        return parsed.map((log: LogEntry) => ({
          ...log,
          timestamp: new Date(log.timestamp),
        }));
      },
    }
  );

  const addLog = useCallback(
    (type: LogEntry['type'], message: string, runId?: string) => {
      setLogs((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          type,
          message,
          runId,
        },
      ]);
    },
    [setLogs]
  );

  return { logs, addLog, clearLogs, isHydrated };
}

export function useWorkflowInvocations() {
  const [invocations, setInvocations, clearInvocations, isHydrated] =
    useLocalStorage<Invocation[]>('workflow-invocations', [], {
      deserializer: (value) => {
        const parsed = JSON.parse(value);
        return parsed.map((inv: Invocation) => {
          // If this was in an active state, mark as "reconnecting"
          const status = ACTIVE_STATUSES.includes(inv.status)
            ? 'reconnecting'
            : inv.status;

          return {
            ...inv,
            status,
            startTime: new Date(inv.startTime),
            endTime: inv.endTime ? new Date(inv.endTime) : undefined,
          };
        });
      },
    });

  const addInvocation = useCallback(
    (runId: string, workflowName: string) => {
      setInvocations((prev) => [
        ...prev,
        {
          runId,
          workflowName,
          status: 'invoked',
          startTime: new Date(),
        },
      ]);
    },
    [setInvocations]
  );

  const updateInvocationStatus = useCallback(
    (
      runId: string,
      status: InvocationStatus,
      result?: unknown,
      error?: string
    ) => {
      setInvocations((prev) =>
        prev.map((inv) =>
          inv.runId === runId
            ? {
                ...inv,
                status,
                result,
                error,
                endTime: TERMINAL_STATUSES.includes(status)
                  ? new Date()
                  : inv.endTime,
              }
            : inv
        )
      );
    },
    [setInvocations]
  );

  const updateInvocationRunId = useCallback(
    (oldRunId: string, newRunId: string, status: InvocationStatus) => {
      setInvocations((prev) =>
        prev.map((inv) =>
          inv.runId === oldRunId ? { ...inv, runId: newRunId, status } : inv
        )
      );
    },
    [setInvocations]
  );

  return {
    invocations,
    addInvocation,
    updateInvocationStatus,
    updateInvocationRunId,
    clearInvocations,
    isHydrated,
  };
}

export function useWorkflowStorage() {
  const logsData = useWorkflowLogs();
  const invocationsData = useWorkflowInvocations();

  const clearAll = useCallback(() => {
    logsData.clearLogs();
    invocationsData.clearInvocations();
  }, [logsData, invocationsData]);

  return {
    ...logsData,
    ...invocationsData,
    clearAll,
    isHydrated: logsData.isHydrated && invocationsData.isHydrated,
  };
}

export type { Invocation, InvocationStatus };
