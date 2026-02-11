import 'react-router';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '@react-router/express';
import express from 'express';

export const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '../build');

// Serve immutable assets with long-lived cache
app.use(
  '/assets',
  express.static(path.join(buildDir, 'client/assets'), {
    immutable: true,
    maxAge: '1y',
  })
);

// Serve static client files with short cache
app.use(express.static(path.join(buildDir, 'client'), { maxAge: '1h' }));

// Handle all requests with React Router
app.all(
  '*',
  createRequestHandler({
    build: () => import('virtual:react-router/server-build'),
  })
);
