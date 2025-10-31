'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createWorld = void 0;
const client_dynamodb_1 = require('@aws-sdk/client-dynamodb');
const client_s3_1 = require('@aws-sdk/client-s3');
const client_sqs_1 = require('@aws-sdk/client-sqs');
const lib_dynamodb_1 = require('@aws-sdk/lib-dynamodb');
const config_js_1 = require('./config.js');
const queue_js_1 = require('./queue.js');
const storage_js_1 = require('./storage.js');
const streamer_js_1 = require('./streamer.js');
function createWorld(config = {}) {
  const fullConfig = {
    ...(0, config_js_1.getDefaultConfig)(),
    ...config,
  };
  // Create AWS SDK clients
  const clientConfig = {
    region: fullConfig.region,
    credentials: fullConfig.credentials,
  };
  const dynamoClient = new client_dynamodb_1.DynamoDBClient(clientConfig);
  const dynamoDocClient =
    lib_dynamodb_1.DynamoDBDocumentClient.from(dynamoClient);
  const sqsClient = new client_sqs_1.SQSClient(clientConfig);
  const s3Client = new client_s3_1.S3Client(clientConfig);
  // Create world components
  const storage = (0, storage_js_1.createStorage)(dynamoDocClient, fullConfig);
  const queue = (0, queue_js_1.createQueue)(sqsClient, fullConfig);
  const streamer = (0, streamer_js_1.createStreamer)(
    s3Client,
    dynamoDocClient,
    fullConfig
  );
  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queue.start();
    },
    async getAuthInfo() {
      return {
        ownerId: 'aws',
        projectId: fullConfig.region,
        environment: 'production',
      };
    },
    async checkHealth() {
      return {
        success: true,
        data: { healthy: true },
        message: 'OK',
      };
    },
  };
}
exports.createWorld = createWorld;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSw4REFBMEQ7QUFDMUQsa0RBQThDO0FBQzlDLG9EQUFnRDtBQUNoRCx3REFBK0Q7QUFFL0QsMkNBQW9FO0FBQ3BFLHlDQUF5QztBQUN6Qyw2Q0FBNkM7QUFDN0MsK0NBQStDO0FBSS9DLFNBQWdCLFdBQVcsQ0FDekIsU0FBa0MsRUFBRTtJQUVwQyxNQUFNLFVBQVUsR0FBbUI7UUFDakMsR0FBRyxJQUFBLDRCQUFnQixHQUFFO1FBQ3JCLEdBQUcsTUFBTTtLQUNWLENBQUM7SUFFRix5QkFBeUI7SUFDekIsTUFBTSxZQUFZLEdBQUc7UUFDbkIsTUFBTSxFQUFFLFVBQVUsQ0FBQyxNQUFNO1FBQ3pCLFdBQVcsRUFBRSxVQUFVLENBQUMsV0FBVztLQUNwQyxDQUFDO0lBRUYsTUFBTSxZQUFZLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ3RELE1BQU0sZUFBZSxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUNsRSxNQUFNLFNBQVMsR0FBRyxJQUFJLHNCQUFTLENBQUMsWUFBWSxDQUFDLENBQUM7SUFDOUMsTUFBTSxRQUFRLEdBQUcsSUFBSSxvQkFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBRTVDLDBCQUEwQjtJQUMxQixNQUFNLE9BQU8sR0FBRyxJQUFBLDBCQUFhLEVBQUMsZUFBZSxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQzNELE1BQU0sS0FBSyxHQUFHLElBQUEsc0JBQVcsRUFBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLENBQUM7SUFDakQsTUFBTSxRQUFRLEdBQUcsSUFBQSw0QkFBYyxFQUFDLFFBQVEsRUFBRSxlQUFlLEVBQUUsVUFBVSxDQUFDLENBQUM7SUFFdkUsT0FBTztRQUNMLEdBQUcsT0FBTztRQUNWLEdBQUcsUUFBUTtRQUNYLEdBQUcsS0FBSztRQUNSLEtBQUssQ0FBQyxLQUFLO1lBQ1QsTUFBTSxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDdEIsQ0FBQztRQUNELEtBQUssQ0FBQyxXQUFXO1lBQ2YsT0FBTztnQkFDTCxPQUFPLEVBQUUsS0FBSztnQkFDZCxTQUFTLEVBQUUsVUFBVSxDQUFDLE1BQU07Z0JBQzVCLFdBQVcsRUFBRSxZQUFZO2FBQzFCLENBQUM7UUFDSixDQUFDO1FBQ0QsS0FBSyxDQUFDLFdBQVc7WUFDZixPQUFPO2dCQUNMLE9BQU8sRUFBRSxJQUFJO2dCQUNiLElBQUksRUFBRSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUU7Z0JBQ3ZCLE9BQU8sRUFBRSxJQUFJO2FBQ2QsQ0FBQztRQUNKLENBQUM7S0FDRixDQUFDO0FBQ0osQ0FBQztBQTlDRCxrQ0E4Q0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBTM0NsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zMyc7XG5pbXBvcnQgeyBTUVNDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc3FzJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHR5cGUgeyBXb3JsZCB9IGZyb20gJ0B3b3JrZmxvdy93b3JsZCc7XG5pbXBvcnQgeyBnZXREZWZhdWx0Q29uZmlnLCB0eXBlIEFXU1dvcmxkQ29uZmlnIH0gZnJvbSAnLi9jb25maWcuanMnO1xuaW1wb3J0IHsgY3JlYXRlUXVldWUgfSBmcm9tICcuL3F1ZXVlLmpzJztcbmltcG9ydCB7IGNyZWF0ZVN0b3JhZ2UgfSBmcm9tICcuL3N0b3JhZ2UuanMnO1xuaW1wb3J0IHsgY3JlYXRlU3RyZWFtZXIgfSBmcm9tICcuL3N0cmVhbWVyLmpzJztcblxuZXhwb3J0IHR5cGUgeyBBV1NXb3JsZENvbmZpZyB9IGZyb20gJy4vY29uZmlnLmpzJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdvcmxkKFxuICBjb25maWc6IFBhcnRpYWw8QVdTV29ybGRDb25maWc+ID0ge31cbik6IFdvcmxkICYgeyBzdGFydCgpOiBQcm9taXNlPHZvaWQ+IH0ge1xuICBjb25zdCBmdWxsQ29uZmlnOiBBV1NXb3JsZENvbmZpZyA9IHtcbiAgICAuLi5nZXREZWZhdWx0Q29uZmlnKCksXG4gICAgLi4uY29uZmlnLFxuICB9O1xuXG4gIC8vIENyZWF0ZSBBV1MgU0RLIGNsaWVudHNcbiAgY29uc3QgY2xpZW50Q29uZmlnID0ge1xuICAgIHJlZ2lvbjogZnVsbENvbmZpZy5yZWdpb24sXG4gICAgY3JlZGVudGlhbHM6IGZ1bGxDb25maWcuY3JlZGVudGlhbHMsXG4gIH07XG5cbiAgY29uc3QgZHluYW1vQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KGNsaWVudENvbmZpZyk7XG4gIGNvbnN0IGR5bmFtb0RvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkeW5hbW9DbGllbnQpO1xuICBjb25zdCBzcXNDbGllbnQgPSBuZXcgU1FTQ2xpZW50KGNsaWVudENvbmZpZyk7XG4gIGNvbnN0IHMzQ2xpZW50ID0gbmV3IFMzQ2xpZW50KGNsaWVudENvbmZpZyk7XG5cbiAgLy8gQ3JlYXRlIHdvcmxkIGNvbXBvbmVudHNcbiAgY29uc3Qgc3RvcmFnZSA9IGNyZWF0ZVN0b3JhZ2UoZHluYW1vRG9jQ2xpZW50LCBmdWxsQ29uZmlnKTtcbiAgY29uc3QgcXVldWUgPSBjcmVhdGVRdWV1ZShzcXNDbGllbnQsIGZ1bGxDb25maWcpO1xuICBjb25zdCBzdHJlYW1lciA9IGNyZWF0ZVN0cmVhbWVyKHMzQ2xpZW50LCBkeW5hbW9Eb2NDbGllbnQsIGZ1bGxDb25maWcpO1xuXG4gIHJldHVybiB7XG4gICAgLi4uc3RvcmFnZSxcbiAgICAuLi5zdHJlYW1lcixcbiAgICAuLi5xdWV1ZSxcbiAgICBhc3luYyBzdGFydCgpIHtcbiAgICAgIGF3YWl0IHF1ZXVlLnN0YXJ0KCk7XG4gICAgfSxcbiAgICBhc3luYyBnZXRBdXRoSW5mbygpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG93bmVySWQ6ICdhd3MnLFxuICAgICAgICBwcm9qZWN0SWQ6IGZ1bGxDb25maWcucmVnaW9uLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfTtcbiAgICB9LFxuICAgIGFzeW5jIGNoZWNrSGVhbHRoKCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgZGF0YTogeyBoZWFsdGh5OiB0cnVlIH0sXG4gICAgICAgIG1lc3NhZ2U6ICdPSycsXG4gICAgICB9O1xuICAgIH0sXG4gIH07XG59XG4iXX0=
