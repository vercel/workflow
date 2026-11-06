import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type express from 'express';
// Compiled by `nest build` before the Vercel Build Output step runs.
import { AppModule } from '../dist/app.module.js';

let ready: Promise<express.Express> | undefined;

async function createHandler(): Promise<express.Express> {
  // Nest's default body parsing is left in place: on Vercel the workflow
  // routes are served by their own Build Output functions, so this function
  // only ever sees the application's own routes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  await app.init();
  return app.getHttpAdapter().getInstance();
}

export default async function handler(
  req: express.Request,
  res: express.Response
) {
  ready ??= createHandler();
  return (await ready)(req, res);
}
