import type { Server } from 'node:http';

export function startServer(port?: number): Promise<Server>;
