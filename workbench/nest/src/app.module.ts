import { Module } from '@nestjs/common';
import { WorkflowModule } from 'workflow/nest';
import { AppController } from './app.controller.js';

@Module({
  imports: [
    // `skipBuild` needs no VERCEL branch: it defaults to true there, because the
    // Build Output already carries the bundles and the filesystem is read-only.
    WorkflowModule.forRoot({
      // Postgres is self-hosted, so its pollers have to be started with the app
      // and closed on shutdown or runs are created and never picked up. This
      // replaces the manual getWorld().start() that used to live in main.ts.
      manageWorldLifecycle:
        process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres',
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
