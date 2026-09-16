import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // The self-hosted World's workers are started and stopped by WorkflowModule's
  // `manageWorldLifecycle` option (see app.module.ts), so there is no World
  // bootstrap here.

  // rawBody keeps the bytes a webhook sender signed. Nest's own json parser
  // captures them; the extra middleware below covers the content types Nest
  // does not parse.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Configure body parsing similar to express workbench
  // Use dynamic import to work around ESM issues
  const { default: expressModule } = await import('express');
  app.use(expressModule.text({ type: 'text/*' }));
  app.use(expressModule.raw({ type: 'application/octet-stream' }));

  // Required for WorkflowModule's onApplicationShutdown to run on SIGTERM, which
  // is what closes the World's workers.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
