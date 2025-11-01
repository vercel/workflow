export interface AWSWorldConfig {
  region: string;
  tables: {
    runs: string;
    steps: string;
    events: string;
    hooks: string;
    streams: string;
  };
  queues: {
    workflow: string;
    step: string;
  };
  streamBucket: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export function getDefaultConfig(): AWSWorldConfig {
  // Debug: Log environment variable presence
  console.log('🔍 Environment check:', {
    hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION || process.env.WORKFLOW_AWS_REGION,
  });

  const config = {
    region:
      process.env.AWS_REGION || process.env.WORKFLOW_AWS_REGION || 'us-east-1',
    tables: {
      runs: process.env.WORKFLOW_AWS_RUNS_TABLE || 'workflow_runs',
      steps: process.env.WORKFLOW_AWS_STEPS_TABLE || 'workflow_steps',
      events: process.env.WORKFLOW_AWS_EVENTS_TABLE || 'workflow_events',
      hooks: process.env.WORKFLOW_AWS_HOOKS_TABLE || 'workflow_hooks',
      streams:
        process.env.WORKFLOW_AWS_STREAMS_TABLE || 'workflow_stream_chunks',
    },
    queues: {
      workflow: process.env.WORKFLOW_AWS_WORKFLOW_QUEUE_URL!,
      step: process.env.WORKFLOW_AWS_STEP_QUEUE_URL!,
    },
    streamBucket: process.env.WORKFLOW_AWS_STREAM_BUCKET!,
    // CRITICAL: In Lambda, AWS credentials are auto-provided BUT we should NOT pass them explicitly
    // The AWS SDK will automatically use the Lambda execution role if we don't provide credentials
    credentials: undefined, // Always use Lambda's IAM role, never explicit credentials
  };

  // Debug logging
  console.log('🔍 AWS World Config:');
  console.log(`   Workflow Queue: ${config.queues.workflow || '❌ MISSING'}`);
  console.log(`   Step Queue: ${config.queues.step || '❌ MISSING'}`);
  console.log(`   Stream Bucket: ${config.streamBucket || '❌ MISSING'}`);

  return config;
}
