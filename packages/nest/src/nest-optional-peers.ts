import { createRequire } from 'node:module';
import { join } from 'pathe';

/**
 * Packages NestJS `require()`s lazily, behind try/catch, through its internal
 * `loadPackage` helper. They are only reachable when the app actually uses the
 * feature that needs them (`ValidationPipe` needs `class-validator`, the
 * microservices transports need their client library, and so on).
 *
 * esbuild has no way to know that, so it follows the `require()` and fails the
 * build when the package is absent. Marking an absent package external leaves
 * the bare `require()` in place, which is exactly what NestJS's try/catch is
 * written to tolerate.
 */
export const NEST_OPTIONAL_PEERS = [
  '@nestjs/websockets',
  '@nestjs/microservices',
  '@nestjs/platform-fastify',
  '@nestjs/platform-socket.io',
  'class-validator',
  'class-transformer',
  'cache-manager',
  '@fastify/static',
  '@grpc/grpc-js',
  '@grpc/proto-loader',
  'kafkajs',
  'mqtt',
  'nats',
  'amqplib',
  'amqp-connection-manager',
  'ioredis',
] as const;

/**
 * Resolve the optional NestJS peers that are NOT installed in `workingDir`.
 *
 * An installed peer is one the app opted into, so it must be bundled into a
 * self-contained function rather than left as a bare `require()` that cannot
 * resolve once deployed. Only the uninstalled ones are externalized.
 *
 * Returns both the bare specifier and its `/*` subpath form so deep imports
 * (`@nestjs/microservices/decorators`) are covered too.
 */
export function resolveAbsentNestPeers(workingDir: string): string[] {
  const require = createRequire(join(workingDir, 'package.json'));
  const absent: string[] = [];
  for (const pkg of NEST_OPTIONAL_PEERS) {
    try {
      require.resolve(pkg);
    } catch {
      absent.push(pkg, `${pkg}/*`);
    }
  }
  return absent;
}
