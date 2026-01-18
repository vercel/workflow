/**
 * Global type declarations for documentation code samples.
 * These provide liberal types for placeholder functions and variables
 * commonly used in documentation examples.
 *
 * Wrapped in `declare global` to ensure these are available globally
 * even when moduleDetection is set to "force" (for top-level await support).
 */

export {};

declare global {
  // Node.js globals
  const process: {
    env: Record<string, string | undefined>;
    [key: string]: any;
  };
  const Buffer: {
    from(data: any, encoding?: string): any;
    [key: string]: any;
  };
  const require: {
    (module: string): any;
    resolve(module: string): string;
    [key: string]: any;
  };

  // JSX intrinsic elements (for React examples)
  namespace JSX {
    interface IntrinsicElements {
      div: any;
      form: any;
      strong: any;
      span: any;
      button: any;
      input: any;
      label: any;
      p: any;
      h1: any;
      h2: any;
      h3: any;
      [elemName: string]: any;
    }
  }

  // Placeholder step functions - all accept any args and return Promise<any>
  function fetchOrder(...args: any[]): Promise<any>;
  function fetchOrders(...args: any[]): Promise<any>;
  function fetchUser(...args: any[]): Promise<any>;
  function fetchUserData(...args: any[]): Promise<any>;
  function fetchPreferences(...args: any[]): Promise<any>;
  function createUser(...args: any[]): Promise<any>;
  function sendWelcomeEmail(...args: any[]): Promise<any>;
  function sendOnboardingEmail(...args: any[]): Promise<any>;
  function sendBirthdayCard(...args: any[]): Promise<any>;
  function sendRSVPEmail(...args: any[]): Promise<any>;
  function sendHumanApprovalEmail(...args: any[]): Promise<any>;
  function chargePayment(...args: any[]): Promise<any>;
  function processData(...args: any[]): Promise<any>;
  function processMessage(...args: any[]): Promise<any>;
  function executeExternalTask(...args: any[]): Promise<any>;
  function greetStep(...args: any[]): Promise<any>;
  function makeCardImage(...args: any[]): Promise<any>;
  function makeCardText(...args: any[]): Promise<any>;
  function transform(...args: any[]): any;
  function follow(...args: any[]): Promise<any>;

  // Streaming helpers
  function startStream(...args: any[]): Promise<void>;
  function endStream(...args: any[]): Promise<void>;
  function streamTextStep(...args: any[]): Promise<{
    messages: any[];
    finishReason: string;
    [key: string]: any;
  }>;

  // Polling/status helpers
  function checkJobStatus(jobId: string): Promise<{
    status: string;
    data: any;
    [key: string]: any;
  }>;

  // Placeholder types
  type Order = {
    id: string;
    status: string;
    [key: string]: any;
  };
  type SlackMessage = {
    channel: string;
    text: string;
    [key: string]: any;
  };
  type StepResult = any;

  class BaseBuilder {
    constructor(options: any);
    build(): Promise<void>;
    getInputFiles(): Promise<string[]>;
    createWorkflowsBundle(...args: any[]): Promise<any>;
    createStepsBundle(...args: any[]): Promise<any>;
    createWebhookBundle(...args: any[]): Promise<any>;
  }

  // External service mocks
  const Stripe: new (key: string) => any;
  const stripe: {
    paymentIntents: { create: (data: any) => Promise<any> };
    [key: string]: any;
  };
  const ups: {
    track: (id: string) => Promise<any>;
    [key: string]: any;
  };
  const gateway: any;

  // AI SDK types that may not be exported
  type UIMessage = {
    role: string;
    content: string;
    [key: string]: any;
  };
  type LanguageModelV2 = any;
  type LanguageModelV2Prompt = any;
  function convertToModelMessages(messages: any[]): any[];
  function createUIMessageStreamResponse(options: any): Response;

  // Workflow-specific placeholders
  // These are user-defined instances (result of defineHook<...>()) with proper return types
  const approvalHook: {
    create(options?: any): Promise<any> & { token: string };
    resume(
      token: string,
      data?: any
    ): Promise<{
      runId: string;
      hookId: string;
      token: string;
      ownerId: string;
      projectId: string;
      environment: string;
      createdAt: Date;
      [key: string]: any;
    }>;
  };
  const chatMessageHook: typeof approvalHook;
  const writable: WritableStream<any>;

  // Form/component props commonly used in React examples
  const input: string;
  const setInput: (value: string) => void;
  const data: any;
  const value: any;
  const className: string;
  const key: string | number;
  const placeholder: string;
  const onSubmit: (e: any) => void;
  const onChange: (e: any) => void;
  const e: any;

  // Constants used in examples
  const FLIGHT_ASSISTANT_PROMPT: string;
  const flightBookingTools: any;
  const MAX_STEPS: number;
  const reportId: string;
  const userId: string;
}
