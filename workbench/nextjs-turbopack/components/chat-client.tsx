'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import type { UIMessage } from 'ai';
import {
  Calculator,
  CheckCircle2,
  Cloud,
  CopyIcon,
  ExternalLink,
  MessageSquare,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Spinner } from '@/components/ui/spinner';
import { AI_MODELS, DEFAULT_AI_MODEL } from '@/lib/ai-models';

const SUGGESTIONS = [
  "What's the weather in Tokyo?",
  'Calculate 42 * 17 + 3',
  "What's the weather in NYC and Paris?",
  'What is (2^10) - 1?',
  'Compare weather in London vs Sydney',
];

function FeatureItem({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-2 text-xs">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{title}</span>
          <CheckCircle2 className="size-3 text-green-500" />
        </div>
        <p className="text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <div className="w-72 shrink-0 border-r overflow-y-auto p-4 space-y-6 text-sm">
      <div>
        <h2 className="font-semibold text-base">WorkflowAgent Chat</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Powered by Workflow SDK
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium text-xs uppercase tracking-wider text-muted-foreground">
          Tools
        </h3>
        <div className="space-y-3">
          <FeatureItem
            icon={<Cloud className="size-3.5 text-blue-500" />}
            title="getWeather"
            description={'Try: "What\'s the weather in Tokyo?"'}
          />
          <FeatureItem
            icon={<Calculator className="size-3.5 text-purple-500" />}
            title="calculate"
            description='Try: "What is 42 * 17 + 3?"'
          />
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium text-xs uppercase tracking-wider text-muted-foreground">
          Working Features
        </h3>
        <div className="space-y-3">
          <FeatureItem
            icon={<CheckCircle2 className="size-3.5" />}
            title="instructions"
            description="System prompt via constructor"
          />
          <FeatureItem
            icon={<CheckCircle2 className="size-3.5" />}
            title="onStepEnd"
            description="Constructor + stream callbacks"
          />
          <FeatureItem
            icon={<CheckCircle2 className="size-3.5" />}
            title="onEnd"
            description="With text, finishReason, totalUsage"
          />
          <FeatureItem
            icon={<CheckCircle2 className="size-3.5" />}
            title="Model-call timeout"
            description="AbortSignal stops active model calls; tools finish normally"
          />
          <FeatureItem
            icon={<CheckCircle2 className="size-3.5" />}
            title="Tool execution"
            description="Step-based with retry + FatalError"
          />
          <FeatureItem
            icon={<CheckCircle2 className="size-3.5" />}
            title="Multi-step"
            description="Sequential tool calls"
          />
        </div>
      </div>
    </div>
  );
}

function MessageParts({
  message,
  isLastMessage,
  isStreaming,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
}) {
  // Consolidate reasoning parts into one block
  const reasoningParts =
    message.parts?.filter((p) => p.type === 'reasoning') ?? [];
  const reasoningText = reasoningParts.map((p) => (p as any).text).join('\n\n');
  const hasReasoning = reasoningParts.length > 0;
  const lastPart = message.parts?.at(-1);
  const isReasoningStreaming =
    isLastMessage && isStreaming && lastPart?.type === 'reasoning';

  return (
    <>
      {hasReasoning && (
        <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )}
      {message.parts?.map((part, i) => {
        const partType = part.type;

        if (partType === 'text') {
          return (
            <MessageResponse key={`${message.id}-${i}`}>
              {part.text}
            </MessageResponse>
          );
        }

        if (partType === 'reasoning' || partType === 'step-start') {
          return null; // reasoning handled above, step-start is internal
        }

        // Tool parts use "tool-{toolName}" as the type.
        // Properties: input, output, state ("output-available" when done)
        if (partType.startsWith('tool-')) {
          const toolPart = part as any;
          return (
            <Tool key={`${message.id}-tool-${i}`}>
              <ToolHeader
                type={partType as any}
                state={toolPart.state}
                toolName={toolPart.toolName}
              />
              <ToolContent>
                {toolPart.input != null && <ToolInput input={toolPart.input} />}
                {toolPart.output != null && (
                  <ToolOutput
                    output={toolPart.output}
                    errorText={toolPart.errorText}
                  />
                )}
              </ToolContent>
            </Tool>
          );
        }

        return null;
      })}
    </>
  );
}

export function ChatClient() {
  const [input, setInput] = useState('');
  const [model, setModel] = useState(DEFAULT_AI_MODEL);
  const [runId, setRunId] = useState<string | null>(null);
  const [observabilityBase, setObservabilityBase] = useState<string | null>(
    null
  );

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: '/api/chat',
        onChatSendMessage: (response) => {
          const id = response.headers.get('x-workflow-run-id');
          if (id) setRunId(id);
          const team = response.headers.get('x-workflow-team-slug');
          const project = response.headers.get('x-workflow-project-slug');
          if (team && project) {
            setObservabilityBase(
              `https://vercel.com/${team}/${project}/workflows/runs`
            );
          }
        },
        prepareSendMessagesRequest: ({ messages, body, ...rest }) => ({
          ...rest,
          body: { messages, ...body },
        }),
      }),
    []
  );

  const observabilityUrl = useMemo(() => {
    if (!runId) return null;
    // Vercel deployment: use observability dashboard
    if (observabilityBase) {
      return `${observabilityBase}/${runId}?environment=${encodeURIComponent(
        new URLSearchParams(window.location.search).get('environment') ??
          'preview'
      )}`;
    }
    // Local dev: use workflow CLI UI
    return `http://localhost:3456/run/${runId}`;
  }, [runId, observabilityBase]);

  const { messages, sendMessage, status } = useChat({
    transport,
  });

  const handleSubmit = (message: PromptInputMessage) => {
    if (message.text.trim()) {
      sendMessage({ text: message.text }, { body: { model } });
      setInput('');
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    sendMessage({ text: suggestion }, { body: { model } });
  };

  return (
    <div className="flex h-[calc(100vh-56px)]">
      <Sidebar />
      <div className="flex-1 flex flex-col p-4 min-w-0">
        <Conversation>
          <ConversationContent>
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquare className="size-12" />}
                title="WorkflowAgent Chat"
                description="Chat with tools, streaming through a durable workflow."
              />
            ) : (
              messages.map((message, messageIndex) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    <MessageParts
                      message={message}
                      isLastMessage={messageIndex === messages.length - 1}
                      isStreaming={status === 'streaming'}
                    />
                  </MessageContent>
                  {message.role === 'assistant' && (
                    <MessageActions>
                      {observabilityUrl && (
                        <MessageAction
                          tooltip="View workflow run"
                          label="View workflow run"
                          onClick={() =>
                            window.open(observabilityUrl, '_blank')
                          }
                        >
                          <ExternalLink className="size-3" />
                        </MessageAction>
                      )}
                      {runId && (
                        <MessageAction
                          tooltip={`Copy run ID: ${runId}`}
                          label="Copy run ID"
                          onClick={() => navigator.clipboard.writeText(runId)}
                        >
                          <CopyIcon className="size-3" />
                        </MessageAction>
                      )}
                    </MessageActions>
                  )}
                </Message>
              ))
            )}
            {status === 'submitted' && <Spinner />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {messages.length === 0 && (
          <div className="w-full max-w-3xl mx-auto mt-2">
            <Suggestions className="overflow-x-auto flex-nowrap">
              {SUGGESTIONS.map((s) => (
                <Suggestion
                  key={s}
                  suggestion={s}
                  onClick={handleSuggestionClick}
                  className="shrink-0"
                />
              ))}
            </Suggestions>
          </div>
        )}

        <PromptInput
          onSubmit={handleSubmit}
          className="mt-2 w-full max-w-3xl mx-auto"
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              placeholder="Try: What's the weather in Paris? or Calculate 2^10"
              onChange={(e) => setInput(e.currentTarget.value)}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputSelect value={model} onValueChange={setModel}>
                <PromptInputSelectTrigger>
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {AI_MODELS.map((m) => (
                    <PromptInputSelectItem key={m.id} value={m.id}>
                      {m.name}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            </PromptInputTools>
            <PromptInputSubmit
              disabled={!input.trim()}
              status={status === 'streaming' ? 'streaming' : 'ready'}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
