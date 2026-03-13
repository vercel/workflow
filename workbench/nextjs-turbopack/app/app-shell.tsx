'use client';

import { useState } from 'react';
import type { WorkflowDefinition } from '@/app/workflows/types';
import HomeClient from './home-client';
import { ChatClient } from '@/components/chat-client';

interface AppShellProps {
  workflowDefinitions: WorkflowDefinition[];
}

export function AppShell({ workflowDefinitions }: AppShellProps) {
  const [tab, setTab] = useState<'workflows' | 'chat'>('workflows');

  return (
    <div className="min-h-screen bg-background">
      {/* Tab bar */}
      <div className="border-b bg-background sticky top-0 z-10">
        <div className="max-w-[1800px] mx-auto px-6 flex gap-1 pt-4">
          <button
            onClick={() => setTab('workflows')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors ${
              tab === 'workflows'
                ? 'bg-background text-foreground border-border'
                : 'bg-muted/50 text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            Workflows
          </button>
          <button
            onClick={() => setTab('chat')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors ${
              tab === 'chat'
                ? 'bg-background text-foreground border-border'
                : 'bg-muted/50 text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            DurableAgent Chat
          </button>
        </div>
      </div>

      {/* Tab content */}
      {tab === 'workflows' ? (
        <HomeClient workflowDefinitions={workflowDefinitions} />
      ) : (
        <ChatClient />
      )}
    </div>
  );
}
