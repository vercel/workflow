import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { AWSWorldConfig } from './config.js';

interface StreamChunk {
  streamId: string;
  chunkId: string;
  s3Key: string;
  eof: boolean;
  createdAt: string;
}

export function createStreamer(
  s3Client: S3Client,
  dynamoClient: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Streamer {
  const ulid = monotonicFactory();
  const tableName = config.tables.streams;
  const bucketName = config.streamBucket;

  const genChunkId = () => `chnk_${ulid()}` as const;

  return {
    async writeToStream(
      name: string,
      chunk: string | Uint8Array
    ): Promise<void> {
      const chunkId = genChunkId();
      const s3Key = `${name}/${chunkId}`;

      // Upload chunk data to S3
      const buffer =
        typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: buffer,
          ContentType: 'application/octet-stream',
        })
      );

      // Store metadata in DynamoDB
      const streamChunk: StreamChunk = {
        streamId: name,
        chunkId,
        s3Key,
        eof: false,
        createdAt: new Date().toISOString(),
      };

      await dynamoClient.send(
        new PutCommand({
          TableName: tableName,
          Item: streamChunk,
        })
      );
    },

    async closeStream(name: string): Promise<void> {
      const chunkId = genChunkId();
      const s3Key = `${name}/${chunkId}`;

      // Upload empty chunk to mark EOF
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: Buffer.from([]),
          ContentType: 'application/octet-stream',
        })
      );

      // Store EOF marker in DynamoDB
      const streamChunk: StreamChunk = {
        streamId: name,
        chunkId,
        s3Key,
        eof: true,
        createdAt: new Date().toISOString(),
      };

      await dynamoClient.send(
        new PutCommand({
          TableName: tableName,
          Item: streamChunk,
        })
      );
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let offset = startIndex ?? 0;
          let hasMore = true;
          let lastEvaluatedKey: Record<string, any> | undefined;

          while (hasMore) {
            // Query DynamoDB for chunks
            const result = await dynamoClient.send(
              new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: 'streamId = :streamId',
                ExpressionAttributeValues: {
                  ':streamId': name,
                },
                ExclusiveStartKey: lastEvaluatedKey,
                ScanIndexForward: true, // Sort by chunkId ascending
              })
            );

            if (!result.Items || result.Items.length === 0) {
              // No more chunks yet - in a real implementation, you might want to poll
              break;
            }

            for (const item of result.Items as StreamChunk[]) {
              if (offset > 0) {
                offset--;
                continue;
              }

              // Fetch chunk data from S3
              try {
                const s3Response = await s3Client.send(
                  new GetObjectCommand({
                    Bucket: bucketName,
                    Key: item.s3Key,
                  })
                );

                if (s3Response.Body) {
                  const bytes = await s3Response.Body.transformToByteArray();
                  if (bytes.length > 0) {
                    controller.enqueue(bytes);
                  }
                }

                if (item.eof) {
                  controller.close();
                  return;
                }
              } catch (error) {
                console.error(`Error reading chunk ${item.chunkId}:`, error);
                controller.error(error);
                return;
              }
            }

            lastEvaluatedKey = result.LastEvaluatedKey;
            hasMore = !!lastEvaluatedKey;
          }

          // If we get here and haven't closed, check if we should wait for more data
          // In a production implementation, you'd want to implement polling or websocket updates
          controller.close();
        },
      });
    },
  };
}
