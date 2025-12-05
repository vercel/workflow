'use client';

import { readStream } from '@workflow/web-shared';
import type { EnvMap } from '@workflow/web-shared/server';
import { ChevronLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface StreamDetailViewProps {
  env: EnvMap;
  streamId: string;
}

interface Chunk {
  id: number;
  text: string;
}

export function StreamDetailView({ env, streamId }: StreamDetailViewProps) {
  const router = useRouter();
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [isLive, setIsLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chunkIdRef = useRef(0);

  useEffect(() => {
    // Auto-scroll to bottom when new content arrives
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks.length]); // Only depend on length, not the entire array

  useEffect(() => {
    let mounted = true;
    abortControllerRef.current = new AbortController();

    const handleStreamEnd = () => {
      if (mounted) {
        setIsLive(false);
      }
    };

    const handleStreamError = (err: unknown) => {
      if (mounted) {
        setError(err instanceof Error ? err.message : String(err));
        setIsLive(false);
      }
    };

    const addChunk = (text: string) => {
      if (mounted && text) {
        const chunkId = chunkIdRef.current++;
        setChunks((prev) => [...prev, { id: chunkId, text }]);
      }
    };

    const processStreamChunks = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      decoder: TextDecoder
    ) => {
      for (;;) {
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        const { value, done } = await reader.read();

        if (done) {
          handleStreamEnd();
          break;
        }

        // Skip empty chunks
        if (value && value.byteLength > 0) {
          const text = decoder.decode(value, { stream: true });
          addChunk(text);
        }
      }
    };

    const readStreamData = async () => {
      try {
        const stream = await readStream(env, streamId);
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        await processStreamChunks(reader, decoder);
      } catch (err) {
        handleStreamError(err);
      }
    };

    void readStreamData();

    return () => {
      mounted = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [env, streamId]);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.back()}
        className="gap-2"
      >
        <ChevronLeft className="h-4 w-4" />
        Back
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-mono text-sm">{streamId}</CardTitle>
            <div className="flex items-center gap-2">
              <span
                className={`text-sm ${isLive ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}`}
              >
                {isLive ? '● Live' : '● Closed'}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div
            ref={scrollRef}
            className="bg-black text-green-400 font-mono text-sm p-4 rounded-md h-[600px] overflow-auto whitespace-pre-wrap break-words"
          >
            {error ? (
              <div className="text-red-400">
                <div>Error reading stream:</div>
                <div>{error}</div>
              </div>
            ) : chunks.length === 0 ? (
              <div className="text-gray-500">
                {isLive ? 'Waiting for stream data...' : 'Stream is empty'}
              </div>
            ) : (
              chunks.map((chunk) => (
                <span key={`${streamId}-chunk-${chunk.id}`}>{chunk.text}</span>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
