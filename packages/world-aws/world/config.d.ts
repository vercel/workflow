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
export declare function getDefaultConfig(): AWSWorldConfig;
