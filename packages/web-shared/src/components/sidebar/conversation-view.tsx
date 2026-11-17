import type { ModelMessage } from 'ai';
import { Check, Wrench } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { DataInspector } from '../ui/data-inspector';

interface ConversationViewProps {
  messages: ModelMessage[];
}

export function ConversationView({ messages }: ConversationViewProps) {
  if (messages.length === 0) {
    return (
      <div className="py-8 text-center text-copy-13 text-gray-900">
        No Messages
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {messages.map((message, index) => (
        <MessageBubble key={index} message={message} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ModelMessage }) {
  const role = message.role;
  const parts = parseContent(message.content);
  const roleClasses = getRoleClasses(role);

  return (
    <div className={`rounded-md border text-copy-13 ${roleClasses.bubble}`}>
      {/* Role header */}
      <div
        className={`border-b px-2.5 py-1 text-label-12 font-medium capitalize ${roleClasses.label}`}
      >
        {role}
      </div>

      {/* Content */}
      <div className="px-2.5 py-2 space-y-2">
        {parts.map((part, i) => (
          <ContentPart key={i} part={part} role={role} />
        ))}
      </div>
    </div>
  );
}

interface ParsedPart {
  type: 'text' | 'tool-call' | 'tool-result';
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

function ContentPart({ part, role }: { part: ParsedPart; role: string }) {
  if (part.type === 'text') {
    if (!part.text) return null;

    // Use Streamdown for assistant messages (they often contain markdown)
    if (role === 'assistant') {
      return (
        <div className="max-w-none text-copy-13 text-gray-1000 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Streamdown>{part.text}</Streamdown>
        </div>
      );
    }

    return (
      <div className="whitespace-pre-wrap break-words text-gray-1000">
        {part.text}
      </div>
    );
  }

  if (part.type === 'tool-call') {
    return (
      <div className="rounded-md border border-purple-400 bg-purple-100 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-label-12 font-medium">
          <Wrench className="size-3 shrink-0 text-purple-900" aria-hidden />
          <span className="text-purple-900">{part.toolName}</span>
        </div>
        {part.input != null && (
          <div className="mt-1.5 overflow-x-auto rounded-sm bg-gray-100 p-1.5">
            {typeof part.input === 'string' ? (
              <pre className="m-0 whitespace-pre-wrap break-words text-label-12-mono text-gray-900">
                {part.input}
              </pre>
            ) : (
              <DataInspector data={part.input} />
            )}
          </div>
        )}
      </div>
    );
  }

  if (part.type === 'tool-result') {
    return (
      <div className="rounded-md border border-green-400 bg-green-100 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-label-12 font-medium">
          <Check className="size-3 shrink-0 text-green-900" aria-hidden />
          <span className="text-green-900">{part.toolName} result</span>
        </div>
        {part.output != null && (
          <div className="mt-1.5 max-h-[200px] overflow-auto rounded-sm bg-gray-100 p-1.5">
            {typeof part.output === 'string' ? (
              <pre className="m-0 whitespace-pre-wrap break-words text-label-12-mono text-gray-900">
                {part.output}
              </pre>
            ) : (
              <DataInspector data={part.output} expandLevel={1} />
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
}

function getRoleClasses(role: string): { bubble: string; label: string } {
  switch (role) {
    case 'user':
      return {
        bubble: 'border-blue-400 bg-blue-100',
        label: 'border-blue-400 text-blue-900',
      };
    case 'assistant':
      return {
        bubble: 'border-gray-400 bg-gray-100',
        label: 'border-gray-400 text-gray-900',
      };
    case 'system':
      return {
        bubble: 'border-amber-400 bg-amber-100',
        label: 'border-amber-400 text-amber-900',
      };
    case 'tool':
      return {
        bubble: 'border-green-400 bg-green-100',
        label: 'border-green-400 text-green-900',
      };
    default:
      return {
        bubble: 'border-gray-400 bg-gray-100',
        label: 'border-gray-400 text-gray-900',
      };
  }
}

function parseContent(content: unknown): ParsedPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (Array.isArray(content)) {
    return content.map((part): ParsedPart => {
      if (typeof part === 'string') {
        return { type: 'text', text: part };
      }
      if (part?.type === 'text') {
        return { type: 'text', text: String(part.text ?? '') };
      }
      if (part?.type === 'tool-call') {
        return {
          type: 'tool-call',
          toolName: part.toolName,
          input: part.input,
        };
      }
      if (part?.type === 'tool-result') {
        return {
          type: 'tool-result',
          toolName: part.toolName,
          output: part.output,
        };
      }
      return { type: 'text', text: '' };
    });
  }

  return [];
}
