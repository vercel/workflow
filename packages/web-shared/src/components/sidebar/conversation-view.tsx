import type { ModelMessage } from 'ai';
import { Streamdown } from 'streamdown';
import { DataInspector } from '../ui/data-inspector';

interface ConversationViewProps {
  messages: ModelMessage[];
}

export function ConversationView({ messages }: ConversationViewProps) {
  if (messages.length === 0) {
    return (
      <div className="py-8 text-center text-[11px] text-gray-600">
        No messages
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
    <div className={`rounded-md border text-[11px] ${roleClasses.bubble}`}>
      {/* Role header */}
      <div
        className={`border-b px-2.5 py-1 font-medium text-[10px] uppercase tracking-wide ${roleClasses.label}`}
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
        <div className="prose prose-sm max-w-none text-[11px] text-gray-1000 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
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
      <div className="rounded border border-purple-300 bg-purple-100 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-medium">
          <span>🔧</span>
          <span className="text-purple-900">{part.toolName}</span>
        </div>
        {part.input != null && (
          <div className="mt-1.5 overflow-x-auto rounded bg-gray-100 p-1.5">
            {typeof part.input === 'string' ? (
              <pre className="text-[10px] text-gray-800">{part.input}</pre>
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
      <div className="rounded border border-green-300 bg-green-100 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-medium">
          <span>✓</span>
          <span className="text-green-900">{part.toolName} result</span>
        </div>
        {part.output != null && (
          <div className="mt-1.5 max-h-[200px] overflow-x-auto overflow-y-auto rounded bg-gray-100 p-1.5">
            {typeof part.output === 'string' ? (
              <pre className="text-[10px] text-gray-800">{part.output}</pre>
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
        bubble: 'border-blue-300 bg-blue-100',
        label: 'border-blue-300 text-blue-700',
      };
    case 'assistant':
      return {
        bubble: 'border-gray-300 bg-gray-100',
        label: 'border-gray-300 text-gray-700',
      };
    case 'system':
      return {
        bubble: 'border-amber-300 bg-amber-100',
        label: 'border-amber-300 text-amber-700',
      };
    case 'tool':
      return {
        bubble: 'border-green-300 bg-green-100',
        label: 'border-green-300 text-green-700',
      };
    default:
      return {
        bubble: 'border-gray-300 bg-gray-100',
        label: 'border-gray-300 text-gray-700',
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
