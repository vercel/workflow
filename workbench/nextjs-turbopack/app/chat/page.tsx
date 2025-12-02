'use client';

import { useState, useCallback, useId, useEffect } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Progress } from '@/components/ui/progress';
import {
  SparklesIcon,
  PlusIcon,
  DownloadIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import {
  chatWithLLM,
  type ChatMessage as WorkflowChatMessage,
} from '@/app/workflows/browser/chat';
import {
  subscribeToProgress,
  initWebLLM,
  type LoadingProgress,
} from '@/app/lib/webllm-service';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
};

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [modelProgress, setModelProgress] = useState<LoadingProgress>({
    status: 'idle',
    progress: 0,
    text: '',
  });
  const messageIdBase = useId();

  // Subscribe to model loading progress
  useEffect(() => {
    const unsubscribe = subscribeToProgress(setModelProgress);
    return unsubscribe;
  }, []);

  // Start loading model
  const handleLoadModel = useCallback(async () => {
    try {
      await initWebLLM();
    } catch (error) {
      console.error('Failed to load model:', error);
    }
  }, []);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim()) return;

      const userMessage: ChatMessage = {
        id: `${messageIdBase}-${Date.now()}-user`,
        role: 'user',
        content: message.text,
        createdAt: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      try {
        // Build conversation history for the LLM
        const conversationHistory: WorkflowChatMessage[] = [
          {
            role: 'system',
            content: 'You are a helpful AI assistant. Be concise and friendly.',
          },
          ...messages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: message.text },
        ];

        // Call the browser workflow
        const result = await chatWithLLM({ messages: conversationHistory });

        const assistantMessage: ChatMessage = {
          id: `${messageIdBase}-${Date.now()}-assistant`,
          role: 'assistant',
          content:
            result.content ||
            'I apologize, but I could not generate a response.',
          createdAt: new Date(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
      } catch (error) {
        console.error('Failed to generate response:', error);
        const errorMessage: ChatMessage = {
          id: `${messageIdBase}-${Date.now()}-error`,
          role: 'assistant',
          content: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          createdAt: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
      }
    },
    [messageIdBase, messages]
  );

  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  const isModelReady = modelProgress.status === 'ready';
  const isModelLoading = modelProgress.status === 'loading';
  const isModelError = modelProgress.status === 'error';

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-6 py-4">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <Button variant="ghost" size="sm" onClick={handleClear}>
          <PlusIcon className="size-4 mr-2" />
          New Chat
        </Button>
      </header>

      {/* Model Loading Banner */}
      {!isModelReady && (
        <div className="border-b bg-muted/50 px-6 py-3">
          <div className="mx-auto max-w-3xl">
            {modelProgress.status === 'idle' && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DownloadIcon className="size-4 text-muted-foreground" />
                  <span className="text-sm">
                    Load the AI model to start chatting (requires WebGPU)
                  </span>
                </div>
                <Button size="sm" onClick={handleLoadModel}>
                  Load Model
                </Button>
              </div>
            )}
            {isModelLoading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{modelProgress.text}</span>
                  <span className="text-muted-foreground">
                    {Math.round(modelProgress.progress)}%
                  </span>
                </div>
                <Progress value={modelProgress.progress} className="h-2" />
              </div>
            )}
            {isModelError && (
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircleIcon className="size-4" />
                <span className="text-sm">{modelProgress.text}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleLoadModel}
                  className="ml-auto"
                >
                  Retry
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chat Area */}
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto max-w-3xl px-4 py-8">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Start a conversation"
              description={
                isModelReady
                  ? 'Send a message to chat with model running locally in your browser!'
                  : 'Load the model first, then send a message to begin chatting.'
              }
              icon={
                <div className="flex size-16 items-center justify-center rounded-2xl bg-muted">
                  <SparklesIcon className="size-8" />
                </div>
              }
            />
          ) : (
            <>
              {messages.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.role === 'assistant' ? (
                      <MessageResponse>{message.content}</MessageResponse>
                    ) : (
                      message.content
                    )}
                  </MessageContent>
                </Message>
              ))}
              {isLoading && (
                <Message from="assistant">
                  <MessageContent>
                    <div className="flex items-center gap-1">
                      <span className="size-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                      <span className="size-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                      <span className="size-2 animate-bounce rounded-full bg-muted-foreground" />
                    </div>
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input Area */}
      <div className="border-t">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputTextarea
              placeholder={
                isModelReady
                  ? 'Type your message...'
                  : 'Load the model first to start chatting...'
              }
              disabled={isLoading || !isModelReady}
            />
            <PromptInputFooter>
              <PromptInputTools>
                <span className="text-muted-foreground text-xs">
                  {isModelReady
                    ? 'Press Enter to send'
                    : 'WebGPU required (Chrome 113+)'}
                </span>
              </PromptInputTools>
              <PromptInputSubmit disabled={isLoading || !isModelReady} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
