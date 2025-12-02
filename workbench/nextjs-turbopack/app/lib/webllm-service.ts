/**
 * WebLLM Service - Singleton for in-browser LLM inference
 *
 * Uses WebLLM with a dedicated Web Worker for GPU-accelerated inference.
 * Model weights are cached in IndexedDB after first download.
 */

import type { MLCEngine, ChatCompletionMessageParam } from '@mlc-ai/web-llm';

// Model to use - SmolLM is tiny (~200MB) and fast
const MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

export type LoadingProgress = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  progress: number; // 0-100
  text: string;
};

type ProgressCallback = (progress: LoadingProgress) => void;

let engine: MLCEngine | null = null;
let loadingPromise: Promise<MLCEngine> | null = null;
let currentProgress: LoadingProgress = {
  status: 'idle',
  progress: 0,
  text: '',
};
const progressListeners = new Set<ProgressCallback>();

/**
 * Subscribe to loading progress updates
 */
export function subscribeToProgress(callback: ProgressCallback): () => void {
  progressListeners.add(callback);
  // Immediately call with current progress
  callback(currentProgress);
  return () => progressListeners.delete(callback);
}

function updateProgress(progress: LoadingProgress) {
  currentProgress = progress;
  for (const listener of progressListeners) {
    listener(progress);
  }
}

/**
 * Initialize the WebLLM engine (lazy singleton)
 */
export async function initWebLLM(): Promise<MLCEngine> {
  // Return existing engine if ready
  if (engine) return engine;

  // Return existing loading promise if in progress
  if (loadingPromise) return loadingPromise;

  // Start loading
  loadingPromise = (async () => {
    try {
      updateProgress({
        status: 'loading',
        progress: 0,
        text: 'Initializing WebLLM...',
      });

      // Dynamic import to avoid SSR issues
      const webllm = await import('@mlc-ai/web-llm');

      updateProgress({
        status: 'loading',
        progress: 5,
        text: 'Loading model (first time may take a minute)...',
      });

      // Create engine with progress callback
      engine = await webllm.CreateMLCEngine(MODEL_ID, {
        initProgressCallback: (report) => {
          const progress = Math.min(95, 5 + report.progress * 90);
          updateProgress({
            status: 'loading',
            progress,
            text: report.text || 'Loading model...',
          });
        },
      });

      updateProgress({
        status: 'ready',
        progress: 100,
        text: 'Model ready',
      });

      return engine;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      updateProgress({
        status: 'error',
        progress: 0,
        text: `Failed to load model: ${errorMessage}`,
      });
      loadingPromise = null;
      throw error;
    }
  })();

  return loadingPromise;
}

/**
 * Check if WebLLM is ready
 */
export function isReady(): boolean {
  return engine !== null;
}

/**
 * Get current loading status
 */
export function getStatus(): LoadingProgress {
  return currentProgress;
}

/**
 * Generate a response from the LLM
 */
export async function generateResponse(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Promise<string> {
  const llm = await initWebLLM();

  const response = await llm.chat.completions.create({
    messages: messages as ChatCompletionMessageParam[],
    temperature: 0.7,
    max_tokens: 512,
  });

  return response.choices[0]?.message?.content || '';
}

/**
 * Reset the engine (useful for cleanup)
 */
export async function resetEngine(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = null;
    loadingPromise = null;
    updateProgress({
      status: 'idle',
      progress: 0,
      text: '',
    });
  }
}
