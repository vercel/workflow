'use client';

import { Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface LogEntry {
  id: string;
  timestamp: Date;
  type: 'info' | 'error' | 'stream' | 'result';
  runId?: string;
  message: string;
}

interface TerminalLogProps {
  logs: LogEntry[];
  onClear: () => void;
}

export function TerminalLog({ logs, onClear }: TerminalLogProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'error':
        return 'text-red-600 dark:text-red-400';
      case 'info':
        return 'text-cyan-600 dark:text-cyan-400';
      case 'stream':
        return 'text-blue-600 dark:text-blue-400';
      case 'result':
        return 'text-green-600 dark:text-green-400';
      default:
        return 'text-gray-700 dark:text-gray-300';
    }
  };

  const getLogPrefix = (entry: LogEntry) => {
    const time = formatTimestamp(entry.timestamp);
    const runIdPart = entry.runId ? `[${entry.runId}]` : '';

    switch (entry.type) {
      case 'error':
        return `${time} [error]${runIdPart}`;
      case 'stream':
        return `${time} [stream]${runIdPart}`;
      case 'result':
        return `${time} [result]${runIdPart}`;
      default:
        return `${time} [info]${runIdPart}`;
    }
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-lg font-mono">Terminal Output</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <Trash2 className="h-4 w-4" />
          Clear
        </Button>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <div className="h-full bg-slate-50 dark:bg-black rounded-lg p-4 overflow-y-auto font-mono text-xs">
          {logs.length === 0 ? (
            <div className="text-muted-foreground">
              No logs yet. Start a workflow to see output...
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((entry) => (
                <div key={entry.id} className={getLogColor(entry.type)}>
                  <span className="text-gray-500 dark:text-gray-400">
                    {getLogPrefix(entry)}
                  </span>{' '}
                  {entry.message}
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
