import type { ModelMessage } from 'ai';
import { Streamdown } from 'streamdown';

interface ConversationViewProps {
  messages: ModelMessage[];
}

export function ConversationView({ messages }: ConversationViewProps) {
  if (messages.length === 0) {
    return (
      <div
        className="text-center py-8 text-[11px]"
        style={{ color: 'var(--ds-gray-600)' }}
      >
        No messages
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto p-3">
      {messages.map((message, index) => (
        <MessageBubble key={index} message={message} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ModelMessage }) {
  const role = message.role;
  const parts = parseContent(message.content);
  const style = getRoleStyle(role);

  return (
    <div
      className="rounded-md border text-[11px]"
      style={{
        backgroundColor: style.bg,
        borderColor: style.border,
      }}
    >
      {/* Role header */}
      <div
        className="px-2.5 py-1 border-b text-[10px] font-medium uppercase tracking-wide"
        style={{
          borderColor: style.border,
          color: style.label,
        }}
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
        <div
          className="prose prose-sm max-w-none text-[11px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          style={{ color: 'var(--ds-gray-1000)' }}
        >
          <Streamdown>{part.text}</Streamdown>
        </div>
      );
    }

    return (
      <div
        className="whitespace-pre-wrap break-words"
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        {part.text}
      </div>
    );
  }

  if (part.type === 'tool-call') {
    return (
      <div
        className="rounded border px-2 py-1.5"
        style={{
          backgroundColor: 'var(--ds-purple-100)',
          borderColor: 'var(--ds-purple-300)',
        }}
      >
        <div className="flex items-center gap-1.5 text-[10px] font-medium">
          <span>🔧</span>
          <span style={{ color: 'var(--ds-purple-900)' }}>{part.toolName}</span>
        </div>
        {part.input != null && (
          <pre
            className="mt-1.5 text-[10px] overflow-x-auto p-1.5 rounded"
            style={{
              backgroundColor: 'var(--ds-gray-100)',
              color: 'var(--ds-gray-800)',
            }}
          >
            {typeof part.input === 'string'
              ? part.input
              : JSON.stringify(part.input, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (part.type === 'tool-result') {
    const outputText = formatOutput(part.output);
    return (
      <div
        className="rounded border px-2 py-1.5"
        style={{
          backgroundColor: 'var(--ds-green-100)',
          borderColor: 'var(--ds-green-300)',
        }}
      >
        <div className="flex items-center gap-1.5 text-[10px] font-medium">
          <span>✓</span>
          <span style={{ color: 'var(--ds-green-900)' }}>
            {part.toolName} result
          </span>
        </div>
        {outputText && (
          <pre
            className="mt-1.5 text-[10px] overflow-x-auto max-h-[80px] p-1.5 rounded"
            style={{
              backgroundColor: 'var(--ds-gray-100)',
              color: 'var(--ds-gray-800)',
            }}
          >
            {outputText}
          </pre>
        )}
      </div>
    );
  }

  return null;
}

function getRoleStyle(role: string) {
  switch (role) {
    case 'user':
      return {
        bg: 'var(--ds-blue-100)',
        border: 'var(--ds-blue-300)',
        label: 'var(--ds-blue-700)',
      };
    case 'assistant':
      return {
        bg: 'var(--ds-gray-100)',
        border: 'var(--ds-gray-300)',
        label: 'var(--ds-gray-700)',
      };
    case 'system':
      return {
        bg: 'var(--ds-amber-100)',
        border: 'var(--ds-amber-300)',
        label: 'var(--ds-amber-700)',
      };
    case 'tool':
      return {
        bg: 'var(--ds-green-50)',
        border: 'var(--ds-green-300)',
        label: 'var(--ds-green-700)',
      };
    default:
      return {
        bg: 'var(--ds-gray-100)',
        border: 'var(--ds-gray-300)',
        label: 'var(--ds-gray-700)',
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

function formatOutput(output: unknown): string | null {
  if (output == null) return null;
  const text =
    typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
