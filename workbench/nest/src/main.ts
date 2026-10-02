import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // The self-hosted World's workers are started and stopped by WorkflowModule's
  // `manageWorldLifecycle` option (see app.module.ts), so there is no World
  // bootstrap here.
  //
  // No body-parser configuration either. WorkflowModule keeps the application's
  // parsers away from `.well-known/workflow/v1`, so a queue delivery is not
  // capped at Express's 100 KB limit and a signed webhook body reaches the
  // workflow byte-for-byte without `{ rawBody: true }`. The app's own routes
  // keep Nest's defaults.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Required for WorkflowModule's onApplicationShutdown to run on SIGTERM, which
  // is what closes the World's workers.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
