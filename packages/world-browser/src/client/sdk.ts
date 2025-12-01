/**
 * Browser Workflow Client SDK
 *
 * This is the main thread client for communicating with the SharedWorker.
 * It provides a promise-based API for triggering and managing workflows.
 */

import type { WorkflowRun } from '@workflow/world';
import type {
  AnyWorkerRequest,
  AnyWorkerResponse,
  AnyWorkerEvent,
  TriggerResponse,
  ListRunsResponse,
  GetStepsResponse,
  GetEventsResponse,
} from '../worker/message-types.js';

/**
 * Subscription callback for workflow updates.
 */
export type WorkflowSubscriptionCallback = (event: AnyWorkerEvent) => void;

/**
 * Options for the BrowserWorkflowClient.
 */
export interface BrowserWorkflowClientOptions {
  /**
   * Path to the SharedWorker script.
   * @default '/__workflow-worker.js'
   */
  workerPath?: string;
}

/**
 * Client for interacting with browser workflows.
 *
 * This class handles communication with the SharedWorker that runs workflows.
 */
export class BrowserWorkflowClient {
  // Using regular Worker instead of SharedWorker because SharedWorkers
  // cannot create nested Workers (needed by Turso WASM thread pool)
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private subscriptions = new Map<string, Set<WorkflowSubscriptionCallback>>();
  private workerPath: string;
  private messageIdCounter = 0;
  private initialized = false;

  constructor(options: BrowserWorkflowClientOptions = {}) {
    this.workerPath = options.workerPath ?? '/__workflow-worker.js';
  }

  /**
   * Generate a unique message ID.
   */
  private generateMessageId(): string {
    return `msg_${++this.messageIdCounter}_${Date.now()}`;
  }

  /**
   * Get or create the Worker.
   */
  private getWorker(): Worker {
    if (typeof window === 'undefined') {
      throw new Error('BrowserWorkflowClient can only be used in the browser');
    }

    if (!this.worker) {
      this.worker = new Worker(this.workerPath, { type: 'module' });

      this.worker.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      this.worker.onerror = (event) => {
        console.error('[BrowserWorkflowClient] Worker error:', event);
      };

      this.initialized = true;
    }

    return this.worker;
  }

  /**
   * Handle incoming messages from the worker.
   */
  private handleMessage(
    data: AnyWorkerResponse<unknown> | AnyWorkerEvent
  ): void {
    // Check if this is a response to a pending request
    if ('id' in data && 'success' in data) {
      const response = data as AnyWorkerResponse<unknown>;
      const pending = this.pending.get(response.id);

      if (pending) {
        this.pending.delete(response.id);

        if (response.success) {
          pending.resolve(response.data);
        } else {
          pending.reject(new Error(response.error));
        }
      }
      return;
    }

    // This is an event from a subscription
    const event = data as AnyWorkerEvent;
    if ('type' in event && 'runId' in event) {
      const callbacks = this.subscriptions.get(event.runId);
      if (callbacks) {
        for (const callback of callbacks) {
          try {
            callback(event);
          } catch (error) {
            console.error(
              '[BrowserWorkflowClient] Subscription callback error:',
              error
            );
          }
        }
      }
    }
  }

  /**
   * Send a request to the worker and wait for a response.
   */
  private async request<T>(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    const worker = this.getWorker();
    const id = this.generateMessageId();

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const request: AnyWorkerRequest = {
        id,
        type,
        ...payload,
      } as AnyWorkerRequest;

      worker.postMessage(request);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, 30000);
    });
  }

  /**
   * Run a workflow and wait for completion.
   * This is the primary method used by transformed workflow functions.
   *
   * @param workflowId - The workflow identifier
   * @param args - Arguments to pass to the workflow
   * @returns The workflow result
   */
  async run(workflowId: string, args: unknown[]): Promise<unknown> {
    const { runId } = await this.trigger(workflowId, args);
    return this.waitForCompletion(runId);
  }

  /**
   * Trigger a workflow without waiting for completion.
   *
   * @param workflowId - The workflow identifier
   * @param args - Arguments to pass to the workflow
   * @returns The run ID
   */
  async trigger(workflowId: string, args: unknown[]): Promise<TriggerResponse> {
    return this.request<TriggerResponse>('TRIGGER', { workflowId, args });
  }

  /**
   * Wait for a workflow run to complete.
   *
   * @param runId - The run ID to wait for
   * @returns The workflow result
   */
  async waitForCompletion(runId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe(runId, (event) => {
        if (event.type === 'RUN_COMPLETED') {
          unsubscribe();
          resolve(event.run.output);
        } else if (event.type === 'RUN_FAILED') {
          unsubscribe();
          reject(new Error(event.error));
        }
      });

      // Also check current status in case it's already complete
      this.getStatus(runId)
        .then((run) => {
          if (run.status === 'completed') {
            unsubscribe();
            resolve(run.output);
          } else if (run.status === 'failed') {
            unsubscribe();
            reject(new Error(run.error?.message ?? 'Workflow failed'));
          }
        })
        .catch(reject);
    });
  }

  /**
   * Get the status of a workflow run.
   *
   * @param runId - The run ID
   * @returns The workflow run record
   */
  async getStatus(runId: string): Promise<WorkflowRun> {
    return this.request<WorkflowRun>('GET_STATUS', { runId });
  }

  /**
   * List workflow runs.
   *
   * @param params - List parameters
   * @returns Paginated list of runs
   */
  async listRuns(params?: {
    workflowName?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListRunsResponse> {
    return this.request<ListRunsResponse>('LIST_RUNS', params ?? {});
  }

  /**
   * Cancel a workflow run.
   *
   * @param runId - The run ID to cancel
   * @returns The updated run record
   */
  async cancel(runId: string): Promise<WorkflowRun> {
    return this.request<WorkflowRun>('CANCEL', { runId });
  }

  /**
   * Pause a workflow run.
   *
   * @param runId - The run ID to pause
   * @returns The updated run record
   */
  async pause(runId: string): Promise<WorkflowRun> {
    return this.request<WorkflowRun>('PAUSE', { runId });
  }

  /**
   * Resume a paused workflow run.
   *
   * @param runId - The run ID to resume
   * @returns The updated run record
   */
  async resume(runId: string): Promise<WorkflowRun> {
    return this.request<WorkflowRun>('RESUME', { runId });
  }

  /**
   * Get steps for a workflow run.
   *
   * @param runId - The run ID
   * @returns Paginated list of steps
   */
  async getSteps(runId: string): Promise<GetStepsResponse> {
    return this.request<GetStepsResponse>('GET_STEPS', { runId });
  }

  /**
   * Get events for a workflow run.
   *
   * @param runId - The run ID
   * @returns Paginated list of events
   */
  async getEvents(runId: string): Promise<GetEventsResponse> {
    return this.request<GetEventsResponse>('GET_EVENTS', { runId });
  }

  /**
   * Subscribe to updates for a workflow run.
   *
   * @param runId - The run ID to subscribe to
   * @param callback - Callback for updates
   * @returns Unsubscribe function
   */
  subscribe(runId: string, callback: WorkflowSubscriptionCallback): () => void {
    if (!this.subscriptions.has(runId)) {
      this.subscriptions.set(runId, new Set());
      // Tell the worker we're subscribing
      this.request('SUBSCRIBE', { runId }).catch(console.error);
    }

    this.subscriptions.get(runId)!.add(callback);

    return () => {
      const callbacks = this.subscriptions.get(runId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscriptions.delete(runId);
          // Tell the worker we're unsubscribing
          this.request('UNSUBSCRIBE', { runId }).catch(console.error);
        }
      }
    };
  }

  /**
   * Check if the client is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Disconnect from the worker.
   */
  disconnect(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
    this.pending.clear();
    this.subscriptions.clear();
  }
}

/**
 * Default client instance.
 * This is used by transformed workflow functions.
 */
export const __browserWorkflowClient = new BrowserWorkflowClient();
