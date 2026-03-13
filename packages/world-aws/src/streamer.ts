import { EventEmitter } from 'node:events';
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { tableNames } from './config.js';

interface StreamChunkEvent {
  id: `chnk_${string}`;
  data: Uint8Array;
  eof: boolean;
}

export type AwsStreamer = Streamer & {
  close(): Promise<void>;
};

/**
 * Streamer implementation backed by DynamoDB.
 *
 * Stream chunks are stored in a DynamoDB table with composite key (streamId, chunkId).
 * ULID-based chunkIds maintain ordering across process boundaries.
 *
 * For real-time streaming, we use a polling approach rather than DynamoDB Streams,
 * since the latter requires additional IAM permissions and Lambda configuration.
 * For most workflow use cases, the slight latency from polling is acceptable.
 */
export function createStreamer(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>
): AwsStreamer {
  const ulid = monotonicFactory();
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const genChunkId = () => `chnk_${ulid()}` as const;

  // Polling for active stream readers
  let pollActive = true;
  const activeStreams = new Map<
    string,
    { lastChunkId: string; interval: ReturnType<typeof setInterval> }
  >();

  function startStreamPoll(streamId: string) {
    if (activeStreams.has(streamId)) return;

    const state = {
      lastChunkId: '',
      interval: setInterval(async () => {
        if (!pollActive) return;

        const key = `strm:${streamId}` as const;
        if (!events.listenerCount(key)) {
          // No listeners, clean up
          clearInterval(state.interval);
          activeStreams.delete(streamId);
          return;
        }

        try {
          // Query for new chunks since last seen
          const queryParams: any = {
            TableName: tables.streams,
            KeyConditionExpression: state.lastChunkId
              ? 'streamId = :sid AND chunkId > :lastId'
              : 'streamId = :sid',
            ExpressionAttributeValues: state.lastChunkId
              ? marshall({
                  ':sid': streamId,
                  ':lastId': state.lastChunkId,
                })
              : marshall({ ':sid': streamId }),
            ScanIndexForward: true,
          };

          const result = await dynamo.send(new QueryCommand(queryParams));
          if (result.Items?.length) {
            for (const rawItem of result.Items) {
              const item = unmarshall(rawItem);
              const chunk: StreamChunkEvent = {
                id: item.chunkId as `chnk_${string}`,
                data: item.chunkData
                  ? new Uint8Array(item.chunkData)
                  : new Uint8Array(0),
                eof: item.eof ?? false,
              };
              state.lastChunkId = item.chunkId;
              events.emit(key, chunk);

              if (chunk.eof) {
                clearInterval(state.interval);
                activeStreams.delete(streamId);
                return;
              }
            }
          }
        } catch {
          // Ignore polling errors
        }
      }, 500),
    };
    activeStreams.set(streamId, state);
  }

  const toBuffer = (chunk: string | Uint8Array): Uint8Array =>
    typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      const runId = await _runId;
      const chunkId = genChunkId();
      await dynamo.send(
        new PutItemCommand({
          TableName: tables.streams,
          Item: marshall(
            {
              streamId: name,
              chunkId,
              runId,
              chunkData: toBuffer(chunk),
              eof: false,
              createdAt: new Date().toISOString(),
            },
            { removeUndefinedValues: true }
          ),
        })
      );
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ) {
      if (chunks.length === 0) return;

      const chunkIds = chunks.map(() => genChunkId());
      const runId = await _runId;

      // Write chunks sequentially to maintain order
      for (let i = 0; i < chunks.length; i++) {
        await dynamo.send(
          new PutItemCommand({
            TableName: tables.streams,
            Item: marshall(
              {
                streamId: name,
                chunkId: chunkIds[i],
                runId,
                chunkData: toBuffer(chunks[i]),
                eof: false,
                createdAt: new Date().toISOString(),
              },
              { removeUndefinedValues: true }
            ),
          })
        );
      }
    },

    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      const runId = await _runId;
      const chunkId = genChunkId();
      await dynamo.send(
        new PutItemCommand({
          TableName: tables.streams,
          Item: marshall(
            {
              streamId: name,
              chunkId,
              runId,
              chunkData: new Uint8Array(0),
              eof: true,
              createdAt: new Date().toISOString(),
            },
            { removeUndefinedValues: true }
          ),
        })
      );
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      const cleanups: (() => void)[] = [];

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let lastChunkId = '';
          let offset = startIndex ?? 0;
          let buffer = [] as StreamChunkEvent[] | null;

          function enqueue(msg: {
            id: string;
            data: Uint8Array;
            eof: boolean;
          }) {
            if (lastChunkId >= msg.id) {
              return;
            }

            if (offset > 0) {
              offset--;
              return;
            }

            if (msg.data.byteLength) {
              controller.enqueue(new Uint8Array(msg.data));
            }
            if (msg.eof) {
              controller.close();
            }
            lastChunkId = msg.id;
          }

          function onData(data: StreamChunkEvent) {
            if (buffer) {
              buffer.push(data);
              return;
            }
            enqueue(data);
          }
          events.on(`strm:${name}`, onData);
          cleanups.push(() => {
            events.off(`strm:${name}`, onData);
          });

          // Start polling for this stream
          startStreamPoll(name);

          // Load existing chunks
          const result = await dynamo.send(
            new QueryCommand({
              TableName: tables.streams,
              KeyConditionExpression: 'streamId = :sid',
              ExpressionAttributeValues: marshall({ ':sid': name }),
              ScanIndexForward: true,
            })
          );

          const chunks = (result.Items ?? []).map((rawItem) => {
            const item = unmarshall(rawItem);
            return {
              id: item.chunkId as `chnk_${string}`,
              data: item.chunkData
                ? new Uint8Array(item.chunkData)
                : new Uint8Array(0),
              eof: item.eof ?? false,
            };
          });

          for (const chunk of [...chunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }
          buffer = null;
        },
        cancel() {
          cleanups.forEach((fn) => fn());
        },
      });
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: tables.streams,
          IndexName: 'gsi_runId',
          KeyConditionExpression: 'runId = :runId',
          ExpressionAttributeValues: marshall({ ':runId': runId }),
          ProjectionExpression: 'streamId',
        })
      );

      const streamIds = new Set<string>();
      for (const rawItem of result.Items ?? []) {
        const item = unmarshall(rawItem);
        streamIds.add(item.streamId);
      }
      return [...streamIds];
    },

    async close() {
      pollActive = false;
      for (const [, state] of activeStreams) {
        clearInterval(state.interval);
      }
      activeStreams.clear();
    },
  };
}
