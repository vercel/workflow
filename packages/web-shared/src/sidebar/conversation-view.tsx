import type { ModelMessage } from 'ai';
import { Check, GitBranch, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Streamdown } from 'streamdown';

interface ConversationViewProps {
  messages: ModelMessage[];
  /** Callback when user clicks fork button on a user message. Receives the message index. */
  onFork?: (messageIndex: number) => void;
  /** Enable editing of user messages */
  editable?: boolean;
  /** Callback when a user message is edited. Receives the message index and new content. */
  onMessageChange?: (messageIndex: number, newContent: string) => void;
  /** Callback when editing state changes */
  onEditingChange?: (isEditing: boolean) => void;
}

export function ConversationView({
  messages,
  onFork,
  editable,
  onMessageChange,
  onEditingChange,
}: ConversationViewProps) {
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

  // Find the index of the last user message (only this one is editable)
  const lastUserMessageIndex = messages.reduce(
    (lastIdx, msg, idx) => (msg.role === 'user' ? idx : lastIdx),
    -1
  );

  return (
    <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto p-3">
      {messages.map((message, index) => (
        <MessageBubble
          key={index}
          message={message}
          index={index}
          onFork={onFork}
          editable={editable && index === lastUserMessageIndex}
          onMessageChange={onMessageChange}
          onEditingChange={onEditingChange}
        />
      ))}
    </div>
  );
}

function MessageBubble({
  message,
  index,
  onFork,
  editable,
  onMessageChange,
  onEditingChange,
}: {
  message: ModelMessage;
  index: number;
  onFork?: (messageIndex: number) => void;
  editable?: boolean;
  onMessageChange?: (messageIndex: number, newContent: string) => void;
  onEditingChange?: (isEditing: boolean) => void;
}) {
  const role = message.role;
  const style = getRoleStyle(role);
  const showForkButton = role === 'user' && onFork;
  const canEdit = editable && role === 'user' && onMessageChange;

  // Local editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  // Extract text content for editing
  const textContent = getTextContent(message.content);

  const handleStartEdit = () => {
    setEditValue(textContent);
    setIsEditing(true);
    onEditingChange?.(true);
  };

  const handleSaveEdit = () => {
    if (onMessageChange) {
      onMessageChange(index, editValue);
    }
    setIsEditing(false);
    onEditingChange?.(false);
  };

  return (
    <div
      className="rounded-md border text-[11px] group"
      style={{
        backgroundColor: style.bg,
        borderColor: style.border,
      }}
    >
      {/* Role header */}
      <div
        className="px-2.5 py-1 border-b text-[10px] font-medium uppercase tracking-wide flex items-center justify-between"
        style={{
          borderColor: style.border,
          color: style.label,
        }}
      >
        <span>{role}</span>
        <div className="flex items-center gap-1">
          {canEdit && !isEditing && (
            <button
              type="button"
              onClick={handleStartEdit}
              className="p-1 rounded border"
              title="Edit message"
              style={{
                color: style.label,
                backgroundColor: 'var(--ds-background-100)',
                borderColor: style.border,
              }}
            >
              <Pencil size={10} />
            </button>
          )}
          {canEdit && isEditing && (
            <button
              type="button"
              onClick={handleSaveEdit}
              className="p-1 rounded border"
              title="Save edit"
              style={{
                color: 'var(--ds-green-700)',
                backgroundColor: 'var(--ds-green-100)',
                borderColor: 'var(--ds-green-300)',
              }}
            >
              <Check size={10} />
            </button>
          )}
          {showForkButton && (
            <button
              type="button"
              onClick={() => onFork(index)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded border"
              title="Fork workflow from this message"
              style={{
                color: style.label,
                backgroundColor: 'var(--ds-background-100)',
                borderColor: style.border,
              }}
            >
              <GitBranch size={10} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-2.5 py-2 space-y-2">
        {isEditing ? (
          <textarea
            className="w-full min-h-[60px] p-2 rounded border text-[11px] resize-y"
            style={{
              backgroundColor: 'var(--ds-background-100)',
              borderColor: 'var(--ds-blue-400)',
              color: 'var(--ds-gray-1000)',
            }}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
          />
        ) : (
          parseContent(message.content).map((part, i) => (
            <ContentPart key={i} part={part} role={role} />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Extract text content from a message for editing
 */
function getTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return String(part.text ?? '');
        return '';
      })
      .join('');
  }
  return '';
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
