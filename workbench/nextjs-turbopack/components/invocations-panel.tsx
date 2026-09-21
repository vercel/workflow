'use client';

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Unplug,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export type InvocationStatus =
  | 'invoked'
  | 'reconnecting'
  | 'streaming'
  | 'disconnected'
  | 'stream_complete'
  | 'done'
  | 'error'
  | 'failed';

export interface Invocation {
  runId: string;
  workflowName: string;
  status: InvocationStatus;
  startTime: Date;
  endTime?: Date;
  result?: unknown;
  error?: string;
}

interface InvocationsPanelProps {
  invocations: Invocation[];
  onDisconnect?: (runId: string) => void;
  onReconnect?: (runId: string) => void;
}

export function InvocationsPanel({
  invocations,
  onDisconnect,
  onReconnect,
}: InvocationsPanelProps) {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDuration = (startTime: Date, endTime: Date) => {
    const durationMs = endTime.getTime() - startTime.getTime();

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }

    const seconds = durationMs / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(3)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds.toFixed(3)}s`;
  };

  const getStatusIcon = (status: InvocationStatus) => {
    switch (status) {
      case 'invoked':
      case 'reconnecting':
      case 'streaming':
        return <Loader2 className="h-3 w-3 animate-spin" />;
      case 'done':
      case 'stream_complete':
        return <CheckCircle2 className="h-3 w-3" />;
      case 'error':
        return <AlertCircle className="h-3 w-3" />;
      case 'disconnected':
      case 'failed':
        return <XCircle className="h-3 w-3" />;
    }
  };

  const getStatusStyle = (status: InvocationStatus): string => {
    switch (status) {
      case 'invoked':
      case 'reconnecting':
      case 'streaming':
        return 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/50 dark:text-blue-300';
      case 'stream_complete':
      case 'done':
        return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/50 dark:text-green-300';
      case 'error':
        return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/50 dark:text-orange-300';
      case 'disconnected':
        return 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300';
      case 'failed':
        return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/50 dark:text-red-300';
    }
  };

  const getStatusBadge = (
    status: InvocationStatus,
    result?: unknown,
    error?: string
  ) => {
    const statusLabel = status.replace('_', ' ');

    const badge = (
      <Badge
        variant="outline"
        className={`flex items-center gap-1 ${getStatusStyle(status)}`}
      >
        {getStatusIcon(status)}
        {statusLabel}
      </Badge>
    );

    if (status === 'done' && result !== undefined) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-help">{badge}</div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-md">
            <pre className="text-xs whitespace-pre-wrap">
              {JSON.stringify(result, null, 2)}
            </pre>
          </TooltipContent>
        </Tooltip>
      );
    }

    if (
      (status === 'error' ||
        status === 'disconnected' ||
        status === 'failed') &&
      error
    ) {
      const tooltipBg =
        status === 'failed'
          ? 'bg-red-600'
          : status === 'error'
            ? 'bg-orange-600'
            : '';
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-help">{badge}</div>
          </TooltipTrigger>
          <TooltipContent side="left" className={`max-w-md ${tooltipBg}`}>
            <div className="space-y-1">
              <div className="font-semibold">
                {status === 'failed'
                  ? 'API/Client Error:'
                  : status === 'error'
                    ? 'Workflow Error:'
                    : 'Disconnected:'}
              </div>
              <div className="text-xs whitespace-pre-wrap">{error}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }

    return badge;
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Workflow Invocations</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto space-y-2">
          {invocations.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No workflow runs yet. Click &quot;Start&quot; on any workflow to
              begin.
            </div>
          ) : (
            invocations.map((invocation) => {
              const isActive =
                invocation.status === 'streaming' ||
                invocation.status === 'reconnecting';
              const canReconnect =
                invocation.status === 'disconnected' ||
                invocation.status === 'stream_complete' ||
                invocation.status === 'done';

              return (
                <div
                  key={invocation.runId}
                  className="border rounded-lg p-3 space-y-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs truncate flex-1">
                      {invocation.runId.startsWith('temp-')
                        ? invocation.runId
                        : invocation.runId.substring(0, 16) + '...'}
                    </span>
                    <div className="flex items-center gap-1">
                      {getStatusBadge(
                        invocation.status,
                        invocation.result,
                        invocation.error
                      )}
                      {isActive && onDisconnect && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => onDisconnect(invocation.runId)}
                            >
                              <Unplug className="h-3 w-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Disconnect from stream
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {canReconnect && !isActive && onReconnect && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => onReconnect(invocation.runId)}
                            >
                              <RefreshCw className="h-3 w-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Reconnect to stream</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <div className="text-xs space-y-1">
                    <div className="font-medium">{invocation.workflowName}</div>
                    <div className="text-muted-foreground">
                      Started: {formatTime(invocation.startTime)}
                    </div>
                    {invocation.endTime && (
                      <>
                        <div className="text-muted-foreground">
                          Ended: {formatTime(invocation.endTime)}
                        </div>
                        <div className="text-muted-foreground font-mono">
                          Duration:{' '}
                          {formatDuration(
                            invocation.startTime,
                            invocation.endTime
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
