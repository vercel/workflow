import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createWorld as createPostgresWorld } from '@workflow/world-postgres';
import { setWorld } from 'workflow/runtime';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // Explicitly construct the Postgres World when configured so it is
  // statically bundled; ensureWorldStarted() below picks it up and starts it.
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    setWorld(await createPostgresWorld());
  }

  // Start the World once at server boot so in-flight runs are recovered after a
  // restart without needing a workflow operation. No-op on the Vercel World;
  // runs recovery for the local/postgres worlds. NestJS exposes no build-time
  // dev/prod flag, so derive `dev` from NODE_ENV explicitly: in dev, previous
  // in-flight runs are cancelled rather than recovered (their workflow code may
  // have changed); in production they are recovered. Ensure NODE_ENV is set.
  const { ensureWorldStarted } = await import('workflow/runtime');
  await ensureWorldStarted({ dev: process.env.NODE_ENV !== 'production' });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Configure body parsing similar to express workbench
  // Use dynamic import to work around ESM issues
  const { default: expressModule } = await import('express');
  app.use(expressModule.json());
  app.use(expressModule.text({ type: 'text/*' }));
  app.use(expressModule.raw({ type: 'application/octet-stream' }));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
